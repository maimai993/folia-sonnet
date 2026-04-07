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

export interface RenderHintLyricDataLike<TLine extends RenderHintLineLike = RenderHintLineLike> {
    lines: TLine[];
}

export interface MigrationResult<T> {
    value: T;
    changed: boolean;
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

const hasExpectedRenderHints = (line: RenderHintLineLike, expected: LineRenderHints): boolean => {
    const current = line.renderHints;

    return Boolean(
        current
        && current.rawDuration === expected.rawDuration
        && current.timingClass === expected.timingClass
        && current.renderEndTime === expected.renderEndTime
        && current.lineTransitionMode === expected.lineTransitionMode
        && current.wordRevealMode === expected.wordRevealMode
    );
};

export const migrateLyricLinesRenderHints = <T extends RenderHintLineLike>(lines: T[]): MigrationResult<T[]> => {
    let changed = false;

    const nextLines = lines.map(line => {
        const renderHints = buildLineRenderHints(line.startTime, line.endTime);
        if (hasExpectedRenderHints(line, renderHints)) {
            return line;
        }

        changed = true;
        return {
            ...line,
            renderHints,
        };
    });

    return {
        value: changed ? nextLines : lines,
        changed,
    };
};

export const annotateLyricLines = <T extends RenderHintLineLike>(lines: T[]): T[] => {
    return migrateLyricLinesRenderHints(lines).value;
};

export const ensureLyricLinesRenderHints = <T extends RenderHintLineLike>(lines: T[]): T[] => {
    return migrateLyricLinesRenderHints(lines).value;
};

export function migrateLyricDataRenderHints<T extends RenderHintLyricDataLike>(lyrics: T): MigrationResult<T>;
export function migrateLyricDataRenderHints<T extends RenderHintLyricDataLike>(
    lyrics: T | null | undefined
): MigrationResult<T | null>;
export function migrateLyricDataRenderHints<T extends RenderHintLyricDataLike>(
    lyrics: T | null | undefined
): MigrationResult<T | null> {
    if (!lyrics) {
        return { value: null, changed: false };
    }

    const migration = migrateLyricLinesRenderHints(lyrics.lines);
    if (!migration.changed) {
        return { value: lyrics, changed: false };
    }

    return {
        value: {
            ...lyrics,
            lines: migration.value,
        },
        changed: true,
    };
}

export const ensureLyricDataRenderHints = <T extends RenderHintLyricDataLike>(lyrics: T | null | undefined): T | null => {
    return migrateLyricDataRenderHints(lyrics).value;
};
