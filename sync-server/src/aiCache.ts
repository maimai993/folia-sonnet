import { Hono } from 'hono';
import { requireAdmin } from './admin.js';
import type { D1Database, D1PreparedStatement, Env } from './app.js';
import { MAX_CACHE_BACKUPS } from './aiCacheBackups.js';
import { invalidateSongTotalCache, readSongTotal } from './aiCacheSongTotal.js';
import {
  deleteTitleTokens,
  findResolveCandidates as findResolveCandidatesIn,
  writeTitleTokens,
} from './aiCacheTitleIndex.js';
import { readHighlightWords, verifyStageUpload } from './stageVerifier.js';

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
/** 歌名清单：一次给多少条（客户端拿它铺一屏再往下取）。 */
const MAX_SONGS_LIMIT = 200;
const DEFAULT_SONGS_LIMIT = 60;
const MAX_PLATFORM_CHARS = 64;

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

/*
 * 每条命中要写两行（累加器 + 流水），而 `run()` 每次都是一次独立的自动提交事务 ——
 * 并发一上来，SQLite 的写锁就被这些一句话的小事务不停抢，读操作排在写锁后面等，
 * 表现就是「明明只是取一条缓存，却卡住」。两句写合成一次 batch：一次事务、一次落盘。
 *
 * 流水那条仍然「写不进去就算了」：它只是统计，不该让一次命中变成 500。
 */
const commitHit = async (
  db: D1Database,
  kind: string,
  key: string,
  hitLog: D1PreparedStatement,
): Promise<void> => {
  try {
    await db.batch([
      db.prepare('UPDATE ai_cache SET hits = hits + 1 WHERE kind = ? AND cache_key = ?').bind(kind, key),
      hitLog,
    ]);
  } catch {
    // 整批回滚了：退一步只记累加器，命中接口本身不报错。
    await db
      .prepare('UPDATE ai_cache SET hits = hits + 1 WHERE kind = ? AND cache_key = ?')
      .bind(kind, key)
      .run()
      .catch(() => undefined);
    await hitLog.run().catch(() => undefined);
  }
};

/*
 * 时间窗口的比较值必须和 `at` **同一种写法**。
 *
 * `at` 是 `new Date().toISOString()`（`2026-10-18T02:13:00.000Z`），而 `datetime('now', …)`
 * 给的是 `2026-10-18 02:13:00` —— 两个字符串比大小时，第 11 位是 `T` 对空格，`T` 更大，
 * 于是**同一天里比窗口更早的每一行都算「在窗口内」**：「最近 5 分钟」和「最近 24 小时」
 * 出来的是同一个数（当天全部），换档看不出区别。这里按 ISO 的写法取阈值，比较才成立。
 */
export const isoMinutesAgo = (minutes: number): string => {
  const whole = Math.round(Number(minutes) || 0);
  const modifier = `${whole < 0 ? '-' : '+'}${Math.abs(whole)} minutes`;
  return `strftime('%Y-%m-%dT%H:%M:%S', 'now', '${modifier}')`;
};

