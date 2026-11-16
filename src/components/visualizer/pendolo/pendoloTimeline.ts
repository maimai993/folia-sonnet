import type { Line } from '../../../types';

// src/components/visualizer/pendolo/pendoloTimeline.ts

/**
 * 没有歌词时用的那一份空数组。
 *
 * 单独导出成常量，是因为「没有歌词」这件事在动态歌词组件里到处要兜底，而
 * `lines.length` 在那边出现了十几处（签名、滚动、排版都用它）。少一处判空，
 * 抛出的异常就会冒到 React 根，整棵界面被卸载 —— 用户看到的是「不管干什么都黑屏」。
 * 共用同一个空数组，既不每次新建，也省掉每个组件各自写一份兜底。
 */
export const EMPTY_LINES: Line[] = [];

/** Resolves the wheel anchor when playback is outside an actively timed lyric line. */
export const resolvePendoloFallbackAnchorIndex = (
    lines: Line[],
    currentLineIndex: number,
    lastValidLineIndex: number,
    hasObservedLine: boolean,
    currentTime: number,
) => {
    /*
     * ★ 没有歌词时 `lines` 可能是 undefined。
     *
     * 这里以前第一句就读 lines.length —— 碰上还没加载出歌词的那一帧，
     * 抛的是 `Cannot read properties of undefined (reading 'length')`。
     * 而这个函数是从组件的 useCallback 里调的，异常会一路冒到 React 根，
     * 整棵界面被卸载 —— 用户看到的就是「不管干什么都黑屏」。
     * 一行防御，换掉一次全屏崩溃。
     */
    if (!lines || lines.length === 0) return -1;
    if (currentLineIndex >= 0 && currentLineIndex < lines.length) {
        return currentLineIndex;
    }

    if (!hasObservedLine) {
        return -1;
    }

    const finalLine = lines.at(-1);
    const finalRenderEndTime = finalLine?.renderHints?.renderEndTime ?? finalLine?.endTime;
    if (finalRenderEndTime !== undefined && currentTime > finalRenderEndTime) {
        return lines.length;
    }

    return lastValidLineIndex + 0.5;
};

const PENDOLO_VISIBLE_ARC_DEG = 110;
const PENDOLO_EDGE_FADE_DEG = 28;

/** Fades a lyric in only when its unwrapped wheel angle reaches the visible right-hand arc. */
export const resolvePendoloRotatingLineOpacity = (
    baseAngleDeg: number,
    wheelRotationDeg: number,
    baseOpacity: number,
) => {
    const visibleAngleDeg = Math.abs(baseAngleDeg + wheelRotationDeg);
    if (visibleAngleDeg >= PENDOLO_VISIBLE_ARC_DEG) return 0;
    const edgeProgress = Math.min(1, (PENDOLO_VISIBLE_ARC_DEG - visibleAngleDeg) / PENDOLO_EDGE_FADE_DEG);
    return baseOpacity * edgeProgress;
};
