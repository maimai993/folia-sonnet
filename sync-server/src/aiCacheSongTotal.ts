// sync-server/src/aiCacheSongTotal.ts
// `/songs` 那个「云端现在有多少首不同的歌」的短时缓存。
//
// 这个数只有一个来源：`COUNT(DISTINCT song_title)`，4 万条要 5.6ms（要把歌名索引整个
// 读一遍去重），而 `/songs` 的分页本身只要 0.15ms。每请求算一次的话它就是那条接口的
// 全部成本，并发时还要在同步驱动里排队 —— 压测里 `/songs` p50 44ms 大部分是它。
// 歌名总数变得很慢（只有新歌进库才变），缓存几秒用户看不出来。

import type { D1Database } from './app.js';

const SONG_TOTAL_TTL_MS = 5_000;

/*
 * 按数据库实例分别记：同一进程里 Node 只有一个库，但测试会在一个进程里开好几个，
 * 用一个全局变量就会串味。
 */
const songTotals = new WeakMap<D1Database, { total: number; at: number }>();

/** 读总数（带缓存）。`/songs` 不带 `q` 时用它。 */
export const readSongTotal = async (db: D1Database): Promise<{ total: number } | null> => {
  const cached = songTotals.get(db);
  const now = Date.now();
  if (cached && now - cached.at < SONG_TOTAL_TTL_MS) return { total: cached.total };
  const row = await db
    .prepare("SELECT COUNT(DISTINCT song_title) AS total FROM ai_cache WHERE song_title IS NOT NULL AND song_title <> ''")
    .first<{ total: number }>();
  const total = Number(row?.total ?? 0);
  songTotals.set(db, { total, at: now });
  return { total };
};

/**
 * 让缓存立刻作废。
 *
 * 写入、删除、恢复旧版之后都要调：否则「刚推上去就刷新 /songs」看不到自己那首
 * （最长要等一个 TTL）。
 */
export const invalidateSongTotalCache = (db: D1Database): void => {
  songTotals.delete(db);
};
