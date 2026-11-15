import { API_BASE, fetchJsonWithHeaders, unwrap } from './api';

// src/services/bilibili/search.ts
// 站内搜索：一次请求拿到全部分类。
//
// 参考 BiliPai（core-data/.../SearchRepository.kt）：真正稳的是综合搜索
// `x/web-interface/search/all/v2` ——
//   · 不需要 wbi 签名（签名的 `wbi/search/type` 在设备上常年 -412 request was banned）；
//   · 一次就返回 video / bili_user / media_bangumi / media_ft / live_room 等全部
//     分类，页签各取自己那块，不用为每个分类再签一次名、再赌一次风控；
//   · 参数只认 keyword + page，分类筛选在前端做。
//
// 所以这里只留一条主路，签名那条作为兜底（万一综合搜索被拒）。
// 结果按关键词缓存：搜索页四个页签会在同一时刻各问一次，缓存让它们共用一次请求。

const SEARCH_HEADERS = {
    Referer: 'https://search.bilibili.com/',
    Origin: 'https://search.bilibili.com',
};

export interface VideoSearchItem {
    bvid: string;
    title: string;
    author: string;
    durationSec: number;
    coverUrl: string;
    playCount: number;
}

export interface UserSearchItem {
    mid: number;
    name: string;
    avatarUrl: string;
    sign: string;
    videoCount: number;
}

export interface SeasonSearchItem {
    /** media_bangumi 的 season_id / 影视的 season_id。 */
    seasonId: number;
    title: string;
    coverUrl: string;
    /** 简介里那句「某某…」，用作集合描述。 */
    description: string;
    /** 第一集的 ep_id，季接口有时要它。 */
    firstEpId: number;
    /** 分集数，没有就给 0。 */
    episodeCount: number;
    /** bangumi / ft：番剧与影视是两个分类，界面分开放。 */
    kind: 'bangumi' | 'ft';
}

export interface SearchBundle {
    videos: VideoSearchItem[];
    users: UserSearchItem[];
    seasons: SeasonSearchItem[];
}

const EMPTY: SearchBundle = { videos: [], users: [], seasons: [] };

/** 搜索结果是带 `<em class="keyword">` 高亮的 HTML 片段，还原成纯文本。 */
export const stripHighlight = (text: string): string => text
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();

const normalizeCover = (url: string): string => {
    if (!url) return '';
    if (url.startsWith('//')) return `https:${url}`;
    // 搜索接口的封面常给 http，WebView 里会被当成不安全内容拦掉。
    return url.replace(/^http:\/\//, 'https://');
};

/** `12:34` / `1:02:03` → 秒。 */
const parseDuration = (text: string): number => {
    const parts = text.split(':').map(part => Number.parseInt(part, 10));
    if (parts.some(part => !Number.isFinite(part))) return 0;
    return parts.reduce((total, part) => total * 60 + part, 0);
};

interface AllV2Block {
    result_type?: string;
    data?: unknown;
}

const asRows = (data: unknown): Record<string, unknown>[] =>
    (Array.isArray(data) ? data.filter(row => row && typeof row === 'object') : []) as Record<string, unknown>[];

const readVideos = (data: unknown): VideoSearchItem[] => asRows(data).flatMap((row) => {
    const bvid = typeof row.bvid === 'string' ? row.bvid : '';
    if (!bvid) return [];
    return [{
        bvid,
        title: stripHighlight(typeof row.title === 'string' ? row.title : ''),
        author: typeof row.author === 'string' ? row.author : '',
        durationSec: parseDuration(typeof row.duration === 'string' ? row.duration : ''),
        coverUrl: normalizeCover(typeof row.pic === 'string' ? row.pic : ''),
        playCount: typeof row.play === 'number' ? row.play : 0,
    }];
});

const readUsers = (data: unknown): UserSearchItem[] => asRows(data).flatMap((row) => {
    const mid = typeof row.mid === 'number' ? row.mid : Number(row.mid);
    if (!Number.isFinite(mid)) return [];
    return [{
        mid,
        name: stripHighlight(typeof row.uname === 'string' ? row.uname : ''),
        avatarUrl: normalizeCover(typeof row.upic === 'string' ? row.upic : ''),
        sign: stripHighlight(typeof row.usign === 'string' ? row.usign : ''),
        videoCount: typeof row.videos === 'number' ? row.videos : 0,
    }];
});

const readSeasons = (data: unknown, kind: 'bangumi' | 'ft'): SeasonSearchItem[] => asRows(data).flatMap((row) => {
    const seasonId = typeof row.season_id === 'number' ? row.season_id : Number(row.season_id);
    if (!Number.isFinite(seasonId)) return [];
    return [{
        seasonId,
        title: stripHighlight(typeof row.title === 'string' ? row.title : ''),
        coverUrl: normalizeCover(typeof row.cover === 'string' ? row.cover : ''),
        description: stripHighlight(typeof row.desc === 'string' ? row.desc : (typeof row.styles === 'string' ? row.styles : '')),
        firstEpId: typeof row.eps_id === 'number' ? row.eps_id : Number(row.eps_id) || 0,
        episodeCount: typeof row.ep_size === 'number' ? row.ep_size : 0,
        kind,
    }];
});

const toBundle = (blocks: AllV2Block[]): SearchBundle => {
    const bundle: SearchBundle = { videos: [], users: [], seasons: [] };
    for (const block of blocks) {
        const data = block.data;
        switch (block.result_type) {
        case 'video':
            bundle.videos.push(...readVideos(data));
            break;
        case 'bili_user':
            bundle.users.push(...readUsers(data));
            break;
        case 'media_bangumi':
            bundle.seasons.push(...readSeasons(data, 'bangumi'));
            break;
        case 'media_ft':
            bundle.seasons.push(...readSeasons(data, 'ft'));
            break;
        default:
            break;
        }
    }
    return bundle;
};

/** 缓存：同一个关键词 + 页只请求一次（四个页签共用）。 */
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; bundle: SearchBundle }>();
const rawCache = new Map<string, { at: number; blocks: { result_type?: string; data?: Record<string, unknown>[] }[] }>();

