// src/utils/doubleTap.ts
// 两次点击算不算一次双击：网格封面的双击播放与播放页的双击暂停共用这一份判定。

/** 两次点击算一次双击的最长间隔。比系统双击判定宽一点：手指点两下比鼠标慢。 */
export const DOUBLE_TAP_MS = 340;
/** 两次点击之间允许的位移：手指双击不可能落在同一个像素上，但没有这条又会把一次拖动的尾点算进来。 */
export const DOUBLE_TAP_SLOP_PX = 24;

export type TapPoint = { at: number; x: number; y: number };

/** 点击事件的那一小部分形状：够用，也让这个模块不必认识 React 的事件类型。 */
export type TapEvent = {
    clientX: number;
    clientY: number;
    stopPropagation: () => void;
};

/** 纯判定（抽出来是为了能脱开组件单测）：上一次点击和这一次能不能算一次双击。 */
export const isDoubleTap = (previous: TapPoint | null, next: TapPoint): boolean => {
    if (!previous) return false;
    const gap = next.at - previous.at;
    // 上一次比这一次还晚（时钟回拨、或同一次点击的两条事件乱了序）不是双击。
    if (gap < 0 || gap > DOUBLE_TAP_MS) return false;
    return Math.abs(next.x - previous.x) <= DOUBLE_TAP_SLOP_PX
        && Math.abs(next.y - previous.y) <= DOUBLE_TAP_SLOP_PX;
};
