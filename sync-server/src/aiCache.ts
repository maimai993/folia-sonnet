import { Hono } from 'hono';
import { requireAdmin } from './admin.js';
import type { D1Database, Env } from './app.js';
import { readHighlightWords, verifyStageUpload } from './stageVerifier.js';
import { validateStagePayload } from './stagePayload.js';
import { bodyLimit } from 'hono/body-limit';
import { stageWriteRateLimit } from './aiStage.js';

// src/aiCache.ts
// The AI cloud cache: a shared shelf of "this lyric file already got an answer".
//
// The key is the MD5 of the lyric file the app would otherwise send to the
// model, so two people playing the same lyrics land on the same entry — the
// second one never pays for a generation. Pulling is deliberately open: a user
// who has not filled in an API key still gets a hit, which is the whole point
// of shipping the switch on by default.
//
// Pulling stays keyed by MD5 alone, even though pushing now carries a platform
// name: an entry written before that field existed must still be reachable.
//
// Only the payload is stored. No prompt, no lyric text, no credential.

const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_TITLE_CHARS = 200;
const MAX_LIST_LIMIT = 500;
const DEFAULT_LIST_LIMIT = 200;
const MAX_PLATFORM_CHARS = 64;
/** 同一个键最多留几份旧版：够把被盖掉的那条捞回来，又不至于无限长。 */
export const MAX_CACHE_BACKUPS = 10;

const KIND_PATTERN = /^[a-z0-9_-]{1,32}$/;
const KEY_PATTERN = /^[a-f0-9]{32}$/;

/*
 * 只有一种条目：stage = 「这段歌词对应的主题 + 歌词动画」。
 *
 * 客户端合并成一次请求之后，服务端也就只留一种。表面上 `kind` 还在 URL 里，
 * 是为了以后再加别的缓存时不用改路由和表结构。
 */
export type AiCacheKind = 'stage';

export interface AiCacheEntry {
  kind: string;
  key: string;
  payload: unknown;
  songTitle: string;
  provider: string;
  model: string;
  /** 这首歌来自哪个音乐平台。老条目没有这一列，读出来是空串。 */
  platform: string;
  payloadBytes: number;
  hits: number;
  createdAt: string;
  updatedAt: string;
}

type AiCacheRow = {
  kind: string;
  cache_key: string;
  payload_json: string;
  payload_bytes: number;
  song_title: string | null;
  provider: string | null;
  model: string | null;
  platform: string | null;
  hits: number;
  created_at: string;
  updated_at: string;
};

type AiCacheBackupRow = {
  id: number;
  kind: string;
  cache_key: string;
  payload_json: string;
  payload_bytes: number;
  song_title: string | null;
  provider: string | null;
  model: string | null;
  platform: string | null;
  hits: number;
  created_at: string;
  archived_at: string;
};

const mapRow = (row: AiCacheRow): AiCacheEntry => {
  let payload: unknown = null;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = null;
  }
  return {
    kind: row.kind,
    key: row.cache_key,
    payload,
    songTitle: row.song_title ?? '',
    provider: row.provider ?? '',
    model: row.model ?? '',
    platform: row.platform ?? '',
    payloadBytes: Number(row.payload_bytes ?? 0),
    hits: Number(row.hits ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

/** 备份表里的一行：够管理员看清是哪一版，也能整版捞回来。 */
const mapBackupRow = (row: AiCacheBackupRow) => {
  let payload: unknown = null;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = null;
  }
  return {
    id: Number(row.id ?? 0),
    kind: row.kind,
    key: row.cache_key,
    payload,
    songTitle: row.song_title ?? '',
    provider: row.provider ?? '',
    model: row.model ?? '',
    platform: row.platform ?? '',
    payloadBytes: Number(row.payload_bytes ?? 0),
    hits: Number(row.hits ?? 0),
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  };
};

const readPayload = (value: unknown): { ok: true; payload: unknown; bytes: number } | { ok: false } => {
  if (value === null || value === undefined) return { ok: false };
  let serialized = '';
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { ok: false };
  }
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (!serialized || bytes > MAX_PAYLOAD_BYTES) return { ok: false };
  return { ok: true, payload: value, bytes };
};