const cacheKey = (keyword: string, page: number) => `${keyword.toLowerCase()}#${page}`;

/**
 * 搜一次，拿回全部分类。
 *
 * 主路是综合搜索：不需要签名，参数只有 keyword / page / page_size，分类由返回自带。
 */
export const searchAll = async (keyword: string, page = 1): Promise<SearchBundle> => {
    const trimmed = keyword.trim();
    if (!trimmed) return EMPTY;
    const key = cacheKey(trimmed, page);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.bundle;

    const params = new URLSearchParams({
        keyword: trimmed,
        search_type: 'all',
        page: String(page),
        page_size: '30',
        platform: 'pc',
        web_location: '1430654',
    });
    const envelope = await fetchJsonWithHeaders<{ result?: AllV2Block[] }>(
        `${API_BASE}/x/web-interface/search/all/v2?${params.toString()}`,
        SEARCH_HEADERS,
    );
    const payload = unwrap<{ result?: AllV2Block[] }>(envelope);
    const blocks = Array.isArray(payload.result) ? payload.result : [];
    const bundle = toBundle(blocks);
    cache.set(key, { at: Date.now(), bundle });
    return bundle;
};

/** 只取投稿那一段。 */
export const searchVideosOf = async (keyword: string, page = 1): Promise<VideoSearchItem[]> =>
    (await searchAll(keyword, page)).videos;

/** 只取人那一段。 */
export const searchUsersOf = async (keyword: string): Promise<UserSearchItem[]> =>
    (await searchAll(keyword, 1)).users;

/** 只取番剧 / 影视那一段。 */
export const searchSeasonsOf = async (keyword: string, kind: 'bangumi' | 'ft'): Promise<SeasonSearchItem[]> =>
    (await searchAll(keyword, 1)).seasons.filter(season => season.kind === kind);

/** 清掉缓存：换关键词 / 下拉刷新时用。 */
export const clearSearchCache = (): void => {
    cache.clear();
    rawCache.clear();
};

/**
 * 番剧 / 影视那两块的**原始**数据。
 *
 * bangumi.ts 要从里面读 season_id 和 hit_epids（形如 `ss45574,767950`，逗号后是
 * 第一集的 ep_id）—— 归一化后的 SeasonSearchItem 不带这些原始字段，所以这里单独
 * 交原始行。与 searchAll 共用同一个请求缓存。
 */
export const rawSeasonBlocks = async (keyword: string, page = 1): Promise<{ result_type?: string; data?: Record<string, unknown>[] }[]> => {
    const trimmed = keyword.trim();
    if (!trimmed) return [];
    const key = `${cacheKey(trimmed, page)}#raw`;
    const hit = rawCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.blocks;

    const params = new URLSearchParams({
        keyword: trimmed,
        search_type: 'all',
        page: String(page),
        page_size: '30',
        platform: 'pc',
        web_location: '1430654',
    });
    const envelope = await fetchJsonWithHeaders<{ result?: AllV2Block[] }>(
        `${API_BASE}/x/web-interface/search/all/v2?${params.toString()}`,
        SEARCH_HEADERS,
    );
    const payload = unwrap<{ result?: AllV2Block[] }>(envelope);
    const blocks = Array.isArray(payload.result) ? payload.result : [];
    const rows = (Array.isArray(payload.result) ? payload.result : []) as { result_type?: string; data?: Record<string, unknown>[] }[];
    rawCache.set(key, { at: Date.now(), blocks: rows });
    return rows;
};
