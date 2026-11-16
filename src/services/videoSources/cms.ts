// src/services/videoSources/cms.ts
// 苹果 CMS V10 接口（TVBox 的 type 0 / 1 站点走的就是它）：`/api.php/provide/vod/`，
// `ac=list` 取分类与列表、`ac=detail` 取详情（含播放地址），参数 `t`（分类）、`pg`（页）、`wd`（搜索词）。
// 这里只做「拼地址 + 解析返回」，不做站点筛选；返回的字段按接口真实字段名取，缺的给空串。
// 取数经 net.ts（桌面版由主进程转发，绕开第三方接口没有 CORS 头这件事）。

import { fetchVideoText, TVBOX_HEADERS } from './net';

/** 一条影片（列表与详情共用）。 */
export type CmsVideo = {
    id: string;
    name: string;
    pic: string;
    /** 备注，一般是「更新至第 12 集」「HD」这类。 */
    remarks: string;
    /** 分类名（详情才有）。 */
    typeName: string;
    /** 年份、地区、演员、简介（详情才有）。 */
    year: string;
    area: string;
    actor: string;
    content: string;
    /** 分线路的播放地址串（详情才有），未解析。 */
    playFrom: string;
    playUrl: string;
};

/** 解析后的一集。 */
export type CmsEpisode = {
    name: string;
    url: string;
};

/** 一条播放线路。 */
export type CmsPlayLine = {
    /** 线路名（`vod_play_from` 里对应的那一段，如「量子」「非凡」）。 */
    name: string;
    episodes: CmsEpisode[];
};

const asText = (value: unknown): string => (
    typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
);
export type CmsCategory = { id: string; name: string };

const toVideo = (row: Record<string, unknown>): CmsVideo => ({
    id: asText(row.vod_id),
    name: asText(row.vod_name),
    pic: asText(row.vod_pic),
    remarks: asText(row.vod_remarks),
    typeName: asText(row.type_name) || asText(row.vod_class),
    year: asText(row.vod_year),
    area: asText(row.vod_area),
    actor: asText(row.vod_actor),
    content: asText(row.vod_content),
    playFrom: asText(row.vod_play_from),
    playUrl: asText(row.vod_play_url),
});

/**
 * 拼请求地址。api 可能已经带着 `/api.php/provide/vod/`，也可能只到域名，
 * 也可能带自己的查询串（`?ac=list`），这里都接着处理。
 */
export const buildCmsUrl = (api: string, params: Record<string, string | number | undefined>): string => {
    const base = api.trim();
    const separator = base.includes('?') ? '&' : '?';
    const query = Object.entries(params)
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join('&');
    return query ? `${base}${separator}${query}` : base;
};

/** 接口返回的外壳：`{ code, msg, list, class }`。code 不为 1 时按接口自己的 msg 报错。 */
const readEnvelope = (payload: unknown): { list: Record<string, unknown>[]; categories: CmsCategory[] } => {
    if (!payload || typeof payload !== 'object') return { list: [], categories: [] };
    const row = payload as Record<string, unknown>;
    const list = Array.isArray(row.list) ? row.list.filter(item => item && typeof item === 'object') : [];
    const categories = Array.isArray(row.class)
        ? row.class
            .filter(item => item && typeof item === 'object')
            .map(item => item as Record<string, unknown>)
            .map(item => ({ id: asText(item.type_id), name: asText(item.type_name) }))
            .filter(item => item.id && item.name)
        : [];
    return { list: list as Record<string, unknown>[], categories };
};

const fetchJson = async (url: string, signal?: AbortSignal): Promise<unknown> => {
    const response = await fetchVideoText(url, signal, TVBOX_HEADERS);
    if (!response.ok) throw new Error(`接口返回 HTTP ${response.status}`);
    const text = response.bodyText;
    try {
        return JSON.parse(text);
    } catch {
        throw new Error('接口返回的不是 JSON');
    }
};

