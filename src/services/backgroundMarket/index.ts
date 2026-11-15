// src/services/backgroundMarket/index.ts
//
// 背景市场的统一入口：把三个源收成一套接口，界面只跟这里打交道。

import { BIZHIHUI_CATEGORIES, BIZHIHUI_SOURCE, fetchBizhihuiPage } from './bizhihui';
import {
    HAOWALLPAPER_SOURCE,
    fetchHaowallpaperPage,
} from './haowallpaper';
import { MOEWALLS_CATEGORIES, MOEWALLS_SOURCE, fetchMoewallsPage, resolveMoewallsMediaUrl } from './moewalls';
import type {
    BackgroundMarketItem,
    BackgroundMarketPage,
    BackgroundMarketQuery,
    BackgroundMarketSource,
    BackgroundMarketSourceId,
} from './types';

export type {
    BackgroundMarketItem,
    BackgroundMarketPage,
    BackgroundMarketQuery,
    BackgroundMarketSource,
    BackgroundMarketSourceId,
    BackgroundMarketKind,
} from './types';

/**
 * 可用源。
 *
 * 顺序即界面上的顺序：Moewalls 有真正的 4K 视频，放第一个；
 * 哲风壁纸内容最多（视频 + 图片），排第二；壁纸汇只有图片，最后。
 */
export const BACKGROUND_MARKET_SOURCES: readonly BackgroundMarketSource[] = [
    MOEWALLS_SOURCE,
    HAOWALLPAPER_SOURCE,
    BIZHIHUI_SOURCE,
];

export const getMarketSource = (id: BackgroundMarketSourceId): BackgroundMarketSource | undefined => (
    BACKGROUND_MARKET_SOURCES.find((source) => source.id === id)
);

/** 各源的分类列表；没有分类的源给空数组。 */
export const getMarketCategories = (id: BackgroundMarketSourceId): { slug: string; label: string }[] => {
    if (id === 'moewalls') return MOEWALLS_CATEGORIES;
    if (id === 'bizhihui') return BIZHIHUI_CATEGORIES;
    return [{ slug: '', label: '全部' }];
};

export const fetchMarketPage = async (
    query: BackgroundMarketQuery,
    signal?: AbortSignal,
): Promise<BackgroundMarketPage> => {
    switch (query.source) {
        case 'moewalls':
            return fetchMoewallsPage(query.page, query.category ?? '', signal, query.keyword ?? '');
        case 'haowallpaper':
            return fetchHaowallpaperPage(query.page, query.keyword ?? '', signal);
        case 'bizhihui':
            return fetchBizhihuiPage(query.page, query.category ?? '', signal, query.keyword ?? '');
        default:
            return { items: [], hasMore: false, page: query.page };
    }
};

/**
 * 拿到某个条目的**可下载地址**。
 *
 * 图片源（壁纸汇）在列表里就已经是原图地址，直接返回。
 * 哲风壁纸也是列表里就拼好了。
 * Moewalls 的高清地址要再进一次详情页 —— 这一步必须在这里做，因为只有它知道
 * `moe-download` 那段加密串怎么拼。
 */
export const resolveMarketMediaUrl = async (
    item: BackgroundMarketItem,
    signal?: AbortSignal,
): Promise<string | null> => {
    if (item.mediaUrl) return item.mediaUrl;
    if (item.source === 'moewalls') {
        return resolveMoewallsMediaUrl(item.detailUrl, signal);
    }
    return null;
};
