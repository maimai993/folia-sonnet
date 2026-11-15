// src/services/backgroundMarket/bizhihui.ts
//
// bizhihui（壁纸汇）：图片源，Z-Blog PHP 站点。
//
// 结构很规整，实测：
//   列表  https://www.bizhihui.com/page/N/?order=views   每页 20 条
//   详情  /p/<id>.html
//   缩略  https://s.panlai.com/.../<file>.jpg-pcthumbs   约 29 KB webp
//   原图  把 -pcthumbs 后缀去掉                         约 890 KB jpeg（实测）
//
// 「去掉后缀就是原图」这条是实测确认过的，不是猜的。

import type { BackgroundMarketItem, BackgroundMarketPage } from './types';
import { fetchHtml } from './http';

const BASE = 'https://www.bizhihui.com';
const SOURCE_LABEL = '壁纸汇';

export const BIZHIHUI_SOURCE = {
    id: 'bizhihui' as const,
    label: SOURCE_LABEL,
    kinds: ['image' as const],
    supportsSearch: false,
};

/** 分类：路径段取自站点导航，都是真实存在的。 */
export const BIZHIHUI_CATEGORIES = [
    { slug: '', label: '全部' },
    { slug: 'dongman', label: '动漫' },
    { slug: 'renwu', label: '人物' },
    { slug: 'fengjing', label: '风景' },
    { slug: 'yingshi', label: '影视' },
    { slug: 'youxi', label: '游戏' },
    { slug: 'keji', label: '科技' },
    { slug: 'jianyue', label: '简约' },
    { slug: 'mengchong', label: '萌宠' },
    { slug: 'meishi', label: '美食' },
    { slug: 'weimei', label: '唯美' },
    { slug: 'yishu', label: '艺术' },
    { slug: 'jiche', label: '机车' },
    { slug: 'yuzhou', label: '宇宙' },
];

/**
 * 列表页地址。
 *
 * 有关键字时走站点的搜索页 `/search.php?q=`：实测返回的卡片结构与列表页一致
 * （都是 `.item-content` 里的 `/p/N.html` + `-pcthumbs` 缩略图），所以解析器可以复用。
 */
const listUrl = (page: number, category: string, keyword = ''): string => {
    if (keyword.trim()) {
        const query = `q=${encodeURIComponent(keyword.trim())}`;
        return page <= 1
            ? `${BASE}/search.php?${query}`
            : `${BASE}/search.php?${query}&page=${page}`;
    }
    const segment = category ? `/${category}` : '';
    return page <= 1
        ? `${BASE}${segment}/?order=views`
        : `${BASE}${segment}/page/${page}/?order=views`;
};

/**
 * 缩略图 → 原图。
 *
 * 站点用 `-pcthumbs` 后缀标记压缩版，原图就是去掉后缀的那份。
 * 不是这个形态时原样返回（宁可给压缩版，也不能拼出一个 404）。
 */
export const bizhihuiFullImage = (thumbnailUrl: string): string => (
    thumbnailUrl.replace(/-pcthumbs$/, '')
);

/** 从图片文件名里认出它是哪条壁纸（`bizhihui_com_20260822...` 这种没有 id，用文件名当 id）。 */
const idFromImage = (imageUrl: string): string => {
    const file = imageUrl.split('/').pop() ?? imageUrl;
    return file.replace(/-pcthumbs$/, '').replace(/\.[a-z]+$/i, '');
};

/**
 * 解析列表页。
 *
 * 每个条目是一个 <a href="/p/<id>.html"> 包着一张缩略图，所以按 <a> 块切最稳：
 * 图片和详情链接天然配在一起，不会因为页面里还有别的图而错位。
 */
export const parseBizhihuiList = (html: string, page: number): BackgroundMarketPage => {
    const blocks = html.match(/<a[^>]+href="https?:\/\/www\.bizhihui\.com\/p\/\d+\.html"[^>]*>[\s\S]{0,600}?<\/a>/g) ?? [];
    const items: BackgroundMarketItem[] = [];
    const seen = new Set<string>();

    for (const block of blocks) {
        const detailUrl = /href="([^"]+)"/.exec(block)?.[1];
        const thumbnailUrl = /<img[^>]*src="([^"]+)"/.exec(block)?.[1];
        if (!detailUrl || !thumbnailUrl || thumbnailUrl.startsWith('data:')) continue;

        const id = idFromImage(thumbnailUrl);
        if (seen.has(id)) continue;
        seen.add(id);

        const alt = /<img[^>]*alt="([^"]*)"/.exec(block)?.[1] ?? '';
        const name = alt.trim() || id;

        items.push({
            id: `bizhihui:${id}`,
            source: 'bizhihui',
            sourceLabel: SOURCE_LABEL,
            name,
            kind: 'image',
            thumbnailUrl,
            detailUrl,
            // 图片不需要再进详情页：去掉缩略后缀就是原图。
            mediaUrl: bizhihuiFullImage(thumbnailUrl),
        });
    }

    return { items, hasMore: items.length >= 12, page };
};

export const fetchBizhihuiPage = async (
    page: number,
    category = '',
    signal?: AbortSignal,
    keyword = '',
): Promise<BackgroundMarketPage> => {
    const response = await fetchHtml(listUrl(page, category, keyword), { 'Accept-Language': 'zh-CN,zh;q=0.9' }, signal);
    if (!response.ok) {
        throw new Error(`哲风壁纸列表请求失败（HTTP ${response.status}）`);
    }
    return parseBizhihuiList(await response.text(), page);
};
