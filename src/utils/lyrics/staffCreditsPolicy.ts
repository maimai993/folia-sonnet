import type { Line, LyricData } from '../../types';
import { finalizeParsedLyricLines, isInterludeLine } from './parserCore';
import { ensureLyricDataRenderHints } from './renderHints';
import { createStaffCreditMatcher, detectLeadingStaffBlock } from './staffCredits';
import type { StaffCreditBlock } from './staffCredits';
import { resolveStaffDecision } from './staffCreditsDecision';
import { rebuildStaffLines } from './staffCreditsRewrite';
import type { LyricStaffDecision, LyricStaffPolicy, LyricStaffPolicyOptions } from './types';

// src/utils/lyrics/staffCreditsPolicy.ts
// 按前奏时间预算决定开头 staff 块的去留：够长就保留（必要时重排），
// 勉强就压缩成几张卡，塞不下就整块隐藏。

export type { LyricStaffDecision, LyricStaffPolicy, LyricStaffPolicyOptions, LyricStaffVerdict } from './types';

export const DEFAULT_LYRIC_STAFF_POLICY: LyricStaffPolicy = 'smart';
export const DEFAULT_LYRIC_STAFF_MIN_DWELL_SECONDS = 1.5;
export const LYRIC_STAFF_MIN_DWELL_RANGE = { min: 0.6, max: 4 } as const;

const POLICY_CYCLE: LyricStaffPolicy[] = ['keep', 'smart', 'hide'];

export const nextLyricStaffPolicy = (policy: LyricStaffPolicy): LyricStaffPolicy =>
    POLICY_CYCLE[(POLICY_CYCLE.indexOf(policy) + 1) % POLICY_CYCLE.length];

const NO_BLOCK_DECISION: LyricStaffDecision = {
    verdict: 'none',
    blockLineCount: 0,
    windowSeconds: 0,
    requiredSeconds: 0,
    staffIndexes: [],
    memberIndexes: [],
};

const clampMinDwell = (value?: number): number => {
    if (!Number.isFinite(value)) {
        return DEFAULT_LYRIC_STAFF_MIN_DWELL_SECONDS;
    }

    return Math.min(LYRIC_STAFF_MIN_DWELL_RANGE.max, Math.max(LYRIC_STAFF_MIN_DWELL_RANGE.min, value as number));
};

const stripInterludes = (lines: Line[]): Line[] => lines.filter(line => !isInterludeLine(line));

const analyze = (
    lyrics: LyricData,
    options: LyricStaffPolicyOptions
): { lines: Line[]; block: StaffCreditBlock | null; decision: LyricStaffDecision; minDwell: number } => {
    const minDwell = clampMinDwell(options.minDwellSeconds);
    const lines = stripInterludes(lyrics.lines);
    const block = detectLeadingStaffBlock(lines, createStaffCreditMatcher(options.pattern), {
        meta: { title: lyrics.title, artist: lyrics.artist },
    });

    if (!block) {
        return { lines, block: null, decision: NO_BLOCK_DECISION, minDwell };
    }

    const policy = options.policy ?? DEFAULT_LYRIC_STAFF_POLICY;
    if (policy === 'hide') {
        return {
            lines,
            block,
            minDwell,
            decision: {
                ...NO_BLOCK_DECISION,
                verdict: 'hide',
                blockLineCount: block.staffIndexes.length,
                staffIndexes: block.staffIndexes,
                memberIndexes: block.memberIndexes,
            },
        };
    }

    return { lines, block, decision: resolveStaffDecision(lines, block, minDwell), minDwell };
};

export const applyLyricStaffPolicy = (
    lyrics: LyricData | null | undefined,
    options: LyricStaffPolicyOptions = {}
): LyricData | null => {
    if (!lyrics) {
        return null;
    }

    const policy = options.policy ?? DEFAULT_LYRIC_STAFF_POLICY;
    if (policy === 'keep') {
        return ensureLyricDataRenderHints(lyrics);
    }

    const { lines, block, decision, minDwell } = analyze(lyrics, options);
    if (!block || decision.verdict === 'none' || decision.verdict === 'keep') {
        return ensureLyricDataRenderHints(lyrics);
    }

    return {
        ...lyrics,
        lines: finalizeParsedLyricLines(rebuildStaffLines(lines, block, decision, minDwell), { includeInterludes: true }),
    };
};

export interface LyricStaffPreviewLine {
    line: Line;
    index: number;
    isStaff: boolean;
    removed: boolean;
}

export interface LyricStaffPreviewResult {
    decision: LyricStaffDecision;
    lines: LyricStaffPreviewLine[];
}

export const buildLyricStaffPreview = (
    lyrics: LyricData | null | undefined,
    options: LyricStaffPolicyOptions = {}
): LyricStaffPreviewResult => {
    if (!lyrics) {
        return { decision: NO_BLOCK_DECISION, lines: [] };
    }

    const policy = options.policy ?? DEFAULT_LYRIC_STAFF_POLICY;
    if (policy === 'keep') {
        return {
            decision: NO_BLOCK_DECISION,
            lines: stripInterludes(lyrics.lines).map((line, index) => ({ line, index, isStaff: false, removed: false })),
        };
    }

    const { lines, decision } = analyze(lyrics, options);
    const staffIndexes = new Set(decision.staffIndexes);
    const memberIndexes = new Set(decision.memberIndexes);

    return {
        decision,
        lines: lines.map((line, index) => ({
            line,
            index,
            isStaff: staffIndexes.has(index),
            removed: decision.verdict === 'hide' && memberIndexes.has(index),
        })),
    };
};
