import type { Line, Word } from '../../types';

// src/utils/lyrics/cjkSemanticLayout.ts
// Builds layout-only CJK word groups without changing the original lyric timing.

export interface LyricLayoutUnit {
    text: string;
    words: Word[];
    startTime: number;
    endTime: number;
    isSemantic: boolean;
}

interface WordSegment {
    segment: string;
    isWordLike?: boolean;
}

const CJK_REGEX = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/;
const WHITESPACE_REGEX = /^\s+$/;

const hasCjkText = (text: string) => CJK_REGEX.test(text);

export const createSingleWordLayoutUnits = (words: Word[]): LyricLayoutUnit[] => words.map(word => ({
    text: word.text,
    words: [word],
    startTime: word.startTime,
    endTime: word.endTime,
    isSemantic: false,
}));

const getWordSegments = (text: string): WordSegment[] | null => {
    const Segmenter = Intl?.Segmenter;
    if (!Segmenter) {
        return null;
    }

    try {
        return Array.from(new Segmenter(undefined, { granularity: 'word' }).segment(text), segment => ({
            segment: segment.segment,
            isWordLike: segment.isWordLike,
        }));
    } catch {
        return null;
    }
};

const appendWordsToUnit = (unit: LyricLayoutUnit, text: string, words: Word[]) => {
    unit.text += text;
    unit.words.push(...words);
    unit.endTime = words[words.length - 1]?.endTime ?? unit.endTime;
};

const mapSegmentsToWords = (segments: WordSegment[], words: Word[]): LyricLayoutUnit[] | null => {
    const units: LyricLayoutUnit[] = [];
    let wordIndex = 0;

    for (const segment of segments) {
        const segmentText = segment.segment;
        if (!segmentText || WHITESPACE_REGEX.test(segmentText)) {
            continue;
        }

        const startWordIndex = wordIndex;
        let collectedText = '';

        while (wordIndex < words.length && collectedText.length < segmentText.length) {
            collectedText += words[wordIndex].text;
            wordIndex += 1;

            if (!segmentText.startsWith(collectedText)) {
                return null;
            }
        }

        if (collectedText !== segmentText) {
            return null;
        }

        const segmentWords = words.slice(startWordIndex, wordIndex);
        const firstWord = segmentWords[0];
        const lastWord = segmentWords[segmentWords.length - 1];
        if (!firstWord || !lastWord) {
            return null;
        }

        if (!segment.isWordLike && units.length > 0) {
            appendWordsToUnit(units[units.length - 1], segmentText, segmentWords);
            continue;
        }

        units.push({
            text: segmentText,
            words: segmentWords,
            startTime: firstWord.startTime,
            endTime: lastWord.endTime,
            isSemantic: Boolean(segment.isWordLike && hasCjkText(segmentText) && segmentWords.length > 1),
        });
    }

    if (wordIndex !== words.length || units.length === 0) {
        return null;
    }

    return units;
};

export const buildCjkSemanticLayoutUnits = (
    line: Pick<Line, 'fullText' | 'words'>
): LyricLayoutUnit[] => {
    if (line.words.length === 0) {
        return [];
    }

    const fallbackUnits = createSingleWordLayoutUnits(line.words);
    if (!hasCjkText(line.fullText)) {
        return fallbackUnits;
    }

    const segments = getWordSegments(line.fullText);
    if (!segments) {
        return fallbackUnits;
    }

    return mapSegmentsToWords(segments, line.words) ?? fallbackUnits;
};
