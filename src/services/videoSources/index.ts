// src/services/videoSources/index.ts
// 影视源的聚合层：把一份 TVBox 配置里的 sites 分成「能在本机直接跑」和「需要内置 spider」两类，
// 并对可用站点做聚合搜索。判断规则只有一条事实：type 0（xml cms）与 type 1（json cms）走的是
// 标准 HTTP 接口，本机能直接请求；type 3（内置 spider）与 type 4（远程 spider）要跑配置自带的
// spider 包（一个只有 ARM 架构的 so + 加密 dex），本机加载不了，因此标成不可用并在界面上说明原因。
// 这里不假装支持它们：不可用就是不可用，搜索结果里也不会混进它们的条目。

import type { VideoSite, VideoConfig } from './config';
import { listCms, searchCms, type CmsVideo, type CmsCategory } from './cms';

export type { VideoSite, VideoConfig } from './config';
export { loadVideoConfig } from './config';
export { buildCmsUrl, detailCms, listCms, parsePlayLines, searchCms } from './cms';
export type { CmsCategory, CmsEpisode, CmsPlayLine, CmsVideo } from './cms';

/** 站点在本机的可用性。 */
export type SiteAvailability = {
    site: VideoSite;
    /** 能不能直接请求。 */
    usable: boolean;
    /** 不能用的原因（给界面显示），能用时为 undefined。 */
    reason?: string;
};

/**
 * 内置的兜底站点：标准 JSON CMS 接口（TVBox 的 type 1），本机直接能请求、能搜索、能取到 m3u8。
 * 只在「用户填的那份配置一个可用站点都没有」时启用——那种情况（比如配置里全是内置 spider）
 * 界面会先说明原因，再落到这组源上，让人至少能搜到、能点开看，而不是停在一句"不支持"。
 */
export const BUILTIN_SITES: VideoSite[] = [
    { key: 'builtin-lz', name: '量子资源', type: 1, api: 'https://cj.lziapi.com/api.php/provide/vod/' },
    { key: 'builtin-ff', name: '非凡资源', type: 1, api: 'https://api.ffzyapi.com/api.php/provide/vod/' },
    { key: 'builtin-wj', name: '无尽资源', type: 1, api: 'https://api.wujinapi.com/api.php/provide/vod/' },
    { key: 'builtin-bf', name: '暴风资源', type: 1, api: 'https://bfzyapi.com/api.php/provide/vod/' },
    { key: 'builtin-gs', name: '光速资源（4K）', type: 1, api: 'https://api.guangsuapi.com/api.php/provide/vod/' },
    { key: 'builtin-js', name: '极速资源', type: 1, api: 'https://jszyapi.com/api.php/provide/vod/' },
    { key: 'builtin-bd', name: '百度资源', type: 1, api: 'https://api.apibdzy.com/api.php/provide/vod/' },
];

/**
 * 站点分类。0/1 是标准接口；3 是内置 spider；4 是远程 spider 服务（要走配置里的 spider 包）。
 * 其它类型（比如 2）TVBox 里也有，但我们没有对应实现，按不可用处理。
 */
export const classifySites = (config: VideoConfig): SiteAvailability[] => config.sites.map(site => {
    if (site.type === 0 || site.type === 1) return { site, usable: true };
    if (site.type === 3) {
        return { site, usable: false, reason: '该站点由配置自带的 spider 提供（内置 spider），需要跑配置里的 ARM 程序，本机不支持' };
    }
    if (site.type === 4) {
        return { site, usable: false, reason: '该站点走远程 spider 服务，需要先自行部署 spider 服务端' };
    }
    return { site, usable: false, reason: `不支持的站点类型 ${site.type}` };
});

/** 可搜索的站点：能用、且配置里没有明确关掉搜索。 */
export const searchableSites = (config: VideoConfig): VideoSite[] => (
    classifySites(config)
        .filter(item => item.usable && item.site.searchable !== 0)
        .map(item => item.site)
);

