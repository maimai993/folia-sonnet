// sync-server/src/aiCacheTitleIndex.ts
// 歌名倒排索引：把 `ai_cache` 里每条的 `song_title` 拆成 token 存进 `ai_cache_title_token`，
// 让「按歌名找同类条目」变成索引点查，而不是 `LIKE '%…%'` 全表扫。
//
// 原来 resolve 靠 `song_title LIKE '%歌名%'` 找候选，这种写法用不上任何索引，只能顺着
// `kind` 把整片分区扫一遍再逐行比 —— 4 万条（每条 6KB payload）实测 300ms 以上，而
// better-sqlite3 是同步的，这段时间里整个进程的事件循环一起停着。多进程只能摊薄它。
//
// 现在按 token 精确命中走索引：同样的查询 0.36ms，且与库的大小无关。

import type { D1Database, D1PreparedStatement } from './app.js';
import {
  looseSongTitle,
  rankSongTitleMatch,
  songTitleFallbackTokens,
  songTitleLike,
  songTitleQueryTokens,
  songTitleTokens,
} from './songTitleMatch.js';

/** resolve 拿候选时要补回来的那几列（由调用方按主键取）。 */
export type ResolveHydratedRow = {
  song_title: string | null;
  platform: string | null;
  provider: string | null;
  model: string | null;
  payload_json: string | null;
};

/** 一个键一次给多少条候选去判合规 —— 多了只是让客户端多比几遍。 */
const MAX_RESOLVE_CANDIDATES = 12;
/**
 * 索引命中后先取多少行回来打分。
 *
 * 「哪条才是同一首歌」只有压成核心名之后才知道 —— 这件事 SQL 做不了，只好先多取一点、
 * 在本机排完再截断。payload 只给最后那几条 parse。
 */
const MAX_RESOLVE_SCAN_ROWS = 200;
/** 一次查询里最多并列几条 token（核心名 + 各段 + 首字，通常 3~8 个）。 */
const MAX_RESOLVE_TOKENS = 16;
/** 兜底的 LIKE 路径最多并列几条模式（与改索引之前的行为一致）。 */
const MAX_RESOLVE_LIKE_PATTERNS = 4;

