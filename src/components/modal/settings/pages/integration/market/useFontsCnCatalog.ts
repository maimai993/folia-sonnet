// src/components/modal/settings/pages/integration/market/useFontsCnCatalog.ts
//
// 字体天下的列表分页 + 搜索。
//
// 站点没有 JSON 接口，只能一页一页解析 HTML，所以这里的管理重点是：
//   · 切分类 / 改关键字时立刻清空（否则会短暂看到上一次的结果）
//   · 请求带序号，晚到的旧响应不能覆盖新结果（快速切换时的经典坑）
//   · 搜索输入要防抖，否则每敲一个字就发一次请求
//   · 失败要能重试，而不是把用户卡在空列表

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchFontsCnPage, searchFontsCn, type FontsCnItem } from '../../../../../../services/fontMarket/fontsNetCn';

interface CatalogState {
    items: FontsCnItem[];
    loading: boolean;
    error: string | null;
    hasMore: boolean;
}

/** 搜索防抖：敲字停下来再发请求。 */
const SEARCH_DEBOUNCE_MS = 400;

export const useFontsCnCatalog = (category: string, keyword = '') => {
    const [state, setState] = useState<CatalogState>({ items: [], loading: true, error: null, hasMore: false });
    const pageRef = useRef(1);
    /** 请求序号：只接受最新一次请求的结果。 */
    const requestRef = useRef(0);
    /** 防抖后的关键字。 */
    const [settledKeyword, setSettledKeyword] = useState(keyword);

    useEffect(() => {
        if (keyword === '') {
            setSettledKeyword('');
            return;
        }
        const timer = window.setTimeout(() => setSettledKeyword(keyword), SEARCH_DEBOUNCE_MS);
        return () => window.clearTimeout(timer);
    }, [keyword]);

    const load = useCallback(async (page: number, replace: boolean) => {
        const ticket = ++requestRef.current;
        setState((previous) => ({
            ...previous,
            loading: true,
            error: null,
            items: replace ? [] : previous.items,
        }));
        try {
            // 有关键字就走搜索，否则走分类列表 —— 两条链路的返回结构一样。
            const result = settledKeyword
                ? await searchFontsCn(settledKeyword, page)
                : await fetchFontsCnPage(category, page);
            if (ticket !== requestRef.current) return;   // 已经有更新的请求了
            pageRef.current = page;
            setState((previous) => ({
                items: replace ? result.items : [...previous.items, ...result.items],
                loading: false,
                error: null,
                hasMore: result.hasMore,
            }));
        } catch (error) {
            if (ticket !== requestRef.current) return;
            setState((previous) => ({
                ...previous,
                loading: false,
                error: (error as Error)?.message ?? '加载失败',
            }));
        }
    }, [category, settledKeyword]);

    // 换分类或换关键字 → 从第 1 页重新拉。
    useEffect(() => {
        void load(1, true);
    }, [load]);

    const loadMore = useCallback(async () => {
        if (state.loading || !state.hasMore) return;
        await load(pageRef.current + 1, false);
    }, [load, state.loading, state.hasMore]);

    const reload = useCallback(() => {
        void load(1, true);
    }, [load]);

    return { ...state, loadMore, reload };
};
