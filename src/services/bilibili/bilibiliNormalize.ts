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

/**
 * 一条投稿（或它的一个分P）在本应用里的 id。
 *
 * 分P 写进 id 是因为**同一个 bvid 下的每一集播放地址都不一样**（cid 不同）。
 * 只带 bvid 的话，一个多P 投稿的所有集数在应用眼里是同一首歌：队列里会去重、
 * 切集时进度不会重置、缓存也会互相顶掉。带上 cid 它们才是各自独立的歌。
 */
export const bilibiliSongId = (bvid: string, cid?: number | null): string => (
    typeof cid === 'number' && cid > 0 ? `${BILIBILI_ID_PREFIX}${bvid}:${cid}` : `${BILIBILI_ID_PREFIX}${bvid}`
);

/** 从 id 里取回 bvid；不是本平台的 id 就回空串。 */
export const bilibiliBvidOf = (song: { id?: string | number } | null | undefined): string => {
    const id = String(song?.id ?? '');
    if (!id.startsWith(BILIBILI_ID_PREFIX)) return '';
    const rest = id.slice(BILIBILI_ID_PREFIX.length);
    // 分P 的 id 是 `BV...:cid`，取冒号前那截。
    const colon = rest.indexOf(':');
    return colon >= 0 ? rest.slice(0, colon) : rest;
};

/** 从 id 里取回分P 的 cid；单P 的 id 没有这一段，回 null。 */
/**
 * 一个 UP 主在别的模块眼里的 id。
 *
 * 投稿里 UP 主是这首歌的 artist，所以歌手页也用同一个 id：`bilibili-artist:<mid>`。
 * 前缀保证和歌曲 id（`bilibili:<bvid>[:<cid>]`）不会撞上，取 mid 时按前缀剥。
 */
export const bilibiliArtistId = (mid: string | number): string => `bilibili-artist:${mid}`;

/** 从歌手 id 里取回 mid；不是这个平台的就回空串。 */
export const bilibiliMidOfArtistId = (id: string | number | null | undefined): string => {
    const text = String(id ?? '');
    const prefix = 'bilibili-artist:';
    return text.startsWith(prefix) ? text.slice(prefix.length) : '';
};

export const bilibiliCidOf = (song: { id?: string | number } | null | undefined): number | null => {
    const id = String(song?.id ?? '');
    if (!id.startsWith(BILIBILI_ID_PREFIX)) return null;
    const rest = id.slice(BILIBILI_ID_PREFIX.length);
    const colon = rest.indexOf(':');
    if (colon < 0) return null;
    const cid = Number(rest.slice(colon + 1));
    return Number.isFinite(cid) && cid > 0 ? cid : null;
};

/**
 * 封面地址统一成完整的 https。
 *
 * 这一家的图片地址有三种写法，一种都不能漏：
 *  · `http://i0.hdslb.com/...` —— 明文，WebView 里会被拦；
 *  · `//i0.hdslb.com/...` —— 协议相对。`<img src>` 在页面里还能拼出来，但封面这条路
 *    会先经过 `new URL()` 和 `Image()` 的预解码，那里 `//host` 不是合法地址，
 *    解码直接失败并被记进「这个地址不会再成功」的表里 —— 墙上的卡片就永远空着。
 *    这就是「播放栏有封面、海报墙没有」的真因。
 *  · 完整 https —— 原样留着。
 */
export const upgradeCoverUrl = (url: string | undefined): string => {
    if (!url) return '';
    if (url.startsWith('//')) return `https:${url}`;
    return url.startsWith('http://') ? `https://${url.slice('http://'.length)}` : url;
};

/**
 * 一条投稿 → UnifiedSong。
 *
 * 时长按这个应用的习惯用毫秒（接口给的是秒）。UP 主当歌手，专辑留空 ——
 * 投稿没有专辑这回事，硬塞一个只会让「打开专辑」指到不存在的地方。
 */
export const normalizeBilibiliSong = (
    hit: BilibiliSearchHit,
    /** 多P 投稿里的某一集；不传就是这条投稿本身。 */
    page?: { cid: number; title: string; durationSec: number },
): UnifiedSong => ({
    id: bilibiliSongId(hit.bvid, page?.cid),
    // 分P 用自己那一集的名字，单P 用投稿标题。
    name: page?.title || hit.title,
    artists: hit.author ? [{ id: `bilibili-author:${hit.author}`, name: hit.author }] : [],
    // 封面挂在专辑上：播放页和播放栏都是从那里取的。投稿没有专辑，名字留空。
    album: { id: '', name: '', coverUrl: upgradeCoverUrl(hit.coverUrl) || undefined },
    // 时长按这个应用的习惯用毫秒（接口给的是秒）。
    durationMs: Math.max(0, Math.round((page?.durationSec ?? hit.durationSec) * 1000)),
    // 不设 isVideo：这个字段在别处是「这首歌有一条对应的 MV」的意思（队列、搜索结果行
    // 都拿它显示一个 "MV" 角标）。B 站这里放的就是投稿本身，不是某个别的平台的歌的 MV，
    // 打上那个角标只会让人以为还有一份别的视频。
    sourceRef: { kind: 'online', providerId: 'bilibili', mediaId: hit.bvid },
});
