import { Hono } from 'hono';
import { requireAdmin } from './admin.js';
import type { D1Database, D1PreparedStatement, Env } from './app.js';
import { looseSongTitle, rankSongTitleMatch, songTitleLike, songTitleSeed, songTitleSegments, songTitleKey } from './songTitleMatch.js';
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
  ]);

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
/**
 * 模糊匹配先捞多少行回来打分。
 *
 * LIKE '%…%' 用不上索引，而「哪条才是同一首歌」只有压成核心名之后才知道 —— 这件事
 * SQL 做不了，只好先多捞一点、在本机排完再截断。payload 只给最后那几条 parse。
 */
const MAX_RESOLVE_SCAN_ROWS = 200;
/** 一次查询里最多并列几条 LIKE 模式（拆段那一路用）。 */
const MAX_RESOLVE_PATTERNS = 4;

/** 捞回来的一行，还没打分。只带排序与打分要用的列，让扫描走覆盖索引。 */
type ResolveRow = {
  cache_key: string;
  song_title: string | null;
  updated_at: string | null;
};

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

/**
 * 按一组 LIKE 模式捞行：一条 SQL 用 OR 把它们并在一起。
 *
 * 只捞这几列 —— payload 是留给最后那几条才取的（见 hydrateCacheRows）。
 */