const readMetaText = (value: unknown, limit: number): string => (
  typeof value === 'string' ? value.trim().slice(0, limit) : ''
);

/*
 * 命中流水。
 *
 * `ai_cache.hits` 只是个累加器 —— 它能告诉你「这条被拿过 37 次」，但说不出
 * 是刚才还是上个月。概况图要的是时间分布（最近几分钟多少、几点到几点多少、
 * 最近五条长什么样），所以每次命中另外记一行，只存时间戳与歌名。
 *
 * 只留七天：再久的历史对这个面板没有意义，表却会一直长。清理放在读的时候顺手做，
 * 写路径上就不必为此多一条语句。
 */
const HIT_LOG_RETENTION_DAYS = 7;

export const pruneHitLog = async (db: D1Database): Promise<void> => {
  await db
    .prepare("DELETE FROM ai_cache_hits WHERE at < datetime('now', ?)")
    .bind(`-${HIT_LOG_RETENTION_DAYS} days`)
    .run()
    .catch(() => undefined);
};

/** GET /api/ai-cache/:kind/:key — the pull. Never fails hard; a miss is data. */
const handleGet = async (db: D1Database, kind: string, key: string) => {
  const row = await db
    .prepare('SELECT kind, cache_key, payload_json, payload_bytes, song_title, provider, model, platform, hits, created_at, updated_at FROM ai_cache WHERE kind = ? AND cache_key = ?')
    .bind(kind, key)
    .first<AiCacheRow>();

  if (!row) return { ok: true, hit: false, entry: null };

  await db
    .prepare('UPDATE ai_cache SET hits = hits + 1 WHERE kind = ? AND cache_key = ?')
    .bind(kind, key)
    .run();
  await db
    .prepare('INSERT INTO ai_cache_hits (kind, cache_key, song_title, at) VALUES (?, ?, ?, ?)')
    .bind(kind, key, row.song_title ?? '', new Date().toISOString())
    .run()
    .catch(() => undefined);

  return { ok: true, hit: true, entry: mapRow(row) };
};

/*
 * 覆盖之前把旧的那版存进备份表。
 *
 * 上传是公开的，所以「有人拿一份垃圾把别人做好的那条盖掉」迟早会发生。留着旧版
 * 不只是心里踏实：真被盖了，管理员能把好的那版整条捞回来（/admin/api/ai-cache-backups）。
 *
 * 每个键最多留 MAX_CACHE_BACKUPS 份 —— 够覆盖常见的反复重生成，又不让同一个键无限长。
 */
