import { md5 } from '../../utils/md5';

// src/services/stageCache/identity.ts — 跨平台歌曲身份，只规范格式，保留完整版本与组合名。
export interface StageIdentity { key: string; title: string; artists: string[] }
export interface StageIdentityInput { title?: unknown; artists?: readonly unknown[] }

const normalize = (value: string): string => value.normalize('NFKC').toLowerCase()
    .replace(/\s+/gu, ' ').replace(/\s*([()[\]{}])\s*/gu, '$1').trim();

export const normalizeStageIdentity = (input: StageIdentityInput): StageIdentity | null => {
    if (typeof input.title !== 'string' || !Array.isArray(input.artists)) return null;
    const title = normalize(input.title);
    // 不将字符串分隔符解释为艺术家列表，也不接受部分损坏的署名。
    if (!title || input.artists.some(artist => typeof artist !== 'string' || !normalize(artist))) return null;
    const artists = [...new Set(input.artists.map(artist => normalize(artist as string)))].sort();
    if (!artists.length) return null;
    return { key: md5(JSON.stringify(['stage-song-v1', title, artists])), title, artists };
};

export const stageCacheNamespace = (baseUrl: string): string => baseUrl.trim().replace(/\/+$/u, '');