const scanResolveRows = async (
  db: D1Database,
  kind: string,
  patterns: string[],
): Promise<ResolveRow[]> => {
  const terms = [...new Set(patterns.map((entry) => String(entry ?? '').trim()).filter(Boolean))]
    .slice(0, MAX_RESOLVE_PATTERNS);
  if (terms.length === 0) return [];
  const where = terms.map(() => "song_title LIKE ? ESCAPE '\\'").join(' OR ');
  const rows = await db
    .prepare(
      `SELECT cache_key, song_title, updated_at
       FROM ai_cache
       WHERE kind = ? AND song_title <> '' AND (${where})
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .bind(kind, ...terms.map((term) => `%${escapeLike(term)}%`), MAX_RESOLVE_SCAN_ROWS)
    .all<ResolveRow>();
  return rows.results ?? [];
};

/** 打分 + 排序 + 截断：归一后对不上的不算候选。 */
const rankResolveRows = (rows: ResolveRow[], title: string) => rows
  .map((row) => ({ row, rank: rankSongTitleMatch(String(row.song_title ?? ''), title) }))
  /* 归一后对不上的不算候选 —— 光靠原样包含捞回来的，高亮词那关也过不去。 */
  .filter((entry) => entry.rank < 3)
  .sort((left, right) => (
    left.rank - right.rank
    || String(right.row.updated_at ?? '').localeCompare(String(left.row.updated_at ?? ''))
  ))
  .slice(0, MAX_RESOLVE_CANDIDATES);

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
const findResolveCandidatesOfKind = async (
  db: D1Database,
  kind: string,
  songTitle: string,
): Promise<ResolveCandidate[]> => {
  const title = String(songTitle ?? '').trim().slice(0, MAX_TITLE_CHARS);
  if (!title) return [];
  /*
   * 两个 LIKE 都收：库里那条更长的（「晴天 现场」）命中第一个，完全相等的命中
   * `song_title = ?`。请求更长那一种（「晴天 (Live)」）已经被 `loose` 压短成「晴天」，
   * 于是反过来能配上库里的短名 —— 这正是括号/后缀那批歌以前配不上的方向。
   */
  const loose = looseSongTitle(title) || title;
  /*
   * 第三条：`smooth` 连标点也去了。「花海 - 现场」削掉后缀后那个连字符还在，
   * `LIKE '%花海 -%'` 一条都配不上库里的「花海」，而 `songTitleKey` 是认的。
   */
  const smooth = songTitleLike(title) || loose;
  const rows = await db
    .prepare(
      `SELECT cache_key, song_title, updated_at
       FROM ai_cache
       WHERE kind = ? AND song_title <> '' AND (song_title = ? OR song_title LIKE ? ESCAPE '\\' OR song_title LIKE ? ESCAPE '\\' OR song_title LIKE ? ESCAPE '\\')
       ORDER BY (song_title = ?) DESC, updated_at DESC
       LIMIT ?`,
    )
    .bind(kind, title, `%${escapeLike(loose)}%`, `%${escapeLike(smooth)}%`, `%${escapeLike(title)}%`, title, MAX_RESOLVE_SCAN_ROWS)
    .all<ResolveRow>();

  let ranked = rankResolveRows(rows.results ?? [], title);

  /*
   * 退路一：**拆开各段**分别去捞。
   *
   * 「歌手 - 歌名」那批名字：整串压完是「周杰伦晴天」，怎么 LIKE 都配不上库里的
   * 「晴天」。这里按分隔符切开，「周杰伦」「晴天」两段各问一次、命中并在一起 ——
   * 这是那种名字唯一能走通的路。放宽的只是入口，判定仍旧在客户端（高亮词）。
   */
  if (ranked.length === 0) {
    const segments = songTitleSegments(title);
    if (segments.length > 0) ranked = rankResolveRows(await scanResolveRows(db, kind, segments), title);
  }

  /*
   * 退路二：**只按歌名开头那一个字**（拉丁则头一个词）去捞。
   *
   * 各平台给同一首歌起的名字能差到怎么压都压不到一起（换了一种写法、多了段前缀），
   * 这时前面几条 LIKE 全部落空。同样只放宽入口，判定不变。
   */
  if (ranked.length === 0) {
    const seed = songTitleSeed(title);
    if (seed) {
      ranked = (await scanResolveRows(db, kind, [seed]))
        // 同一个开头才算：不然「晴天」会把「晴天的云」「晴天雨」之外的一堆也捞回来。
        .filter((row) => songTitleKey(String(row.song_title ?? '')).startsWith(seed))
        .map((row) => ({ row, rank: 2 }))
        .slice(0, MAX_RESOLVE_CANDIDATES);
    }
  }

  /*
   * 名次定完才按主键把整行（含 payload）补回来 —— 模糊扫描那几步只碰覆盖索引，
   * 大字段一次都不读。扫到 200 行、只取 12 条候选，payload 的读取量从「全表」
   * 缩到「这 12 条」。
   */
  const full = await hydrateCacheRows(db, ranked.map(({ row }) => ({ kind, cache_key: String(row.cache_key ?? '') })));

  return ranked.map(({ row }) => {
    const hydrated = full.get(`${kind}\u0000${String(row.cache_key ?? '')}`);
    const payloadJson = hydrated?.payload_json ?? null;
    let payload: unknown = null;
    try {
      payload = payloadJson ? JSON.parse(payloadJson) : null;
    } catch {
      payload = null;
    }
    return {
      key: String(row.cache_key ?? ''),
      songTitle: String(hydrated?.song_title ?? row.song_title ?? ''),
      platform: String(hydrated?.platform ?? ''),
      provider: String(hydrated?.provider ?? ''),
      model: String(hydrated?.model ?? ''),
      updatedAt: String(row.updated_at ?? ''),
      words: isRecord(payload) ? readHighlightWords(payload) : [],
    };
  });
};

/*
 * 主题与动画合成一条以后，客户端只用 `kind = 'stage'` 去问；而这个仓库更早的版本把主题
 * 单独存成 `kind = 'theme'`。于是「云上明明有这首歌」在客户端看来一直 `miss`
 * （实测日志：连续 `[ai-cache] pull missed (miss)`，高亮词却对得上）。
 *
 * 所以按歌名找候选时把兄弟 kind 一起问：判定仍在客户端（高亮词 + payload 校验），
 * 拿错只是白跑一趟，不会贴错主题。
 */
const SIBLING_CACHE_KIND: Record<string, string> = { stage: 'theme', theme: 'stage' };

export const findResolveCandidates = async (
  db: D1Database,
  kind: string,
  songTitle: string,
): Promise<ResolveCandidate[]> => {
  const own = await findResolveCandidatesOfKind(db, kind, songTitle);
  const sibling = SIBLING_CACHE_KIND[kind];
  if (!sibling || own.length >= MAX_RESOLVE_CANDIDATES) return own;
  const rest = await findResolveCandidatesOfKind(db, sibling, songTitle);
  if (rest.length === 0) return own;
  const seen = new Set(own.map((entry) => entry.key));
  return [...own, ...rest.filter((entry) => !seen.has(entry.key))].slice(0, MAX_RESOLVE_CANDIDATES);
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
      candidates: await findResolveCandidates(c.env.FOLIA_SYNC_DB, kind, songTitle),
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
     */
    const totalRow = query
      ? await c.env.FOLIA_SYNC_DB
        .prepare(`SELECT COUNT(DISTINCT song_title) AS total FROM ai_cache WHERE song_title IS NOT NULL AND song_title <> ''${filter}`)
        .bind(`%${escapeLike(query)}%`)
        .first<{ total: number }>()
      : await c.env.FOLIA_SYNC_DB
        .prepare("SELECT COUNT(DISTINCT song_title) AS total FROM ai_cache WHERE song_title IS NOT NULL AND song_title <> ''")
        .first<{ total: number }>();

    const binds: unknown[] = query ? [`%${escapeLike(query)}%`, limit, offset] : [limit, offset];

    const rows = await c.env.FOLIA_SYNC_DB
      .prepare(
        `SELECT song_title, MAX(updated_at) AS updated_at, SUM(hits) AS hits,
                MAX(cache_key) AS cache_key, MAX(platform) AS platform, COUNT(*) AS versions
         FROM ai_cache
         WHERE song_title IS NOT NULL AND song_title <> ''${filter}
         GROUP BY song_title
         ORDER BY updated_at DESC
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
     */
    const metaRows = await c.env.FOLIA_SYNC_DB
      .prepare(
        `SELECT kind, cache_key, payload_bytes, song_title, provider, model, platform, hits, created_at, updated_at
         FROM ai_cache${clause}
         ORDER BY updated_at DESC
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
  const now = new Date().toISOString();
  // Resolve and consume the target inside one transaction; a missing target makes every write a no-op.
  const results = await db.batch([
    db.prepare('SELECT kind, cache_key FROM ai_cache_backups WHERE id = ?').bind(id),
    db.prepare(`
      INSERT INTO ai_cache_backups
        (kind, cache_key, payload_json, payload_bytes, song_title, provider, model, platform, hits, created_at, archived_at)
      SELECT current.kind, current.cache_key, current.payload_json, current.payload_bytes,
        current.song_title, current.provider, current.model, current.platform, current.hits, current.created_at, ?
      FROM ai_cache AS current
      JOIN ai_cache_backups AS target ON target.kind = current.kind AND target.cache_key = current.cache_key
      WHERE target.id = ?
    `).bind(now, id),
    db.prepare(`
      DELETE FROM ai_cache_backups
      WHERE (kind, cache_key) = (SELECT kind, cache_key FROM ai_cache_backups WHERE id = ?)
        AND id <> ?
        AND id NOT IN (
          SELECT id FROM ai_cache_backups
          WHERE (kind, cache_key) = (SELECT kind, cache_key FROM ai_cache_backups WHERE id = ?)
            AND id <> ?
          ORDER BY archived_at DESC, id DESC
          LIMIT ?
        )
    `).bind(id, id, id, id, MAX_CACHE_BACKUPS),
    db.prepare(`
      INSERT INTO ai_cache (kind, cache_key, payload_json, payload_bytes, song_title, provider, model, platform, hits, created_at, updated_at)
      SELECT kind, cache_key, payload_json, COALESCE(payload_bytes, 0), COALESCE(song_title, ''),
        COALESCE(provider, ''), COALESCE(model, ''), COALESCE(platform, ''), COALESCE(hits, 0), COALESCE(created_at, ?), ?
      FROM ai_cache_backups WHERE id = ?
      ON CONFLICT(kind, cache_key) DO UPDATE SET
        payload_json = excluded.payload_json,
        payload_bytes = excluded.payload_bytes,
        song_title = excluded.song_title,
        provider = excluded.provider,
        model = excluded.model,
        platform = excluded.platform,
        updated_at = excluded.updated_at
    `).bind(now, now, id),
    db.prepare('DELETE FROM ai_cache_backups WHERE id = ?').bind(id),
  ]);
  const row = (results[0] as { results?: { kind: string; cache_key: string }[] }).results?.[0];
  if (!row) return { ok: false, error: 'not_found', status: 404 };
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
