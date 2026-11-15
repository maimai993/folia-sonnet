// src/components/modal/settings/kit/popoverPlace.ts
// Where a layer that opens from a control goes: rectangles in, a position out. It touches no
// element, so the rule can be tested by itself. The Popover and the Tooltip both place with it.

/** Between the anchor and the layer. */
export const POPOVER_GAP = 6;
/** Kept free between the layer and the edges of its container. */
export const POPOVER_GUTTER = 8;

/** A rectangle. The three of one call are in the same coordinates: the viewport's, as getBoundingClientRect gives them. */
export type Box = { left: number; top: number; width: number; height: number };

/**
 * The box the layer is kept inside, and how far that box's own content is scrolled. A layer drawn
 * inside a scrolled container lies in its content, so its distances count from the scrolled edges.
 */
export type PopoverContainer = Box & { scrollLeft?: number; scrollTop?: number };

export type PopoverSide = 'under' | 'over';
export type PopoverAlign = 'start' | 'center' | 'end';

export type PopoverPlaceOptions = {
    /** The side asked for. */
    side: PopoverSide;
    /** The edge of the anchor the layer lines up with, or its centre. */
    align: PopoverAlign;
    /** As wide as the container, less the gutter at both sides. */
    fill?: boolean;
};

/** The position as distances from the container's edges: what the layer's `style` takes. */
export type PopoverPlace = {
    /** The side the layer is on. */
    side: PopoverSide;
    left?: number;
    /** A layer at its anchor's end hangs from its right edge: it grows to the left. */
    right?: number;
    top?: number;
    /** A layer over its anchor stands on its bottom edge: it grows upward. */
    bottom?: number;
    /** The room on that side. A taller layer scrolls inside itself. */
    maxHeight: number;
};

/**
 * Places a layer of the given size at its anchor, inside the container. It goes to the side asked
 * for; to the other one where it is too tall here and fits there; and where it fits on neither, to
 * the one with more room. Sideways it is moved in where it would pass the gutter.
 */
export const placePopover = (
    anchor: Box,
    layer: { width: number; height: number },
    container: PopoverContainer,
    { side, align, fill = false }: PopoverPlaceOptions,
): PopoverPlace => {
    const { scrollLeft = 0, scrollTop = 0 } = container;
    const room = {
        under: container.top + container.height - POPOVER_GUTTER - (anchor.top + anchor.height + POPOVER_GAP),
        over: anchor.top - POPOVER_GAP - (container.top + POPOVER_GUTTER),
    };
    const other: PopoverSide = side === 'under' ? 'over' : 'under';

    /*
     * ★ 装不下时，不要把弹层压进锚点一侧的窄缝里。
     *
     * 原来这里只做「under 放不下就试 over，两边都放不下就挑余量更大的那个」，
     * maxHeight 给的就是那一侧的余量。
     *
     * 问题出在横屏手机上：控制面板只有 329px 高，而「歌词样式 / 背景类型 /
     * 音频效果器」这几个下拉的内容有三四百像素。锚点在面板中部，
     * 下方只剩 191px —— 弹层被压到 191px，内容 346px，
     * 要在一个很小的框里滚过 155px 才看得到最后一项，
     * 观感就是「怎么滑都滑不到底」。
     *
     * 既然横竖都得滚，就让它滚在**最大的那个框**里：铺满容器高度。
     */
    const fullRoom = container.height - 2 * POPOVER_GUTTER;
    const placed = layer.height <= room[side] || (layer.height > room[other] && room[side] >= room[other]) ? side : other;
    const vertical = placed === 'under'
        ? { top: anchor.top + anchor.height + POPOVER_GAP - container.top + scrollTop }
        : { bottom: container.top + container.height - anchor.top + POPOVER_GAP - scrollTop };
    // A distance from the container's left or right edge, held between the two gutters.
    const inside = (distance: number) => Math.max(POPOVER_GUTTER, Math.min(distance, container.width - layer.width - POPOVER_GUTTER));
    const horizontal = fill
        ? { left: POPOVER_GUTTER + scrollLeft, right: POPOVER_GUTTER - scrollLeft }
        : align === 'end'
            ? { right: inside(container.left + container.width - (anchor.left + anchor.width)) - scrollLeft }
            : { left: inside(anchor.left - container.left + (align === 'center' ? (anchor.width - layer.width) / 2 : 0)) + scrollLeft };

    /*
     * 内容在一侧放不下时的处理。
     *
     * 用 top 和 maxHeight 两个值就能表达「从容器顶部留白处开始、往下铺到底」——
     * 不用 bottom 是因为同时给 top 和 bottom 会把高度写死，反而失去自适应。
     *
     * 顺序很重要：
     *   1. 一侧装得下 → 就用那一侧（弹层贴着锚点，观感最自然）；
     *   2. 否则就把**整个容器的高度**给它（top 从顶部留白算起）。
     *
     * 第 2 条原来是「挑余量更大的那一侧」，问题出在横屏手机上：
     * 控制面板只有 329px 高，「歌词样式 / 背景类型 / 音频效果器」的内容有 346px，
     * 锚点在面板中部，上下两侧都放不下，于是弹层被压成 191px ——
     * 要在 191px 的框里滚过 155px 才看得到最后一项，框本身也矮得没法用。
     *
     * 既然横竖都要滚，就让它滚在**最大的那个框**里：铺满容器高度。
     * 内容仍然超出的那部分，用户少滑一截就能到底。
     */
    if (layer.height <= room[placed]) {
        return { side: placed, ...horizontal, ...vertical, maxHeight: Math.max(0, room[placed]) };
    }
    /*
     * 铺开：从容器顶部留白处开始，高度吃满容器。
     *
     * ⚠️ 这里不再判断 fitsWhole —— 内容比容器还高时更要铺开：
     * 那种情况单侧只会更矮，滚动距离更长。
     */
    return {
        side: placed,
        ...horizontal,
        top: POPOVER_GUTTER + scrollTop,
        maxHeight: Math.max(0, fullRoom),
    };
};
