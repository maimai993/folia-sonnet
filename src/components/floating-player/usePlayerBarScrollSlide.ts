import { useEffect, useState, type CSSProperties } from 'react';

// src/components/floating-player/usePlayerBarScrollSlide.ts
// 整屏列表（搜索页）往下滚时，把底部胶囊整条放到屏幕下面的那一套状态。

/**
 * 收起时除了胶囊自己的高度还要多走的一截（px）。
 *
 * 胶囊离底的距离是可配的（playerBottomBarOffset），所以按「基线 + 够高的一截」算：
 * 窄屏展开态最高也就三条网格加内边距，220 足够。多走的部分本来就在屏幕外，看不出来；
 * 宁可多走，不要剩半条边压在列表上。
 */
export const PLAYER_BAR_SCROLL_HIDDEN_EXTRA_PX = 220;

/** 这段位移的时长（ms）：CSS 过渡与「位移结束后再开回 layout」共用它。 */
export const PLAYER_BAR_SCROLL_HIDDEN_MS = 260;

export type PlayerBarScrollSlide = {
    /** 位移正在进行：收起中，或刚放回来还没落定。这期间别让胶囊重算那些每帧都贵的效果。 */
    isSliding: boolean;
    /**
     * 胶囊的 `layout` 能不能开。
     *
     * `layout` 是按**视口**量前后两次位置算位移的：外层一有 y 位移，它量到的差值就变了，
     * 于是当成「胶囊自己挪了」，用布局 spring 反过来弹一次 —— 放回时看到的那下抽搐就是它。
     * 所以位移期间关掉，落定后再开；那时胶囊已回原位，量出来的差值是 0，不会再补一次。
     */
    layoutAnimationEnabled: boolean;
    /** 位移层的样式：transform + 过渡。 */
    layerStyle: CSSProperties;
};

export const usePlayerBarScrollSlide = (
    isScrollHidden: boolean,
    bottomOffsetPx: number,
): PlayerBarScrollSlide => {
    const [settled, setSettled] = useState(true);

    useEffect(() => {
        if (isScrollHidden) {
            setSettled(false);
            return;
        }
        if (settled) {
            return;
        }
        // 用时长收回 layout，而不是 onAnimationComplete：那个回调在这条位移还没走完时就到了，
        // 早了等于什么都没关，胶囊照样被弹一下。
        const timer = window.setTimeout(() => setSettled(true), PLAYER_BAR_SCROLL_HIDDEN_MS + 40);
        return () => window.clearTimeout(timer);
    }, [isScrollHidden, settled]);

    const isSliding = isScrollHidden || !settled;
    return {
        isSliding,
        layoutAnimationEnabled: !isScrollHidden && settled,
        /*
         * 位移走 CSS 过渡，不走 framer 逐帧写 transform：这一下是跟着滚动发生的，主线程正好被
         * 列表渲染占着，framer 每帧抢不过就掉帧，手机上看着就是一顿一顿。交给 CSS 后位移在合成
         * 线程上跑，主线程掉帧它也走得完。挂在这一层而不是 framer 那层，是因为同一节点上 framer
         * 的 transform 会盖掉 CSS 的（那层还在管播放页的进出场）。
         */
        layerStyle: {
            transform: `translateY(${isScrollHidden ? bottomOffsetPx + PLAYER_BAR_SCROLL_HIDDEN_EXTRA_PX : 0}px)`,
            transition: `transform ${PLAYER_BAR_SCROLL_HIDDEN_MS}ms cubic-bezier(0.33, 1, 0.68, 1)`,
            willChange: isSliding ? 'transform' : undefined,
        },
    };
};
