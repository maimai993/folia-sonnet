// src/components/modal/settings/pages/integration/market/useBackgroundMarket.ts
//
// 背景市场的分页。
//
// 与字体那边的 hook 结构一致（请求序号防串页、切源清空），
// 差别只在多了一个 `hasMore` 的推断方式：这些站没有总数，
// 只能靠「这页拿满了没」猜 —— 猜错的代价只是多一次空请求。

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    fetchMarketPage,
    type BackgroundMarketItem,
    type BackgroundMarketSourceId,
} from '../../../../../../services/backgroundMarket';

interface State {
    items: BackgroundMarketItem[];
    loading: boolean;
    error: string | null;
    hasMore: boolean;
}

export const useBackgroundMarket = (source: BackgroundMarketSourceId, category: string, keyword = '') => {
    const [state, setState] = useState<State>({ items: [], loading: true, error: null, hasMore: false });
    const pageRef = useRef(1);
    const requestRef = useRef(0);
    /** 防抖后的关键字：敲字停下来再发请求。 */
    const [settledKeyword, setSettledKeyword] = useState(keyword);

    useEffect(() => {
        if (keyword === '') {
            setSettledKeyword('');
            return;
        }
        const timer = window.setTimeout(() => setSettledKeyword(keyword), 400);
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
            const result = await fetchMarketPage({ source, page, category, keyword: settledKeyword });
            if (ticket !== requestRef.current) return;
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
    }, [source, category, settledKeyword]);

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
