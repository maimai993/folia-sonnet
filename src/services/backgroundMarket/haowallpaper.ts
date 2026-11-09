// src/services/backgroundMarket/haowallpaper.ts
//
// haowallpaper（哲风壁纸）：视频 + 图片混合源，Nuxt 站点。
//
// 结构（实测确认）：
//   列表  https://haowallpaper.com/homeView?page=N
//         页面内嵌 schema.org 的 ItemList（12 条/页），比正则切 HTML 稳得多
//   详情  /homeViewLook/<id>
//   缩略  https://img.haowallpaper.com/cache_file/.../<fileId>.png      约 24 KB webp
//   视频  https://img.haowallpaper.com/pre_cache_file/.../<fileId>.mp4  约 288 KB
//
// 注意一个坑：列表与详情的图片都只有约 24 KB 的**压缩版**，高清原图要登录才给。
// 所以这个源在「桌面壁纸」这个大尺寸场景下画质有限，界面要如实标注。

import type { BackgroundMarketItem, BackgroundMarketPage } from './types';
import { fetchHtml } from './http';

const BASE = 'https://haowallpaper.com';
const IMG_BASE = 'https://img.haowallpaper.com';
const SOURCE_LABEL = '哲风壁纸';

export const HAOWALLPAPER_SOURCE = {
    id: 'haowallpaper' as const,
    label: SOURCE_LABEL,
    kinds: ['video' as const, 'image' as const],
    supportsSearch: true,
};

/** 列表页只给 12 条，所以「拿满 12 条」≈ 还有下一页。 */
const PAGE_SIZE = 12;

/** 从缩略图地址里取 fileId：`.../2025_10_20_file/17815907003452800.png` → `17815907003452800`。 */
const fileIdOf = (imageUrl: string): string | undefined => (
    /\/(\d+)\.(?:png|jpe?g|webp)$/i.exec(imageUrl)?.[1]
);

/** 从缩略图地址里取日期目录：`2025_10_20_file`。 */
const dateDirOf = (imageUrl: string): string | undefined => (
    /\/(\d{4}_\d{2}_\d{2}_file)\//.exec(imageUrl)?.[1]
);

/**
 * 视频地址。
 *
 * 列表页给的是 `video_reduce_file`（压缩版，实测 44 KB），详情页里还有一份
 * `pre_cache_file`（约 288 KB，更清楚）。两者都对同一 fileId 可用，这里取大那份 ——
 * 壁纸要铺满屏幕，压缩得太狠会糊。
 */
export const haowallpaperVideoUrl = (thumbnailUrl: string): string | null => {
    const fileId = fileIdOf(thumbnailUrl);
    const dateDir = dateDirOf(thumbnailUrl);
    if (!fileId || !dateDir) return null;
    return `${IMG_BASE}/pre_cache_file/${dateDir}/${fileId}.mp4`;
};

const listUrl = (page: number, keyword: string): string => {
    const params = new URLSearchParams();
    if (page > 1) params.set('page', String(page));
    if (keyword) params.set('search', keyword);
    const query = params.toString();
    return `${BASE}/homeView${query ? `?${query}` : ''}`;
};

/**
 * 解析列表页。
 *
 * 用页面内嵌的 schema.org ItemList：它有 name / url / image 三个我们要的字段，
 * 而且是给搜索引擎看的结构化数据，比正则切 <div> 稳定。
 */
export const parseHaowallpaperList = (html: string, page: number): BackgroundMarketPage => {
    const listBlock = /"@type":"ItemList"[\s\S]*?itemListElement":\[([\s\S]*?)\]\}/.exec(html)?.[1] ?? '';
    const entries = [...listBlock.matchAll(/"url":"([^"]+)"[\s\S]*?"name":"([^"]*)"[\s\S]*?"image":"([^"]*)"/g)];

    /*
     * 视频判断：列表页里有 `<video src="...video_reduce_file/...">` 的条目就是动态壁纸，
     * 它的 fileId 与封面图相同，所以按 fileId 配对即可。
     *
     * 注意目录名不是 pre_cache_file —— 那个只出现在详情页，列表页用的是 video_reduce_file。
     */
    const videoFileIds = new Set(
        [...html.matchAll(/video_reduce_file\/(?:\d{4}_\d{2}_\d{2}_file\/)?(\d+)\.mp4/g)].map((m) => m[1]),
    );

    const items: BackgroundMarketItem[] = [];
    for (const entry of entries) {
        const detailUrl = entry[1];
        const rawName = entry[2];
        const image = entry[3];
        const fileId = image ? fileIdOf(image) : undefined;
        if (!detailUrl || !image) continue;

        // 站点的名字都带「「哲风壁纸」」后缀，去掉后再当标题用。
        const name = rawName.replace(/「[^」]*」$/, '').trim() || detailUrl.split('/').pop() || '壁纸';
        const isVideo = Boolean(fileId && videoFileIds.has(fileId));

        items.push({
            id: `haowallpaper:${fileId ?? detailUrl}`,
            source: 'haowallpaper',
            sourceLabel: SOURCE_LABEL,
            name,
            kind: isVideo ? 'video' : 'image',
            thumbnailUrl: image,
            detailUrl,
            mediaUrl: isVideo ? (haowallpaperVideoUrl(image) ?? undefined) : image,
        });
    }

    return { items, hasMore: entries.length >= PAGE_SIZE, page };
};

export const fetchHaowallpaperPage = async (
    page: number,
    keyword = '',
    signal?: AbortSignal,
): Promise<BackgroundMarketPage> => {
    const response = await fetchHtml(listUrl(page, keyword), { 'Accept-Language': 'zh-CN,zh;q=0.9' }, signal);
    if (!response.ok) {
        throw new Error(`哲风壁纸列表请求失败（HTTP ${response.status}）`);
    }
    return parseHaowallpaperList(await response.text(), page);
};
