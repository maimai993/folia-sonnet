import { useRef } from 'react';
import { isDoubleTap, type TapEvent, type TapPoint } from '../../../../utils/doubleTap';

export { DOUBLE_TAP_MS, DOUBLE_TAP_SLOP_PX, isDoubleTap } from '../../../../utils/doubleTap';
export type { TapEvent, TapPoint } from '../../../../utils/doubleTap';

// src/library/suites/grid/shared/coverDoubleTap.ts
// 双击封面 = 按那颗播放键。
//
// 为什么要有这条手势：横屏时网格整体往下压，居中那张卡的播放键会落到底部进度条底下 ——
// 键还在、`pointer-events` 也还是 auto，只是手指按不到它。双击封面是那条路走不通时的替补。
//
// 「算不算一次双击」的判定在 utils/doubleTap —— 播放页的双击暂停也用同一份。

/**
 * 自己数两次 `click`，而不是用 `onDoubleClick`：安卓 WebView 里 `dblclick` 在
 * `touch-action: none` 的画布上不一定落得下来，而 `click` 一定会有（手指点一下浏览器就发，
 * 不论那块区域有没有声明手势）。
 *
 * 第一次点击照旧交给卡片（居中），只有凑成双击的那一次才被拦下来 —— 所以双击之后
 * 卡片不会被再居中一次，也不会把这一次点击当成又一次「选中」传上去。
 */
export const useCoverDoubleTap = (enabled: boolean, onDoubleTap: () => void) => {
    const lastTap = useRef<TapPoint | null>(null);
    return (event: TapEvent): void => {
        if (!enabled) return;
        const now: TapPoint = { at: Date.now(), x: event.clientX, y: event.clientY };
        const previous = lastTap.current;
        lastTap.current = now;
        if (!isDoubleTap(previous, now)) return;
        lastTap.current = null;
        event.stopPropagation();
        onDoubleTap();
    };
};
