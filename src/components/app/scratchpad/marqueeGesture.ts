import { cardRect, rectFromPoints, rectsIntersect, type Point, type Rect, type Spacing } from './canvasLayout';

// src/components/app/scratchpad/marqueeGesture.ts
// 空白处框选那一次手势的状态、两个门槛，以及「这一框选到了谁」的算法。抽出来只为一件事：
// ScratchpadCanvas 已经贴着 800 行上限，而「按住空白处」这一档（触摸屏）让这块又长出几段。

/** 按下之后走过这么远才算拖（以内是点击）。 */
export const DRAG_THRESHOLD = 4;
/**
 * 手指按在空白处多久「拿起来」开始框选。
 *
 * 触摸屏上空白处的拖动默认是滚动（.scratchpad-canvas 的 touch-action: pan-y），所以框选只能
 * 走长按：按住了再划才是框选，直接划仍然是滚动。鼠标没有这个歧义，按下即框选。
 */
export const LONG_PRESS_MS = 400;
/** 手指按住期间走过这么远就算在滚动（拿起来之前）。比鼠标的门槛宽：手指按着总会抖一点。 */
export const TOUCH_SLOP = 10;

export type Marquee = {
    pointerId: number;
    start: Point;
    base: ReadonlySet<string>;
    moved: boolean;
    /** 松手时没拖就收回（按下时没有选中什么、不是加选、不在组头上）。 */
    collapses: boolean;
    /** 手指按下的这一次还没「拿起来」：要按住 LONG_PRESS_MS 不动才算开始框选，在那之前一划是滚动。 */
    held: boolean;
    /** 拿起来用的表：到点把这颗放行，松手时清掉。 */
    holdTimer: number;
    /** 起手那一刻的视口坐标：按住期间走动超过 TOUCH_SLOP 就是滚动，放弃这一次。 */
    touchOrigin: { clientX: number; clientY: number } | null;
    /** 框选开始时各组网格原点（内容坐标）与它们的条目。 */
    grids: { origin: Point; keys: string[] }[];
    /** 还没处理的最近一次指针位置（视口坐标）：一帧可能来好几次，每帧只算一次。 */
    pending: { clientX: number; clientY: number } | null;
    frame: number;
};

/** 框选时各组网格的抓取范围：起手那一刻记下，之后不再读布局。 */
export type MarqueeGrid = Marquee['grids'][number];

/**
 * 这一框落在哪、框住了谁。
 *
 * 框就是内容坐标里两点围成的矩形（起点按内容坐标记着，滚动过也对得上）；纸斜着时它跟着纸斜。
 * 返回的 `rect` 给调用方去摆那颗框，`keys` 是框里所有卡片的键（不含起手时已经选中的）。
 */
export const resolveMarquee = (
    marquee: Marquee,
    point: Point,
    columns: number,
    spacing: Spacing,
): { rect: Rect; keys: Set<string> } | null => {
    if (!marquee.moved && Math.hypot(point.x - marquee.start.x, point.y - marquee.start.y) < DRAG_THRESHOLD) {
        return null;
    }
    marquee.moved = true;
    const rect = rectFromPoints(marquee.start, point);
    const keys = new Set(marquee.base);
    for (const grid of marquee.grids) {
        grid.keys.forEach((key, index) => {
            if (rectsIntersect(rect, cardRect(grid.origin, index, columns, spacing))) keys.add(key);
        });
    }
    return { rect, keys };
};