/**
 * 实际要用的站点清单。
 * 配置里有能直接跑的站点就用配置的；一个都没有（这份配置 49 个站点全是要 spider 的 type 3 就是
 * 这种情况）就落到内置源，并标出 fallback，让界面能说明"配置里没有可用站点，已切到内置源"。
 */
export const resolveSites = (config: VideoConfig | null): {
    sites: VideoSite[];
    usable: number;
    total: number;
    fallback: boolean;
} => {
    if (!config) return { sites: BUILTIN_SITES, usable: BUILTIN_SITES.length, total: BUILTIN_SITES.length, fallback: true };
    const classified = classifySites(config);
    const usableSites = classified.filter(item => item.usable).map(item => item.site);
    if (usableSites.length === 0) {
        return { sites: BUILTIN_SITES, usable: BUILTIN_SITES.length, total: classified.length, fallback: true };
    }
    return { sites: usableSites, usable: usableSites.length, total: classified.length, fallback: false };
};

/** 聚合搜索的一条结果：带上它来自哪个站点。 */
export type VideoSearchHit = CmsVideo & {
    siteKey: string;
    siteName: string;
};

/** 聚合搜索的结果（含每个站点的失败原因，界面据此提示"某站没搜到"）。 */
export type VideoSearchResult = {
    hits: VideoSearchHit[];
    /** 请求失败的站点与原因。 */
    failures: Array<{ siteName: string; message: string }>;
    /** 真正发起请求的站点数。 */
    siteCount: number;
};

/** 单站超时（毫秒）：一个站卡住不该拖垮整次搜索。 */
const SITE_TIMEOUT = 8000;

const withTimeout = async <T,>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SITE_TIMEOUT);
    try {
        return await run(controller.signal);
    } finally {
        clearTimeout(timer);
    }
};

/**
 * 在给定站点里并行搜索。单个站点失败只记进 failures，不影响其它站点。
 * 同一部剧在多个站点出现时都保留（站点不同、播放地址不同，选哪个是用户的事）。
 */
export const searchVideosInSites = async (sites: VideoSite[], keyword: string): Promise<VideoSearchResult> => {
    const targets = sites.filter(site => (site.type === 0 || site.type === 1) && site.searchable !== 0);
    if (targets.length === 0) return { hits: [], failures: [], siteCount: 0 };

    const settled = await Promise.all(targets.map(async site => {
        try {
            const { videos } = await withTimeout(signal => {
                // type 0 的站点常把 api 写成 `.../api.php/provide/vod/`，type 1 的也一样；
                // 少数老接口用 `?ac=videolist`，这里不猜，按 V10 的标准参数发。
                return searchCms(site.api, keyword, signal);
            });
            return { site, videos, error: null as string | null };
        } catch (error) {
            const message = error instanceof Error && error.name === 'AbortError'
                ? `超时（${SITE_TIMEOUT / 1000} 秒）`
                : error instanceof Error ? error.message : String(error);
            return { site, videos: [] as CmsVideo[], error: message };
        }
    }));

    const hits: VideoSearchHit[] = [];
    const failures: VideoSearchResult['failures'] = [];
    for (const item of settled) {
        if (item.error) failures.push({ siteName: item.site.name, message: item.error });
        for (const video of item.videos) {
            hits.push({ ...video, siteKey: item.site.key, siteName: item.site.name });
        }
    }
    return { hits, failures, siteCount: targets.length };
};

/** 按一份配置搜索（内部先过一遍站点可用性，必要时落到内置源）。 */
export const searchVideos = async (config: VideoConfig | null, keyword: string): Promise<VideoSearchResult> => (
    searchVideosInSites(resolveSites(config).sites, keyword)
);

/** 取某个可用站点的列表与分类（用于首页的分类条与海报流）。 */
export const browseSite = async (
    site: VideoSite,
    options: { categoryId?: string; page?: number } = {},
): Promise<{ videos: CmsVideo[]; categories: CmsCategory[] }> => {
    if (site.type !== 0 && site.type !== 1) throw new Error('该站点需要 spider，本机不支持');
    return withTimeout(signal => listCms(site.api, { ...options, signal }));
};