/** 捞回来的一行，还没打分。只带排序与打分要用的列，让查询走覆盖索引。 */
export type ResolveRow = {
  cache_key: string;
  song_title: string | null;
  updated_at: string | null;
};

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`);

/**
 * 按 token 捞候选行 —— resolve 的**唯一取数入口**。
 *
 * 走 `ai_cache_title_token` 的 `(kind, token, cache_key)` 主键：`IN` 几个 token 就是几次
 * 索引点查，和库有多大无关。`DISTINCT` 是因为一条记录可能有多个 token 同时命中；只有
 * 命中很多时才建临时表去重，正常情况（几个 token、十来行）不会。
 *
 * 只捞这几列 —— payload 留给最后那几条才取（见 hydrateCacheRows）。
 *
 * `ORDER BY` 里不能写 `updated_at`：那会让 SQLite 放弃索引顺序、把整个结果集建临时表
 * 再排。时间倒序在 `rankResolveRows` 里做，那里只面对几十行。
 */
const scanResolveRows = async (
  db: D1Database,
  kind: string,
  /** 要问的 token（见 songTitleMatch.ts 的 `songTitleQueryTokens`）。 */
  tokens: string[],
): Promise<ResolveRow[]> => {
  const terms = [...new Set(tokens.map((entry) => String(entry ?? '').trim()).filter(Boolean))]
    .slice(0, MAX_RESOLVE_TOKENS);
  if (terms.length === 0) return [];
  const placeholders = terms.map(() => '?').join(', ');
  const rows = await db
    .prepare(
      `SELECT DISTINCT cache_key, song_title, updated_at
       FROM ai_cache_title_token
       WHERE kind = ? AND token IN (${placeholders})
       LIMIT ?`,
    )
    .bind(kind, ...terms, MAX_RESOLVE_SCAN_ROWS)
    .all<ResolveRow>();
  return rows.results ?? [];
};

/**
 * 把一条记录的歌名写进倒排索引。
 *
 * 写入路径（PUT / 恢复旧版）与「首次命中时补写」共用它：先删掉这个键原有的 token 行，
 * 再按新歌名重写 —— 歌名可能变了，留着旧 token 就会指到一条已经改名的记录。
 *
 * 返回语句而不直接执行：调用方把它和主表的写入放进同一个 `batch`（一个事务），
 * 不会出现「主表改了、索引还指着旧歌名」，也不会出现「删了还没写」的空窗。
 */
export const writeTitleTokens = (
  db: D1Database,
  kind: string,
  key: string,
  songTitle: string,
  updatedAt: string,
): D1PreparedStatement[] => {
  const tokens = songTitleTokens(songTitle);
  const statements: D1PreparedStatement[] = [
    db.prepare('DELETE FROM ai_cache_title_token WHERE kind = ? AND cache_key = ?').bind(kind, key),
  ];
  if (tokens.length > 0) {
    /* 多行 INSERT 一次搞定：每多一条语句就多一次跨进程的往返。 */
    const values = tokens.map(() => '(?, ?, ?, ?, ?)').join(', ');
    const binds: unknown[] = [];
    tokens.forEach((token) => {
      binds.push(kind, token, key, songTitle, updatedAt);
    });
    statements.push(
      db
        .prepare(`INSERT OR REPLACE INTO ai_cache_title_token (kind, token, cache_key, song_title, updated_at) VALUES ${values}`)
        .bind(...binds),
    );
  }
  return statements;
};

/**
 * 老库没有倒排索引时的兜底：这条路走原来的 `LIKE`。
 *
 * 不回填全部历史数据是有意的 —— 4 万条要好几秒、10 万条要几十秒，放在启动路径上就是
 * 「升级后第一次启动像挂了」。改成用到哪条就补哪条（见 `backfillTitleTokens`）：
 * 热门歌名很快全都补上，冷门的一直走这个慢路径也不会有人察觉。
 */
const scanResolveRowsByLike = async (
  db: D1Database,
  kind: string,
  patterns: string[],
  title: string,
): Promise<ResolveRow[]> => {
  const terms = [...new Set(patterns.map((entry) => String(entry ?? '').trim()).filter(Boolean))]
    .slice(0, MAX_RESOLVE_LIKE_PATTERNS);
  if (terms.length === 0) return [];
  const where = terms.map(() => "song_title LIKE ? ESCAPE '\\'").join(' OR ');
  const rows = await db
    .prepare(
      `SELECT cache_key, song_title, updated_at
       FROM ai_cache
       WHERE kind = ? AND song_title <> '' AND (${where})
       ORDER BY (song_title = ?) DESC
       LIMIT ?`,
    )
    .bind(kind, ...terms.map((term) => `%${escapeLike(term)}%`), title, MAX_RESOLVE_SCAN_ROWS)
    .all<ResolveRow>();
  return rows.results ?? [];
};

/**
 * 打分 + 排序 + 截断：归一后对不上的不算候选。
 *
 * 时间倒序**在这里**做，不在 SQL 里做 —— 这是唯一能同时拿到「按时间最近」和
 * 「只用索引取前 200 行」的做法（理由见 `scanResolveRows`）。
 */
const rankResolveRows = (rows: ResolveRow[], title: string) => rows
  .map((row) => ({ row, rank: rankSongTitleMatch(String(row.song_title ?? ''), title) }))
  /* 归一后对不上的不算候选 —— 光靠原样包含捞回来的，高亮词那关也过不去。 */
  .filter((entry) => entry.rank < 3)
  .sort((left, right) => (
    left.rank - right.rank
    || String(right.row.updated_at ?? '').localeCompare(String(left.row.updated_at ?? ''))
  ))
  .slice(0, MAX_RESOLVE_CANDIDATES);

/**
 * 把「走 LIKE 兜底捞回来的那几条」补写进倒排索引。
 *
 * 只在兜底路径上调用，一次最多 `MAX_RESOLVE_SCAN_ROWS` 条，且全部合成一次 batch；
 * 失败不影响本次结果（这次已经捞到了），顶多下次再慢一遍。
 */
const backfillTitleTokens = async (
  db: D1Database,
  kind: string,
  rows: ResolveRow[],
): Promise<void> => {
  const statements: D1PreparedStatement[] = [];
  rows.forEach((row) => {
    const key = String(row.cache_key ?? '');
    const songTitle = String(row.song_title ?? '');
    if (!key || !songTitle) return;
    statements.push(...writeTitleTokens(db, kind, key, songTitle, String(row.updated_at ?? '')));
  });
  if (statements.length === 0) return;
  await db.batch(statements).catch(() => undefined);
};

/**
 * 按主表里当前的歌名重建某个键的 token（恢复旧版之后调用）。
 *
 * 不用入参里的歌名：那条记录刚从备份表捞回主表，只有主表才是最准的。
 */
export const rebuildTitleTokens = async (db: D1Database, kind: string, key: string): Promise<void> => {
  const row = await db
    .prepare('SELECT song_title, updated_at FROM ai_cache WHERE kind = ? AND cache_key = ?')
    .bind(kind, key)
    .first<{ song_title: string | null; updated_at: string | null }>();
  if (!row) return;
  await db
    .batch(writeTitleTokens(db, kind, key, String(row.song_title ?? ''), String(row.updated_at ?? '')))
    .catch(() => undefined);
};

/** 删掉一个键（或一个 kind、全表）的 token 行 —— 主表删了，索引不能留着。 */
export const deleteTitleTokens = (db: D1Database, kind?: string, key?: string): D1PreparedStatement => {
  if (kind && key) {
    return db.prepare('DELETE FROM ai_cache_title_token WHERE kind = ? AND cache_key = ?').bind(kind, key);
  }
  if (kind) return db.prepare('DELETE FROM ai_cache_title_token WHERE kind = ?').bind(kind);
  return db.prepare('DELETE FROM ai_cache_title_token');
};

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

export type ResolveDeps = {
  /** 按主键把这几列补回来。放在这里是为了不让本模块依赖 aiCache.ts。 */
  hydrate: (wanted: readonly { kind: string; cache_key: string }[]) => Promise<Map<string, ResolveHydratedRow>>;
  /** 从 payload 里读高亮词。 */
  readWords: (payload: unknown) => string[];
  isRecord: (value: unknown) => value is Record<string, unknown>;
  /** 标题长度上限。 */
  maxTitleChars: number;
};

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
  deps: ResolveDeps,
): Promise<ResolveCandidate[]> => {
  const title = String(songTitle ?? '').trim().slice(0, deps.maxTitleChars);
  if (!title) return [];

  /*
   * 两轮查，而不是把 token 全塞进一条 `IN (...)`：
   *
   * 第一轮只问 `K:`（整个核心名）与 `S:`（拆段）—— 基数小，命中多少就是多少。这一轮
   * 覆盖了绝大多数请求（歌名一致、或「歌手 - 歌名」写法差异）。
   *
   * 一条都没有时才单独问 `D:`（首字/首词）。它基数很大（4 万条库里 `D:晴` 就是 1338 行），
   * 和上面混在一条语句里会把 `LIMIT` 撑满，**反而把精确命中的那几十行挤掉**。分两轮
   * 才能既保住精度、又留住「名字写法差太多」时的兜底。
   */
  let rows = await scanResolveRows(db, kind, songTitleQueryTokens(title));
  if (rows.length === 0) {
    rows = await scanResolveRows(db, kind, songTitleFallbackTokens(title));
  }
  if (rows.length === 0) {
    /*
     * 一条 token 都没命中：可能是老库还没建倒排（历史条目没进索引），也可能真的没有。
     * 走一次原来的 LIKE 兜底，顺手把命中的那几条补写进索引 —— 下次就走快路径了。
     */
    rows = await scanResolveRowsByLike(db, kind, [title, looseSongTitle(title) || title, songTitleLike(title) || title], title);
    if (rows.length > 0) await backfillTitleTokens(db, kind, rows);
  }

  const ranked = rankResolveRows(rows, title);

  /*
   * 名次定完才按主键把整行（含 payload）补回来 —— 索引那几步只碰 token 表，
   * 大字段一次都不读。只取 12 条候选，payload 的读取量从「全表」缩到这 12 条。
   */
  const full = await deps.hydrate(ranked.map(({ row }) => ({ kind, cache_key: String(row.cache_key ?? '') })));

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
      words: deps.isRecord(payload) ? deps.readWords(payload) : [],
    };
  });
};