const archiveExistingEntry = async (db: D1Database, kind: string, key: string): Promise<void> => {
  const row = await db
    .prepare('SELECT kind, cache_key, payload_json, payload_bytes, song_title, provider, model, platform, hits, created_at FROM ai_cache WHERE kind = ? AND cache_key = ?')
    .bind(kind, key)
    .first<AiCacheRow>();
  if (!row) return;

  const now = new Date().toISOString();
  await db
    .prepare(`
      INSERT INTO ai_cache_backups
        (kind, cache_key, payload_json, payload_bytes, song_title, provider, model, platform, hits, created_at, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      row.kind,
      row.cache_key,
      row.payload_json,
      Number(row.payload_bytes ?? 0),
      row.song_title ?? '',
      row.provider ?? '',
      row.model ?? '',
      row.platform ?? '',
      Number(row.hits ?? 0),
      row.created_at ?? now,
      now,
    )
    .run()
    .catch(() => undefined);

  await db
    .prepare(`
      DELETE FROM ai_cache_backups
      WHERE kind = ? AND cache_key = ?
        AND id NOT IN (
          SELECT id FROM ai_cache_backups
          WHERE kind = ? AND cache_key = ?
          ORDER BY archived_at DESC, id DESC
          LIMIT ?
        )
    `)
    .bind(kind, key, kind, key, MAX_CACHE_BACKUPS)
    .run()
    .catch(() => undefined);
};

/*
 * PUT /api/ai-cache/:kind/:key — the push, after a real generation.
 *
 * 公开路径原子补缺，已有内容原样返回；管理员路径才允许替换并留旧版。
 * stage 必须通过完整纯数据契约校验。旧协议的歌词校验保留用于新提交，
 * 通用 /api/ai-stage 则不依赖歌词或平台接口。
 */
const handlePut = async (
  db: D1Database,
  kind: string,
  key: string,
  body: unknown,
  options: { strict: boolean; admin: boolean },
) => {
  const source = (body ?? {}) as {
    payload?: unknown;
    songTitle?: unknown;
    provider?: unknown;
    model?: unknown;
    /** 这首歌来自哪个平台；老客户端没有，那就是空串，走「按顺序试各平台」。 */
    platform?: unknown;
    /** 歌词正文的 MD5。老客户端也没有，那就无从校验、按未验证放行。 */
    lyricHash?: unknown;
    isPureMusic?: unknown;
  };
  const parsed = readPayload(source.payload);
  if (!parsed.ok || (kind === 'stage' && !validateStagePayload(source.payload))) return { ok: false, error: 'invalid_payload', stored: false, note: 'payload 缺失、不完整、不合法或超过 64KB。' };

  const songTitle = readMetaText(source.songTitle, MAX_TITLE_CHARS);
  const platform = readMetaText(source.platform, MAX_PLATFORM_CHARS);
  const lyricHash = readMetaText(source.lyricHash, 64);

  const verification = await verifyStageUpload({
    payload: parsed.payload,
    songTitle,
    platform,
    lyricHash,
    isPureMusic: source.isPureMusic === true,
    strict: options.strict,
  });
  if (!verification.ok) {
    return { ok: false, error: verification.error, stored: false, note: verification.note };
  }

  const now = new Date().toISOString();
  const provider = readMetaText(source.provider, 64);
  const model = readMetaText(source.model, 128);

  // 公开提交只补缺；旧半截条目也保留供管理员确认，避免并发覆盖。
  if (!options.admin) {
    const inserted = await db.prepare(`INSERT INTO ai_cache (kind, cache_key, payload_json, payload_bytes, song_title, provider, model, platform, hits, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?) ON CONFLICT(kind, cache_key) DO NOTHING`)
      .bind(kind, key, JSON.stringify(parsed.payload), parsed.bytes, songTitle, provider, model, platform, now, now).run();
    const current = await db.prepare('SELECT kind, cache_key, payload_json, payload_bytes, song_title, provider, model, platform, hits, created_at, updated_at FROM ai_cache WHERE kind = ? AND cache_key = ?')
      .bind(kind, key).first<AiCacheRow>();
    const writeResult = inserted as { changes?: number; meta?: { changes?: number } };
    return { ok: true, stored: Number(writeResult.meta?.changes ?? writeResult.changes ?? 0) > 0, entry: current ? mapRow(current) : null };
  }
  /* 管理员覆盖前保留旧版。 */
  await archiveExistingEntry(db, kind, key);

  await db
    .prepare(`
      INSERT INTO ai_cache (kind, cache_key, payload_json, payload_bytes, song_title, provider, model, platform, hits, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(kind, cache_key) DO UPDATE SET
        payload_json = excluded.payload_json,
        payload_bytes = excluded.payload_bytes,
        song_title = excluded.song_title,
        provider = excluded.provider,
        model = excluded.model,
        platform = excluded.platform,
        updated_at = excluded.updated_at
    `)
    .bind(kind, key, JSON.stringify(parsed.payload), parsed.bytes, songTitle, provider, model, platform, now, now)
    .run();

  return {
    ok: true,
    stored: true,
    verification: {
      status: verification.status,
      platform: verification.platform,
      source: verification.source,
      note: verification.note,
    },
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`);

/** 一个键一次给多少条候选去判合规 —— 多了只是让客户端多比几遍。 */
const MAX_RESOLVE_CANDIDATES = 12;

export interface ResolveCandidate {
  key: string;
  songTitle: string;
  platform: string;
  provider: string;
  model: string;
  updatedAt: string;
  /** 这条答案里 AI 标记的高亮词 —— 客户端拿它跟自己手上的歌词比。 */
  words: string[];
}

/*
 * 按**歌名**找同类条目 —— 精确键没命中时的兜底。
 *
 * 键是「歌词 + policy」的 MD5，于是同一首歌换个版本的歌词（翻唱、现场、平台之间
 * 同一首歌的 LRC 也常常不一样）就是另一个键，明明库里躺着答案却取不到。这里改按歌名
 * 找，把每条候选的高亮词带回去，由客户端拿自己那段歌词判「合不合规」。
 *
 * 只返回高亮词、不返回 payload：判定的活留在客户端，歌词正文也就不用上传。
 */
export const findResolveCandidates = async (
  db: D1Database,
  kind: string,
  songTitle: string,
): Promise<ResolveCandidate[]> => {
  const title = String(songTitle ?? '').trim().slice(0, MAX_TITLE_CHARS);
  if (!title) return [];
  const rows = await db
    .prepare(
      `SELECT cache_key, song_title, provider, model, platform, updated_at, payload_json
       FROM ai_cache
       WHERE kind = ? AND song_title <> '' AND (song_title = ? OR song_title LIKE ? ESCAPE '\\')
       ORDER BY (song_title = ?) DESC, updated_at DESC
       LIMIT ?`,
    )
    .bind(kind, title, `%${escapeLike(title)}%`, title, MAX_RESOLVE_CANDIDATES)
    .all<{
      cache_key: string;
      song_title: string | null;
      provider: string | null;
      model: string | null;
      platform: string | null;
      updated_at: string | null;
      payload_json: string | null;
    }>();

  return (rows.results ?? []).map((row) => {
    let payload: unknown = null;
    try {
      payload = JSON.parse(String(row.payload_json ?? ''));
    } catch {
      payload = null;
    }
    return {
      key: String(row.cache_key ?? ''),
      songTitle: String(row.song_title ?? ''),
      platform: String(row.platform ?? ''),
      provider: String(row.provider ?? ''),
      model: String(row.model ?? ''),
      updatedAt: String(row.updated_at ?? ''),
      words: isRecord(payload) ? readHighlightWords(payload) : [],
    };
  });
};

const buildRoutes = (options: { admin: boolean }) => {
  const routes = new Hono<{ Bindings: Env }>();
  if (options.admin) routes.use('*', requireAdmin);
  else {
    routes.use('*', stageWriteRateLimit);
    routes.use('*', bodyLimit({ maxSize: 80 * 1024, onError: (c) => c.json({ ok: false, error: 'request_too_large' }, 413) }));
  }

  /*
   * POST /api/ai-cache/resolve —— 公开，因为要拉缓存的人本来就没 token。
   *
   * 客户端拿精确键问过一次没中，再来这里按歌名要一批候选；判「合不合规」的活由客户端
   * 做（它才有自己那段歌词），这里只给高亮词。歌词正文因此一次都不用上传。
   */
  routes.post('/resolve', async (c) => {
    const body = await c.req.json<unknown>().catch(() => null);
    const source = isRecord(body) ? body : {};
    const kind = String(source.kind ?? '').trim().toLowerCase();
    const songTitle = String(source.songTitle ?? '').trim();
    if (!KIND_PATTERN.test(kind) || !songTitle) {
      return c.json({ ok: true, candidates: [] });
    }
    return c.json({ ok: true, candidates: await findResolveCandidates(c.env.FOLIA_SYNC_DB, kind, songTitle) });
  });

  routes.get('/:kind/:key', async (c) => {
    const kind = String(c.req.param('kind') || '').toLowerCase();
    const key = String(c.req.param('key') || '').toLowerCase();
    if (!KIND_PATTERN.test(kind) || !KEY_PATTERN.test(key)) {
      return c.json({ ok: false, error: 'invalid_key' }, 400);
    }
    const result = await handleGet(c.env.FOLIA_SYNC_DB, kind, key);
    return c.json(result);
  });

  routes.put('/:kind/:key', async (c) => {
    const kind = String(c.req.param('kind') || '').toLowerCase();
    const key = String(c.req.param('key') || '').toLowerCase();
    if (!KIND_PATTERN.test(kind) || !KEY_PATTERN.test(key)) {
      return c.json({ ok: false, error: 'invalid_key' }, 400);
    }
    const body = await c.req.json<unknown>().catch(() => null);
    /*
     * `AI_CACHE_VERIFY=off` 是上游抖动时的退路：只留空数据与合规那两道，不再拿
     * 平台上的歌词对哈希。默认开着。
     */
    const strict = String(c.env.AI_CACHE_VERIFY ?? '').trim().toLowerCase() !== 'off';
    const result = await handlePut(c.env.FOLIA_SYNC_DB, kind, key, body, { strict, admin: options.admin });
    return c.json(result, result.ok ? 200 : 400);
  });

  return routes;
};

/** Public read/write: `/api/ai-cache/...`. */
export const aiCacheRoutes = buildRoutes({ admin: false });

/** Admin list/delete: `/admin/api/ai-cache/...`. */
export const adminCacheRoutes = (() => {
  const routes = buildRoutes({ admin: true });

  routes.get('/', async (c) => {
    const kind = String(c.req.query('kind') || '').trim().toLowerCase();
    const query = String(c.req.query('q') || '').trim().toLowerCase();
    const requested = Number.parseInt(String(c.req.query('limit') || ''), 10);
    const limit = Number.isFinite(requested)
      ? Math.max(1, Math.min(MAX_LIST_LIMIT, requested))
      : DEFAULT_LIST_LIMIT;

    const rows = kind && KIND_PATTERN.test(kind)
      ? await c.env.FOLIA_SYNC_DB
        .prepare('SELECT kind, cache_key, payload_json, payload_bytes, song_title, provider, model, platform, hits, created_at, updated_at FROM ai_cache WHERE kind = ? ORDER BY updated_at DESC LIMIT ?')
        .bind(kind, limit)
        .all<AiCacheRow>()
      : await c.env.FOLIA_SYNC_DB
        .prepare('SELECT kind, cache_key, payload_json, payload_bytes, song_title, provider, model, platform, hits, created_at, updated_at FROM ai_cache ORDER BY updated_at DESC LIMIT ?')
        .bind(limit)
        .all<AiCacheRow>();

    let entries = (rows.results ?? []).map(mapRow);
    if (query) {
      entries = entries.filter((entry) => (
        `${entry.key} ${entry.songTitle}`.toLowerCase().includes(query)
      ));
    }
    return c.json({ ok: true, entries, limit });
  });

  routes.delete('/:kind/:key', async (c) => {
    const kind = String(c.req.param('kind') || '').toLowerCase();
    const key = String(c.req.param('key') || '').toLowerCase();
    if (!KIND_PATTERN.test(kind) || !KEY_PATTERN.test(key)) {
      return c.json({ ok: false, error: 'invalid_key' }, 400);
    }
    await c.env.FOLIA_SYNC_DB
      .prepare('DELETE FROM ai_cache WHERE kind = ? AND cache_key = ?')
      .bind(kind, key)
      .run();
    return c.json({ ok: true });
  });

  /* Clear-all is a DELETE on the collection rather than a /clear sub-path:
   * it keeps the router from having to choose between `/clear` and `/:kind`. */
  routes.delete('/', async (c) => {
    const kind = String(c.req.query('kind') || '').trim().toLowerCase();
    if (kind) {
      if (!KIND_PATTERN.test(kind)) return c.json({ ok: false, error: 'invalid_kind' }, 400);
      await c.env.FOLIA_SYNC_DB.prepare('DELETE FROM ai_cache WHERE kind = ?').bind(kind).run();
    } else {
      await c.env.FOLIA_SYNC_DB.prepare('DELETE FROM ai_cache').run();
    }
    return c.json({ ok: true });
  });

  return routes;
})();

/*
 * Admin: `/admin/api/ai-cache-backups/...` —— 每次被覆盖之前的那一版。
 *
 * 校验能挡住空数据，挡不住「一份能看但很糟的主题」。真被盖掉了，管理员在这里挑一版
 * 旧的捞回来，比让人重新生成一遍划算得多。
 */
/**
 * 把某一版副本捞回成当前那条 —— JSON 接口与管理页面共用这一份。
 *
 * 先把**现在这条**也存进备份再覆盖：万一捞错了还能再捞回来，不会把当前版本弄丢。
 * 这一版捞回来之后自己就没必要留着了，删掉。
 */
export const restoreCacheBackup = async (
  db: D1Database,
  id: number,
): Promise<{ ok: true; kind: string; key: string } | { ok: false; error: string; status: 400 | 404 }> => {
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, error: 'invalid_id', status: 400 };
  }
  const row = await db
    .prepare('SELECT id, kind, cache_key, payload_json, payload_bytes, song_title, provider, model, platform, hits, created_at, archived_at FROM ai_cache_backups WHERE id = ?')
    .bind(id)
    .first<AiCacheBackupRow>();
  if (!row) return { ok: false, error: 'not_found', status: 404 };
  if (row.kind === 'stage') {
    let payload: unknown;
    try { payload = JSON.parse(row.payload_json); } catch { payload = null; }
    if (!validateStagePayload(payload)) return { ok: false, error: 'invalid_payload', status: 400 };
  }

  await archiveExistingEntry(db, row.kind, row.cache_key);

  const now = new Date().toISOString();
  await db
    .prepare(`
      INSERT INTO ai_cache (kind, cache_key, payload_json, payload_bytes, song_title, provider, model, platform, hits, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, cache_key) DO UPDATE SET
        payload_json = excluded.payload_json,
        payload_bytes = excluded.payload_bytes,
        song_title = excluded.song_title,
        provider = excluded.provider,
        model = excluded.model,
        platform = excluded.platform,
        updated_at = excluded.updated_at
    `)
    .bind(
      row.kind,
      row.cache_key,
      row.payload_json,
      Number(row.payload_bytes ?? 0),
      row.song_title ?? '',
      row.provider ?? '',
      row.model ?? '',
      row.platform ?? '',
      Number(row.hits ?? 0),
      row.created_at ?? now,
      now,
    )
    .run();

  await db
    .prepare('DELETE FROM ai_cache_backups WHERE id = ?')
    .bind(id)
    .run();

  return { ok: true, kind: row.kind, key: row.cache_key };
};

