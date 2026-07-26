import type { Line } from '../../../types';

// src/components/visualizer/pendolo/pendoloTimeline.ts

/** Resolves the wheel anchor when playback is outside an actively timed lyric line. */
export const resolvePendoloFallbackAnchorIndex = (
    lines: Line[],
    currentLineIndex: number,
    lastValidLineIndex: number,
    hasObservedLine: boolean,
    currentTime: number,
) => {
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
