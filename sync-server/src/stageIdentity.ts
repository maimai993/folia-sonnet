import { md5 } from './md5.js';

// sync-server/src/stageIdentity.ts
// 完整歌名与结构化艺人身份；保留版本文字，不拆分组合名。
const normalize = (value: string): string => value.normalize('NFKC').trim().toLowerCase()
  .replace(/\s+/gu, ' ').replace(/\s*([()[\]{}])\s*/gu, '$1');

export const normalizeStageIdentity = (input: { title?: unknown; artists?: unknown }): {
  key: string; title: string; artists: string[];
} | null => {
  if (typeof input.title !== 'string' || !Array.isArray(input.artists)
    || input.artists.length === 0 || input.artists.some((value) => typeof value !== 'string' || !value.trim())) return null;
  const title = normalize(input.title);
  const artists = [...new Set((input.artists as string[]).map(normalize))].sort();
  if (!title || !artists.length || artists.some((artist) => !artist)) return null;
  return { key: md5(JSON.stringify(['stage-song-v1', title, artists])), title, artists };
};