export const adminCacheBackupRoutes = (() => {
  const routes = new Hono<{ Bindings: Env }>();
  routes.use('*', requireAdmin);

  /** GET /admin/api/ai-cache-backups/:kind/:key —— 这个键留下来的旧版，新的在前。 */
  routes.get('/:kind/:key', async (c) => {
    const kind = String(c.req.param('kind') || '').toLowerCase();
    const key = String(c.req.param('key') || '').toLowerCase();
    if (!KIND_PATTERN.test(kind) || !KEY_PATTERN.test(key)) {
      return c.json({ ok: false, error: 'invalid_key' }, 400);
    }
    const rows = await c.env.FOLIA_SYNC_DB
      .prepare('SELECT id, kind, cache_key, payload_json, payload_bytes, song_title, provider, model, platform, hits, created_at, archived_at FROM ai_cache_backups WHERE kind = ? AND cache_key = ? ORDER BY archived_at DESC, id DESC')
      .bind(kind, key)
      .all<AiCacheBackupRow>();
    return c.json({
      ok: true,
      limit: MAX_CACHE_BACKUPS,
      backups: (rows.results ?? []).map(mapBackupRow),
    });
  });

  /*
   * POST /admin/api/ai-cache-backups/:id/restore —— 把某一版捞回成当前那条。
   *
   * 借口与页面共用同一个 `restoreCacheBackup`；这里只负责把结果说成 JSON。
   */
  routes.post('/:id/restore', async (c) => {
    const id = Number.parseInt(String(c.req.param('id') || ''), 10);
    const result = await restoreCacheBackup(c.env.FOLIA_SYNC_DB, id);
    if (!result.ok) return c.json({ ok: false, error: result.error }, result.status);
    return c.json({ ok: true, restored: id });
  });

  return routes;
})();

/** Panel counters. */
export const readCacheStats = async (db: D1Database) => {
  const row = await db
    .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(payload_bytes), 0) AS bytes, COALESCE(SUM(hits), 0) AS hits FROM ai_cache')
    .first<{ count: number; bytes: number; hits: number }>();
  const kindRows = await db
    .prepare('SELECT kind, COUNT(*) AS count FROM ai_cache GROUP BY kind')
    .all<{ kind: string; count: number }>();
  const kindCounts: Record<string, number> = {};
  (kindRows.results ?? []).forEach((entry) => {
    kindCounts[entry.kind] = Number(entry.count ?? 0);
  });
  return {
    cacheCount: Number(row?.count ?? 0),
    cacheBytes: Number(row?.bytes ?? 0),
    totalHits: Number(row?.hits ?? 0),
    kindCounts,
  };
};
