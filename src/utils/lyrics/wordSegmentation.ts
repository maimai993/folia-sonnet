import type { Line } from '../../types';
import { splitLyricGraphemes } from './graphemeTiming';

// src/utils/lyrics/wordSegmentation.ts
// The single word-granularity segmenter for lyrics. Before this file, sonnetSemantic.ts and
// temperaProgram.ts carried byte-for-byte identical `getSegmenterParts` helpers and
// cjkSemanticLayout.ts carried a third variant, so a user-supplied override would have had to be
// wired into three places that could drift apart.
//
// Callers that have a Line should use `segmentLyricWords`, which honours `line.wordSegments` (the
// user's saved segmentation, baked on upstream by createLyricsSetter). `segmentTextWords` is the
// no-override path for text that has no Line behind it.

export interface LyricWordSegment {
    segment: string;
    /** Offset of this segment inside the source text, in code units. */
    index: number;
    isWordLike: boolean;
}

const PUNCTUATION_ONLY = /^[\s\p{P}\p{S}]+$/u;

const isWordLikeText = (text: string) => !PUNCTUATION_ONLY.test(text);

/**
 * Rebuilds full segment records from a bare boundary list. Used both for the user's saved
 * segmentation and for anything that stores boundaries as plain strings.
 */
export const segmentsFromBoundaries = (boundaries: string[]): LyricWordSegment[] => {
    let cursor = 0;
    return boundaries.map(segment => {
        const part = { segment, index: cursor, isWordLike: isWordLikeText(segment) };
        cursor += segment.length;
        return part;
    });
};

/**
 * Intl.Segmenter word split, falling back to graphemes when the runtime has no Segmenter. The
 * fallback preserves every code unit, so offsets stay valid and line timing is never lost.
 */
export const segmentTextWords = (text: string): LyricWordSegment[] => {
    if (!text) {
        return [];
    }

    const Segmenter = typeof Intl !== 'undefined' ? Intl.Segmenter : undefined;
    if (Segmenter) {
        try {
            return Array.from(new Segmenter(undefined, { granularity: 'word' }).segment(text), part => ({
                segment: part.segment,
                index: part.index,
                isWordLike: part.isWordLike ?? isWordLikeText(part.segment),
            }));
        } catch {
            // The grapheme fallback below preserves every code unit and the line timing.
        }
    }

    return segmentsFromBoundaries(splitLyricGraphemes(text));
};

/**
 * True when the boundaries reconstruct the text exactly. A saved segmentation that fails this is
 * stale (the lyric source changed under it) and must be ignored rather than applied at an offset.
 */
export const isValidWordSegmentation = (text: string, boundaries: string[] | undefined): boolean => (
    Array.isArray(boundaries)
    && boundaries.length > 0
    && boundaries.every(segment => typeof segment === 'string')
    && boundaries.join('') === text
);

/** Word segments for a line: the user's saved split when it is valid, else Intl.Segmenter. */
export const segmentLyricWords = (line: Pick<Line, 'fullText' | 'wordSegments'>): LyricWordSegment[] => {
    if (isValidWordSegmentation(line.fullText, line.wordSegments)) {
        return segmentsFromBoundaries(line.wordSegments!);
    }

    return segmentTextWords(line.fullText);
};

/** Whether this line will render with a user-supplied split rather than the default one. */
export const hasWordSegmentationOverride = (line: Pick<Line, 'fullText' | 'wordSegments'>): boolean => (
    isValidWordSegmentation(line.fullText, line.wordSegments)
);
