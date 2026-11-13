import type { UnifiedSong } from '../../types';
import type { BilibiliSearchHit } from '../../types/bilibili';

// src/services/bilibili/bilibiliNormalize.ts
// 把一条投稿变成这个应用里的「一首歌」。
//
// 为什么当歌：播放、进度、标题、封面、队列、上/下一首，全套设施都是围绕 UnifiedSong 建的。
// 视频挂进这套设施里，就不必再写一条平行的播放路径 —— 点一条视频就是 `playSong`，
// 进度条、歌词时钟、可视化全都跟着走。
//
// 它没有歌词，也没有「收藏」这回事（见 provider 的 capabilities）。

/** provider 内部认这个前缀，用它把 id 和别的平台的歌分开。 */
const BILIBILI_ID_PREFIX = 'bilibili:';

/** 一个投稿在本应用里的 id。 */
export const bilibiliSongId = (bvid: string): string => `${BILIBILI_ID_PREFIX}${bvid}`;

/** 从 id 里取回 bvid；不是本平台的 id 就回空串。 */
export const bilibiliBvidOf = (song: { id?: string | number } | null | undefined): string => {
    const id = String(song?.id ?? '');
    return id.startsWith(BILIBILI_ID_PREFIX) ? id.slice(BILIBILI_ID_PREFIX.length) : '';
};

/** 图片地址可能是 http（WebView 里会被拦），统一升成 https。 */
export const upgradeCoverUrl = (url: string | undefined): string => {
    if (!url) return '';
    return url.startsWith('http://') ? `https://${url.slice('http://'.length)}` : url;
};

/**
 * 一条投稿 → UnifiedSong。
 *
 * 时长按这个应用的习惯用毫秒（接口给的是秒）。UP 主当歌手，专辑留空 ——
 * 投稿没有专辑这回事，硬塞一个只会让「打开专辑」指到不存在的地方。
 */
export const normalizeBilibiliSong = (hit: BilibiliSearchHit): UnifiedSong => ({
    id: bilibiliSongId(hit.bvid),
    name: hit.title,
    artists: hit.author ? [{ id: `bilibili-author:${hit.author}`, name: hit.author }] : [],
    // 封面挂在专辑上：播放页和播放栏都是从那里取的。投稿没有专辑，名字留空。
    album: { id: '', name: '', coverUrl: upgradeCoverUrl(hit.coverUrl) || undefined },
    // 时长按这个应用的习惯用毫秒（接口给的是秒）。
    durationMs: Math.max(0, Math.round(hit.durationSec * 1000)),
    isVideo: true,
    sourceRef: { kind: 'online', providerId: 'bilibili', mediaId: hit.bvid },
});