export const pruneHitLog = async (db: D1Database): Promise<void> => {
  await db
    .prepare(`DELETE FROM ai_cache_hits WHERE at < ${isoMinutesAgo(-HIT_LOG_RETENTION_DAYS * 24 * 60)}`)
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

  await commitHit(
    db,
    kind,
    key,
    db
      .prepare('INSERT INTO ai_cache_hits (kind, cache_key, song_title, at) VALUES (?, ?, ?, ?)')
      .bind(kind, key, row.song_title ?? '', new Date().toISOString()),
  );

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
const archiveExistingEntry = (
  db: D1Database,
  kind: string,
  key: string,
  now: string,
): D1PreparedStatement[] => [
  // Read the current version inside the same transaction as its replacement.
  db.prepare(`
    INSERT INTO ai_cache_backups
      (kind, cache_key, payload_json, payload_bytes, song_title, provider, model, platform, hits, created_at, archived_at)
    SELECT kind, cache_key, payload_json, payload_bytes, song_title, provider, model, platform, hits, created_at, ?
    FROM ai_cache WHERE kind = ? AND cache_key = ?
  `).bind(now, kind, key),
  db.prepare(`
    DELETE FROM ai_cache_backups
    WHERE kind = ? AND cache_key = ?
      AND id NOT IN (
        SELECT id FROM ai_cache_backups
        WHERE kind = ? AND cache_key = ?
        ORDER BY archived_at DESC, id DESC
        LIMIT ?
      )
  `).bind(kind, key, kind, key, MAX_CACHE_BACKUPS),
];

/*
 * PUT /api/ai-cache/:kind/:key — the push, after a real generation.
 *
 * 同键**覆盖**，不是「已存在就跳过」。用户点了「重新生成」说明他对云端那条
 * 不满意，就是要拿新的把旧的换掉；累加器 `hits` 照旧留着（它记的是这条被拿过
 * 多少次，换了内容也不该清零），`created_at` 也不动。
 *
 * 但覆盖前先过一遍校验：空数据一律拒，形状不合规一律拒，能拿平台上的歌词原文件
 * 重算哈希的再对一遍。通过了才把旧版存进备份、再写入新的一版。
 */
const handlePut = async (
  db: D1Database,
  kind: string,
  key: string,
  body: unknown,
  options: { strict: boolean },
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
  if (!parsed.ok) return { ok: false, error: 'invalid_payload', stored: false, note: 'payload 缺失或超过 64KB。' };

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

  /* 先把旧版存好，再覆盖 —— 顺序反了就什么都没留下。 */
  await db.batch([
    ...archiveExistingEntry(db, kind, key, now),
    db.prepare(`
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
    .bind(kind, key, JSON.stringify(parsed.payload), parsed.bytes, songTitle, provider, model, platform, now, now),
    /* 倒排索引跟主表在同一个事务里更新：不会出现「主表改了、索引还指着旧歌名」。 */
    ...writeTitleTokens(db, kind, key, songTitle, now),
  ]);
  /* 可能新增了一种歌名，让 /songs 的总数缓存立刻作废（不等 TTL 自然过期）。 */
  invalidateSongTotalCache(db);

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

/**
 * 按主键把整行（含 payload_json）补回来。
 *
 * 模糊扫描只捞元数据（覆盖索引扫描，不碰大字段），捞到最终那几条之后再按主键取整行
 * —— 点查走 (kind, cache_key) 主键，每次都是几微秒。分块是为了 Cloudflare D1 的
 * 「单条查询最多 100 个绑定参数」限制，自托管那边一起遵守。
 */
const HYDRATE_CHUNK = 90;
export const hydrateCacheRows = async (
  db: D1Database,
  wanted: readonly { kind: string; cache_key: string }[],
): Promise<Map<string, AiCacheRow>> => {
  const map = new Map<string, AiCacheRow>();
  const byKind = new Map<string, string[]>();
  wanted.forEach(({ kind, cache_key }) => {
    const key = String(cache_key ?? '');
    if (!kind || !key) return;
    const bucket = byKind.get(kind);
    if (bucket) {
      if (!bucket.includes(key)) bucket.push(key);
    } else {
      byKind.set(kind, [key]);
    }
  });
  for (const [kind, keys] of byKind) {
    for (let index = 0; index < keys.length; index += HYDRATE_CHUNK) {
      const chunk = keys.slice(index, index + HYDRATE_CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = await db
        .prepare(
          `SELECT kind, cache_key, payload_json, payload_bytes, song_title, provider, model, platform, hits, created_at, updated_at
           FROM ai_cache WHERE kind = ? AND cache_key IN (${placeholders})`,
        )
        .bind(kind, ...chunk)
        .all<AiCacheRow>();
      (rows.results ?? []).forEach((row) => {
        map.set(`${row.kind}\u0000${row.cache_key}`, row);
      });
    }
  }
  return map;
};


const buildRoutes = (options: { admin: boolean }) => {
  const routes = new Hono<{ Bindings: Env }>();
  if (options.admin) routes.use('*', requireAdmin);

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
    return c.json({
      ok: true,
      candidates: await findResolveCandidatesIn(c.env.FOLIA_SYNC_DB, kind, songTitle, {
        hydrate: (wanted) => hydrateCacheRows(c.env.FOLIA_SYNC_DB, wanted),
        readWords: readHighlightWords,
        isRecord,
        maxTitleChars: MAX_TITLE_CHARS,
      }),
    });
  });

  /*
   * GET /api/ai-cache/songs —— 「云端现在有哪些歌」。
   *
   * 给首页那个「AI 主题」页签用：它要的是**歌名清单**，客户端拿着这些名字去自己
   * 登着的平台上一首一首搜出来，于是云端只需要记名字，不必存任何曲目、封面或链接。
   *
   * 按歌名去重：同一首歌换个版本的歌词就是另一个键（翻唱、现场、各平台的 LRC 本来
   * 就不一样），列出来却该是一行 —— 用户眼里那就是一首歌。
   *
   * 挂在 `/:kind/:key` **之前**：那一条要两段路径，抢不到这里，但路由表里先来后到
   * 更靠得住（`/resolve` 同理在它前面）。
   */
  routes.get('/songs', async (c) => {
    const requestedLimit = Number.parseInt(String(c.req.query('limit') || ''), 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(MAX_SONGS_LIMIT, requestedLimit))
      : DEFAULT_SONGS_LIMIT;
    const requestedOffset = Number.parseInt(String(c.req.query('offset') || ''), 10);
    const offset = Number.isFinite(requestedOffset) ? Math.max(0, requestedOffset) : 0;

    /*
     * 搜索框里那个「AI 主题」来源带 `q`：按歌名在云端筛。
     *
     * LIKE 的通配符（`%` 与 `_`）必须转义，否则用户敲一个下划线就配上了所有歌名 ——
     * 那不是「搜得更宽」，那是把整个库都列出来。
     */
    const query = String(c.req.query('q') || '').trim().slice(0, MAX_TITLE_CHARS);
    const filter = query ? " AND song_title LIKE ? ESCAPE '\\'" : '';

    /*
     * 总数先给：客户端要拿它**先把屏幕铺满**（占位行按总数排好），再一条一条往里填。
     * 不先占位的话，每插一条整张表就重排一次 —— 几百条下来就是一直在抖。
     * 带了 q 就是筛完之后的条数（不然「已加载 3 / 900」这种进度根本没法看）。
     *
     * 不带 q 的那一个走短时缓存：`COUNT(DISTINCT song_title)` 得把整个歌名索引读一遍
     * 去重，4 万条实测 5.6ms，而分页那半句只要 0.15ms —— 每请求都算一次的话，这一句
     * 就是 `/songs` 的全部开销（压测里 p50 44ms 里大部分是它，并发时还排队）。
     * 歌名总数变得很慢（只有新歌进库才变），缓存几秒完全看不出差别；带 q 的计数各不
     * 相同，缓存没有意义，仍然每次现算。
     */
    const totalRow = query
      ? await c.env.FOLIA_SYNC_DB
        .prepare(`SELECT COUNT(DISTINCT song_title) AS total FROM ai_cache WHERE song_title IS NOT NULL AND song_title <> ''${filter}`)
        .bind(`%${escapeLike(query)}%`)
        .first<{ total: number }>()
      : await readSongTotal(c.env.FOLIA_SYNC_DB);

    const binds: unknown[] = query ? [`%${escapeLike(query)}%`, limit, offset] : [limit, offset];

    const rows = await c.env.FOLIA_SYNC_DB
      .prepare(
        /*
         * 按歌名分组之后要分页，就得有个顺序。这里按 `song_title` 排（也就是按歌名
         * 字典序），不再按「最近更新」排：后者是聚合值，SQLite 只能把**整个分组结果**
         * 建成临时表再排序，库一大这条就慢到几百毫秒，而 better-sqlite3 是同步的，
         * 整个进程跟着停。按歌名排能直接顺着 `idx_ai_cache_song_group` 边扫边分组、
         * 取到 LIMIT 就停 —— 4w 行时从 80ms 降到 2ms。
         *
         * 客户端本来就是靠 offset 分页、自己不做排序，所以顺序变化不影响加载。
         * 每行的 `updatedAt` 仍旧是这一组里最新的那条，没变。
         */
        `SELECT song_title, MAX(updated_at) AS updated_at, SUM(hits) AS hits,
                MAX(cache_key) AS cache_key, MAX(platform) AS platform, COUNT(*) AS versions
         FROM ai_cache
         WHERE song_title IS NOT NULL AND song_title <> ''${filter}
         GROUP BY song_title
         ORDER BY song_title ASC
         LIMIT ? OFFSET ?`,
      )
      .bind(...binds)
      .all<{ song_title: string | null; updated_at: string | null; hits: number; cache_key: string | null; platform: string | null; versions: number }>();

    return c.json({
      ok: true,
      total: Number(totalRow?.total ?? 0),
      limit,
      offset,
      songs: (rows.results ?? []).map((row) => ({
        songTitle: String(row.song_title ?? ''),
        platform: String(row.platform ?? ''),
        key: String(row.cache_key ?? ''),
        updatedAt: String(row.updated_at ?? ''),
        hits: Number(row.hits ?? 0),
        versions: Number(row.versions ?? 1),
      })),
    });
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
    const result = await handlePut(c.env.FOLIA_SYNC_DB, kind, key, body, { strict });
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

    /*
     * 搜索和类型筛选都**下到 SQL 里**。
     *
     * 原来是先按 `updated_at` 取回前 500 条，再在内存里筛 —— 于是库里第 501 条往后的一切，
     * 管理员怎么搜都搜不到（「搜索也搜不到」），而顶上那个「缓存条目（N）」显示的又是这次
     * 取回的条数，于是永远就是 500（「一直都是 500 个」）。
     */
    const where: string[] = [];
    const binds: unknown[] = [];
    if (kind && KIND_PATTERN.test(kind)) {
      where.push('kind = ?');
      binds.push(kind);
    }
    if (query) {
      where.push("(cache_key LIKE ? ESCAPE '\\' OR song_title LIKE ? ESCAPE '\\')");
      const like = `%${escapeLike(query)}%`;
      binds.push(like, like);
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';

    // 条数是**整个库**（或筛完之后的）的条数，不是这一页取回多少条。
    const totalRow = await c.env.FOLIA_SYNC_DB
      .prepare(`SELECT COUNT(*) AS total FROM ai_cache${clause}`)
      .bind(...binds)
      .first<{ total: number }>();

    /*
     * 两段式：先只捞元数据（排序与筛选在覆盖索引上完成，不碰大字段），再按主键把
     * 这一页的 payload 补回来。原来带 payload_json 的整行扫描在 10w 条上每次都是
     * 全表翻页 —— 管理页开一次就把整个事件循环卡住。
     *
     * 排序键跟 `WHERE` 里的 `kind` 对齐：带 kind 筛选时用 `idx_ai_cache_kind_updated_at`，
     * 顺着索引取够 limit 条就停；不带 kind 时走 `idx_ai_cache_updated_at`。原来一律
     * `ORDER BY updated_at DESC`，带 kind 时会把整个 kind 分支（现在几乎就是全表）
     * 先取回来再排 —— 实测 4w 行时 339ms，对齐后 2.5ms。
     */
    const orderBy = typeof kind === 'string' && KIND_PATTERN.test(kind)
      ? ' ORDER BY kind ASC, updated_at DESC'
      : ' ORDER BY updated_at DESC';
    const metaRows = await c.env.FOLIA_SYNC_DB
      .prepare(
        `SELECT kind, cache_key, payload_bytes, song_title, provider, model, platform, hits, created_at, updated_at
         FROM ai_cache${clause}${orderBy}
         LIMIT ?`,
      )
      .bind(...binds, limit)
      .all<Omit<AiCacheRow, 'payload_json'>>();

    const payloadMap = await hydrateCacheRows(c.env.FOLIA_SYNC_DB, metaRows.results ?? []);
    const entries = (metaRows.results ?? []).map((meta) => {
      const hydrated = payloadMap.get(`${meta.kind}\u0000${meta.cache_key}`);
      return mapRow({ ...meta, payload_json: hydrated?.payload_json ?? '' });
    });

    return c.json({
      ok: true,
      entries,
      total: Number(totalRow?.total ?? 0),
      limit,
    });
  });

  routes.delete('/:kind/:key', async (c) => {
    const kind = String(c.req.param('kind') || '').toLowerCase();
    const key = String(c.req.param('key') || '').toLowerCase();
    if (!KIND_PATTERN.test(kind) || !KEY_PATTERN.test(key)) {
      return c.json({ ok: false, error: 'invalid_key' }, 400);
    }
    /* 主表和倒排索引一起删：留着 token 行只会让 resolve 命中一条已经不存在的记录。 */
    await c.env.FOLIA_SYNC_DB.batch([
      c.env.FOLIA_SYNC_DB.prepare('DELETE FROM ai_cache WHERE kind = ? AND cache_key = ?').bind(kind, key),
      deleteTitleTokens(c.env.FOLIA_SYNC_DB, kind, key),
    ]);
    invalidateSongTotalCache(c.env.FOLIA_SYNC_DB);
    return c.json({ ok: true });
  });

  /* Clear-all is a DELETE on the collection rather than a /clear sub-path:
   * it keeps the router from having to choose between `/clear` and `/:kind`. */
  routes.delete('/', async (c) => {
    const kind = String(c.req.query('kind') || '').trim().toLowerCase();
    if (kind) {
      if (!KIND_PATTERN.test(kind)) return c.json({ ok: false, error: 'invalid_kind' }, 400);
      await c.env.FOLIA_SYNC_DB.batch([
        c.env.FOLIA_SYNC_DB.prepare('DELETE FROM ai_cache WHERE kind = ?').bind(kind),
        deleteTitleTokens(c.env.FOLIA_SYNC_DB, kind),
      ]);
    } else {
      await c.env.FOLIA_SYNC_DB.batch([
        c.env.FOLIA_SYNC_DB.prepare('DELETE FROM ai_cache'),
        deleteTitleTokens(c.env.FOLIA_SYNC_DB),
      ]);
    }
    invalidateSongTotalCache(c.env.FOLIA_SYNC_DB);
    return c.json({ ok: true });
  });

  return routes;
})();

/** Panel counters. */
export const readCacheStats = async (db: D1Database) => {
  /*
   * 一条分组查询同时给出「每个 kind 几条、占多大」和总计，不再另外跑一次全表
   * `COUNT(*) / SUM(...)`：面板每次刷新都要这两个数，而 `SUM(payload_bytes)` 要逐行读
   * 一个整数列 —— 合并之后只扫一遍。
   */
  const kindRows = await db
    .prepare('SELECT kind, COUNT(*) AS count, COALESCE(SUM(payload_bytes), 0) AS bytes FROM ai_cache GROUP BY kind')
    .all<{ kind: string; count: number; bytes: number }>();
  const hitsRow = await db
    .prepare('SELECT COALESCE(SUM(hits), 0) AS hits FROM ai_cache')
    .first<{ hits: number }>();

  const kindCounts: Record<string, number> = {};
  let cacheCount = 0;
  let cacheBytes = 0;
  (kindRows.results ?? []).forEach((entry) => {
    const count = Number(entry.count ?? 0);
    kindCounts[entry.kind] = count;
    cacheCount += count;
    cacheBytes += Number(entry.bytes ?? 0);
  });
  return {
    cacheCount,
    cacheBytes,
    totalHits: Number(hitsRow?.hits ?? 0),
    kindCounts,
  };
};