/** 取列表（同时带回分类）。分类只有在接口真的给了 `class` 时才有。 */
export const listCms = async (
    api: string,
    options: { categoryId?: string; page?: number; signal?: AbortSignal } = {},
): Promise<{ videos: CmsVideo[]; categories: CmsCategory[] }> => {
    const url = buildCmsUrl(api, { ac: 'detail', t: options.categoryId, pg: options.page ?? 1 });
    const { list, categories } = readEnvelope(await fetchJson(url, options.signal));
    return { videos: list.map(toVideo).filter(video => video.id), categories };
};

/** 搜索。搜索词为空时返回空列表，不发请求。 */
export const searchCms = async (
    api: string,
    keyword: string,
    signal?: AbortSignal,
): Promise<{ videos: CmsVideo[]; categories: CmsCategory[] }> => {
    const word = keyword.trim();
    if (!word) return { videos: [], categories: [] };
    const url = buildCmsUrl(api, { ac: 'detail', wd: word });
    const { list, categories } = readEnvelope(await fetchJson(url, signal));
    return { videos: list.map(toVideo).filter(video => video.id), categories };
};

/** 取详情（含播放地址）。按 `ids` 批量取。 */
export const detailCms = async (api: string, ids: readonly string[], signal?: AbortSignal): Promise<CmsVideo[]> => {
    if (ids.length === 0) return [];
    const url = buildCmsUrl(api, { ac: 'detail', ids: ids.join(',') });
    const { list } = readEnvelope(await fetchJson(url, signal));
    return list.map(toVideo).filter(video => video.id);
};

/** 判定一个地址是不是能直接喂给播放器的媒体直链。 */
export const isMediaUrl = (url: string): boolean => /\.(m3u8|mp4|flv|webm|mov|mkv)($|\?)/i.test(url);

/**
 * 线路的「直链程度」：很多苹果 CMS 站会同时给一条「播放网页」线和一条真直链线，
 * 播放网页（`/share/xxx`）交给播放器只会黑屏，所以默认应该落在直链线上。
 */
const playLineScore = (line: CmsPlayLine): number => {
    const named = /m3u8|mp4|hls/i.test(line.name) ? 2 : 0;
    const direct = line.episodes.length > 0 && isMediaUrl(line.episodes[0].url) ? 1 : 0;
    return named + direct;
};

/**
 * 解析 `vod_play_url`。
 * 格式：线路之间用 `$$$` 分，集之间用 `#` 分，每一集是 `名字$地址`（名字可以没有）。
 * 线路名按顺序对应 `vod_play_from` 里用 `$$$` 分出来的那几段。
 * 返回前按直链程度稳定排序，第一条就是最可能直接播放的那条线。
 */
export const parsePlayLines = (video: Pick<CmsVideo, 'playFrom' | 'playUrl'>): CmsPlayLine[] => {
    const fromParts = video.playFrom ? video.playFrom.split('$$$') : [];
    const urlParts = video.playUrl ? video.playUrl.split('$$$') : [];
    const lines = urlParts.map((lineText, index) => {
        const name = (fromParts[index] || '').trim() || `线路 ${index + 1}`;
        const episodes = lineText
            .split('#')
            .map((episode, position) => {
                const text = episode.trim();
                if (!text) return null;
                const split = text.indexOf('$');
                const label = split >= 0 ? text.slice(0, split).trim() : '';
                const url = split >= 0 ? text.slice(split + 1).trim() : text;
                if (!url) return null;
                return { name: label || `第 ${position + 1} 集`, url };
            })
            .filter((episode): episode is CmsEpisode => episode !== null);
        return { name, episodes };
    }).filter(line => line.episodes.length > 0);
    return lines
        .map((line, index) => ({ line, index }))
        .sort((left, right) => (playLineScore(right.line) - playLineScore(left.line)) || (left.index - right.index))
        .map(item => item.line);
};
