// src/services/backgroundMarket/moewalls.ts
//
// Moewalls：视频壁纸源（WordPress + bimber 主题）。
//
// 三段地址，都是实测过的：
//   列表  https://moewalls.com/page/N/            每页 16 条，<article> 里带缩略图与分辨率
//   详情  详情页里 <a id="moe-download" data-url>  加密串，不需要解密
//   下载  https://go.moewalls.com/download.php?video={data-url}
//
// 详情页的 <video> 只有 preview/xxx.webm（小的），真正的高清必须走上面那个 download.php。
// 实测一例拿到 99 MB 的 4K mp4。

import type { BackgroundMarketItem, BackgroundMarketPage } from './types';
import { fetchHtml } from './http';

const BASE = 'https://moewalls.com';
const DOWNLOAD_BASE = 'https://go.moewalls.com';
const SOURCE_LABEL = 'Moewalls';

export const MOEWALLS_SOURCE = {
    id: 'moewalls' as const,
    label: SOURCE_LABEL,
    kinds: ['video' as const],
    supportsSearch: false,
};

/**
 * 分类：界面上让用户能挑。
 *
 * slug 取自站点导航，都是真实存在的路径段。
 */
export const MOEWALLS_CATEGORIES = [
    { slug: '', label: '最新' },
    { slug: 'anime', label: '动漫' },
    { slug: 'games', label: '游戏' },
    { slug: 'fantasy', label: '奇幻' },
    { slug: 'nature', label: '自然' },
    { slug: 'cars', label: '汽车' },
    { slug: 'sci-fi', label: '科幻' },
    { slug: 'technology', label: '科技' },
    { slug: 'animals', label: '动物' },
    { slug: 'holidays', label: '节日' },
    { slug: 'sports', label: '运动' },
];

/**
 * 列表页地址；第 1 页就是根路径，后面是 `/page/N/`。
 *
 * 有搜索关键字时走 WordPress 的 `?s=`：实测返回同样的 `<article>` 结构，
 * 所以能复用同一个解析器，分页则是 `/?s=xxx&paged=N`。
 */
const listUrl = (page: number, category: string, keyword = ''): string => {
    if (keyword.trim()) {
        const query = `s=${encodeURIComponent(keyword.trim())}`;
        return page <= 1 ? `${BASE}/?${query}` : `${BASE}/page/${page}/?${query}`;
    }
    const prefix = category ? `${BASE}/${category}` : BASE;
    return page <= 1 ? `${prefix}/` : `${prefix}/page/${page}/`;
};

/** 从 article 块里取一个字段。 */
const pick = (block: string, pattern: RegExp): string | undefined => {
    const match = pattern.exec(block);
    return match?.[1];
};

/**
 * 解析列表页。
 *
 * 每条壁纸一个 `<article>`，里面：
 *   · 详情页链接在 `<a class="g1-frame" href="https://moewalls.com/anime/xxx/">`
 *   · 缩略图在 `src=".../xxx-thumb-364x205.jpg"`，srcset 里还有 728 / 1920 两档
 *   · 分辨率在 class 里的 `resolutions-3840x2160`
 */
export const parseMoewallsList = (html: string, page: number): BackgroundMarketPage => {
    const blocks = html.match(/<article[^>]*class="[^"]*entry-tpl-grid[^"]*"[\s\S]*?<\/article>/g) ?? [];
    const items: BackgroundMarketItem[] = [];

    for (const block of blocks) {
        const detailUrl = pick(block, /<a[^>]*class="g1-frame"[^>]*href="(https:\/\/moewalls\.com\/[^"]+)"/)
            ?? pick(block, /<a[^>]*href="(https:\/\/moewalls\.com\/[^"]*live-wallpaper\/)"/);
        if (!detailUrl) continue;

        // 缩略图优先用 srcset 里最大那档，列表里显示更清楚。
        const srcset = pick(block, /srcset="([^"]+)"/);
        const largest = srcset
            ?.split(',')
            .map((entry) => entry.trim().split(/\s+/))
            .filter(([url]) => Boolean(url))
            .sort((left, right) => Number.parseInt(right[1] ?? '0', 10) - Number.parseInt(left[1] ?? '0', 10))[0]?.[0];
        const thumbnailUrl = largest
            ?? pick(block, /<img[^>]*src="(https:\/\/moewalls\.com\/wp-content\/uploads\/[^"]+)"/)
            ?? '';
        if (!thumbnailUrl) continue;

        // 标题：article 里第一个 h3/a 的文字，或者链接末段。
        const name = (pick(block, /<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) ?? '')
            .replace(/<[^>]+>/g, '')
            .trim()
            || pick(block, /<a[^>]*title="([^"]+)"/)
            || detailUrl.replace(/\/$/, '').split('/').pop()!.replace(/-/g, ' ');

        const resolution = pick(block, /resolutions-(\d+x\d+)/);
        const [width, height] = resolution
            ? resolution.split('x').map((value) => Number.parseInt(value, 10))
            : [undefined, undefined];

        const slug = detailUrl.replace(BASE, '').replace(/^\/|\/$/g, '');
        items.push({
            id: `moewalls:${slug}`,
            source: 'moewalls',
            sourceLabel: SOURCE_LABEL,
            name: name || slug,
            kind: 'video',
            thumbnailUrl,
            detailUrl,
            width,
            height,
            // 高清地址要再进详情页换一次，见 resolveMoewallsMediaUrl。
        });
    }

    // 这页拿满了才认为还有下一页：站点没有 total，用「不足一页」判断结束最稳。
    return { items, hasMore: blocks.length >= 12, page };
};

export const fetchMoewallsPage = async (
    page: number,
    category = '',
    signal?: AbortSignal,
    keyword = '',
): Promise<BackgroundMarketPage> => {
    const response = await fetchHtml(listUrl(page, category, keyword), { 'Accept-Language': 'en-US,en;q=0.9' }, signal);
    if (!response.ok) {
        throw new Error(`Moewalls 列表请求失败（HTTP ${response.status}）`);
    }
    return parseMoewallsList(await response.text(), page);
};

/**
 * 进详情页换出真正的高清下载地址。
 *
 * 详情页里的 `<a id="moe-download" data-url="...">` 是一段加密串，不需要解密 ——
 * 原样拼到 download.php 后面即可（实测返回 4K mp4）。
 */
export const resolveMoewallsMediaUrl = async (
    detailUrl: string,
    signal?: AbortSignal,
): Promise<string | null> => {
    const response = await fetchHtml(detailUrl, { 'Accept-Language': 'en-US,en;q=0.9' }, signal);
    if (!response.ok) return null;

    const html = await response.text();
    /*
     * 属性顺序不保证：id 与 data-url 谁先出现都可能，所以两种顺序都试。
     */
    const dataUrl = /<a[^>]*id="moe-download"[^>]*data-url\s*=\s*"([^"]+)"/.exec(html)?.[1]
        ?? /data-url\s*=\s*"([^"]+)"[^>]*id="moe-download"/.exec(html)?.[1];
    if (!dataUrl) return null;

    return `${DOWNLOAD_BASE}/download.php?video=${dataUrl}`;
};
