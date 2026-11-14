// src/components/app/search/searchBarScroll.ts
// 搜索结果列表的滚动方向：往下滚时把底部播放条暂时收到屏幕下面，往上滚再放回来。

/**
 * 方向判定的死区（px）。
 *
 * 手指滚动和列表到顶／到底的回弹会一帧一帧地送来 ±几像素的位移；不设死区，播放条会跟着抖。
 * 小于这个量的位移不认方向、先攒着，攒够一次才翻方向 —— 于是慢慢拖也能把播放条收起来，
 * 而回弹那一下不会。
 */
export const SEARCH_BAR_SCROLL_DIRECTION_THRESHOLD_PX = 8;

export type SearchBarScrollState = {
    /** 上一次认下方向时的滚动位置。小于死区的位移不改它，靠累积后一次判。 */
    anchorScrollTop: number;
    /** 播放条现在是不是被这次滚动收起来了。 */
    isBarHidden: boolean;
};

/** 进列表时的初始状态：停在记录下来的位置上时播放条是露着的。 */
export const createSearchBarScrollState = (scrollTop = 0): SearchBarScrollState => ({
    anchorScrollTop: Math.max(0, scrollTop),
    isBarHidden: false,
});

/**
 * 拿一次新的滚动位置算出新状态。
 *
 * 认下了新方向就把基准挪到当前位置 —— 所以「往下滚收起、往上滚再滚 8px 就放回来」是即时生效的
 * 对称动作，而不是要滚回收起那一刻的位置。没认下方向时**原样返回同一个对象**，调用方据此
 * 判断这次不必通知任何人（回弹和不滚时重复的 onScroll 都走这一条）。
 */
export const resolveSearchBarScrollState = (
    state: SearchBarScrollState,
    nextScrollTop: number,
): SearchBarScrollState => {
    const next = Math.max(0, nextScrollTop);
    // 回到顶部一定是「往上滚到了头」：播放条必须回来，否则最上面那一段永远看不到控制条。
    if (next <= 0) {
        if (state.anchorScrollTop === 0 && !state.isBarHidden) return state;
        return { anchorScrollTop: 0, isBarHidden: false };
    }

    const delta = next - state.anchorScrollTop;
    if (delta > SEARCH_BAR_SCROLL_DIRECTION_THRESHOLD_PX) {
        return { anchorScrollTop: next, isBarHidden: true };
    }
    if (delta < -SEARCH_BAR_SCROLL_DIRECTION_THRESHOLD_PX) {
        return { anchorScrollTop: next, isBarHidden: false };
    }
    return state;
};
