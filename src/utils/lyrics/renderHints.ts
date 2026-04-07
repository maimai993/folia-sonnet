export type LineTimingClass = 'normal' | 'short' | 'micro';
export type LineTransitionMode = 'normal' | 'fast' | 'none';
export type WordRevealMode = 'normal' | 'fast' | 'instant';

export interface LineRenderHints {
    rawDuration: number;
    timingClass: LineTimingClass;
    renderEndTime: number;
    lineTransitionMode: LineTransitionMode;
    wordRevealMode: WordRevealMode;
}

export interface RenderHintLineLike {
    startTime: number;
    endTime: number;
    renderHints?: LineRenderHints;
}

export const MICRO_LINE_DURATION_THRESHOLD = 0.10;
export const SHORT_LINE_DURATION_THRESHOLD = 0.18;
export const MICRO_LINE_RENDER_FLOOR = 0.067;

export const buildLineRenderHints = (startTime: number, endTime: number): LineRenderHints => {
    const rawDuration = Math.max(endTime - startTime, 0);

    if (rawDuration < MICRO_LINE_DURATION_THRESHOLD) {
        return {
            rawDuration,
            timingClass: 'micro',
            renderEndTime: Math.max(endTime, startTime + MICRO_LINE_RENDER_FLOOR),
            lineTransitionMode: 'none',
            wordRevealMode: 'instant',
        };
    }

    if (rawDuration < SHORT_LINE_DURATION_THRESHOLD) {
        return {
            rawDuration,
            timingClass: 'short',
            renderEndTime: endTime,
            lineTransitionMode: 'fast',
            wordRevealMode: 'fast',
        };
    }

    return {
        rawDuration,
        timingClass: 'normal',
        renderEndTime: endTime,
        lineTransitionMode: 'normal',
        wordRevealMode: 'normal',
    };
};

export const getLineRenderHints = <T extends RenderHintLineLike>(line: T | null | undefined): LineRenderHints | null => {
    if (!line) {
        return null;
    }

    return line.renderHints ?? buildLineRenderHints(line.startTime, line.endTime);
};

export const getLineRenderEndTime = <T extends RenderHintLineLike>(line: T | null | undefined): number => {
    if (!line) {
        return Number.NEGATIVE_INFINITY;
    }

    return getLineRenderHints(line)?.renderEndTime ?? line.endTime;
};

export const annotateLyricLines = <T extends RenderHintLineLike>(lines: T[]): T[] => {
    return lines.map(line => ({
        ...line,
        renderHints: buildLineRenderHints(line.startTime, line.endTime),
    }));
};
