import { describe, expect, it } from 'vitest';
import {
    createSearchBarScrollState,
    resolveSearchBarScrollState,
    SEARCH_BAR_SCROLL_DIRECTION_THRESHOLD_PX,
} from '@/components/app/search/searchBarScroll';

// 搜索页底部播放条随滚动收起的判定：只认方向，不认单个事件的原始位移。
describe('searchBarScroll', () => {
    it('starts with the bar shown', () => {
        expect(createSearchBarScrollState(120)).toEqual({ anchorScrollTop: 120, isBarHidden: false });
        expect(createSearchBarScrollState(-5)).toEqual({ anchorScrollTop: 0, isBarHidden: false });
    });

    it('hides the bar when the list scrolls down past the threshold', () => {
        const state = createSearchBarScrollState(0);
        const next = resolveSearchBarScrollState(state, 200);
        expect(next.isBarHidden).toBe(true);
        expect(next.anchorScrollTop).toBe(200);
    });

    it('ignores jitter smaller than the threshold', () => {
        const state = createSearchBarScrollState(100);
        const next = resolveSearchBarScrollState(state, 100 + SEARCH_BAR_SCROLL_DIRECTION_THRESHOLD_PX);
        expect(next).toBe(state);
    });

    it('accumulates slow drags so a gentle scroll still hides the bar', () => {
        let state = createSearchBarScrollState(0);
        let position = 0;
        const step = Math.floor(SEARCH_BAR_SCROLL_DIRECTION_THRESHOLD_PX / 2);
        for (let index = 0; index < 4 && !state.isBarHidden; index += 1) {
            position += step;
            state = resolveSearchBarScrollState(state, position);
        }
        expect(state.isBarHidden).toBe(true);
    });

    it('reveals the bar as soon as the list scrolls back up past the threshold', () => {
        const hidden = resolveSearchBarScrollState(createSearchBarScrollState(0), 200);
        expect(hidden.isBarHidden).toBe(true);
        const shown = resolveSearchBarScrollState(hidden, 200 - SEARCH_BAR_SCROLL_DIRECTION_THRESHOLD_PX - 1);
        expect(shown.isBarHidden).toBe(false);
    });

    it('never keeps the bar hidden at the very top of the list', () => {
        const shown = resolveSearchBarScrollState(
            { anchorScrollTop: 40, isBarHidden: true },
            0,
        );
        expect(shown).toEqual({ anchorScrollTop: 0, isBarHidden: false });
        // 已经在顶部、播放条也露着时，重复事件不该产生新对象。
        expect(resolveSearchBarScrollState(shown, 0)).toBe(shown);
    });

    it('returns the same state object when the direction did not change', () => {
        const state = createSearchBarScrollState(300);
        expect(resolveSearchBarScrollState(state, 303)).toBe(state);
        const hidden = resolveSearchBarScrollState(state, 400);
        expect(resolveSearchBarScrollState(hidden, 405)).toEqual({ anchorScrollTop: 400, isBarHidden: true });
    });
});
