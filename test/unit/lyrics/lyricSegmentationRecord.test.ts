import { describe, expect, it } from 'vitest';
import {
    SegmentationImportError,
    applyLyricWordSegmentation,
    buildSegmentationExportText,
    countAppliedSegmentationLines,
    createLyricSegmentationRecord,
    getLyricLineSegmentationKey,
    isLyricSegmentationRecord,
    parseSegmentationImport,
} from '../../../src/utils/lyrics/lyricSegmentationRecord';
import type { LyricData, Line } from '../../../src/types';

const line = (fullText: string, startTime: number): Line => ({
    fullText,
    startTime,
    endTime: startTime + 2,
    words: Array.from(fullText).map((text, index) => ({
        text,
        startTime: startTime + index * 0.1,
        endTime: startTime + (index + 1) * 0.1,
    })),
});

const lyrics: LyricData = { lines: [line('我想要说的话', 1), line('你听见了吗', 4)] };

const recordFor = (rows: string[][]) => createLyricSegmentationRecord('local:1', 'manual', {
    [getLyricLineSegmentationKey(lyrics.lines[0])]: rows[0],
    [getLyricLineSegmentationKey(lyrics.lines[1])]: rows[1],
});

describe('getLyricLineSegmentationKey', () => {
    it('is stable for the same line and differs when the text or time changes', () => {
        expect(getLyricLineSegmentationKey(lyrics.lines[0])).toBe(getLyricLineSegmentationKey(line('我想要说的话', 1)));
        expect(getLyricLineSegmentationKey(lyrics.lines[0])).not.toBe(getLyricLineSegmentationKey(line('我想要说的话', 2)));
        expect(getLyricLineSegmentationKey(lyrics.lines[0])).not.toBe(getLyricLineSegmentationKey(line('别的词', 1)));
    });
});

describe('applyLyricWordSegmentation', () => {
    it('bakes matching boundaries onto the lines', () => {
        const result = applyLyricWordSegmentation(lyrics, recordFor([['我', '想要', '说', '的话'], ['你', '听见', '了吗']]));
        expect(result?.lines[0].wordSegments).toEqual(['我', '想要', '说', '的话']);
        expect(result?.lines[1].wordSegments).toEqual(['你', '听见', '了吗']);
    });

    it('leaves the lyrics untouched when no line matches', () => {
        const stale = createLyricSegmentationRecord('local:1', 'ai', { '999|其他歌词': ['其他', '歌词'] });
        expect(applyLyricWordSegmentation(lyrics, stale)).toBe(lyrics);
    });

    it('skips a row that no longer rebuilds its line', () => {
        const record = recordFor([['我', '想要'], ['你', '听见', '了吗']]);
        const result = applyLyricWordSegmentation(lyrics, record);
        expect(result?.lines[0].wordSegments).toBeUndefined();
        expect(result?.lines[1].wordSegments).toEqual(['你', '听见', '了吗']);
    });

    it('passes null lyrics and a missing record straight through', () => {
        expect(applyLyricWordSegmentation(null, recordFor([['我'], ['你']]))).toBeNull();
        expect(applyLyricWordSegmentation(lyrics, null)).toBe(lyrics);
    });
});

describe('countAppliedSegmentationLines', () => {
    it('counts only the rows that still land', () => {
        expect(countAppliedSegmentationLines(lyrics, recordFor([['我', '想要'], ['你', '听见', '了吗']]))).toBe(1);
        expect(countAppliedSegmentationLines(lyrics, null)).toBe(0);
    });
});

describe('buildSegmentationExportText', () => {
    it('round-trips through parseSegmentationImport', () => {
        const exported = buildSegmentationExportText(lyrics);
        expect(exported.split('\n')).toHaveLength(lyrics.lines.length);

        const { lines, appliedCount } = parseSegmentationImport(exported, lyrics);
        expect(appliedCount).toBe(2);
        expect(applyLyricWordSegmentation(lyrics, createLyricSegmentationRecord('local:1', 'manual', lines)))
            .not.toBe(lyrics);
    });
});

describe('parseSegmentationImport', () => {
    it('reads the delimiter format', () => {
        const { lines, appliedCount } = parseSegmentationImport('我/想要/说/的话\n你/听见/了吗', lyrics);
        expect(appliedCount).toBe(2);
        expect(lines[getLyricLineSegmentationKey(lyrics.lines[0])]).toEqual(['我', '想要', '说', '的话']);
    });

    it('sniffs and reads the JSON format', () => {
        const { lines } = parseSegmentationImport('[["我","想要","说","的话"],["你","听见","了吗"]]', lyrics);
        expect(lines[getLyricLineSegmentationKey(lyrics.lines[1])]).toEqual(['你', '听见', '了吗']);
    });

    it('tolerates CRLF line endings from a pasted response', () => {
        expect(parseSegmentationImport('我/想要/说/的话\r\n你/听见/了吗', lyrics).appliedCount).toBe(2);
    });

    it('rejects a row count that does not match the lyrics', () => {
        expect(() => parseSegmentationImport('我/想要/说/的话', lyrics)).toThrow(SegmentationImportError);
        expect(() => parseSegmentationImport('我/想要/说/的话', lyrics)).toThrow('line-count-mismatch');
    });

    it('rejects a row that does not reproduce its line, naming the row', () => {
        try {
            parseSegmentationImport('我/想要/说/的话\n你/听见', lyrics);
            expect.unreachable('expected a mismatch');
        } catch (error) {
            expect(error).toBeInstanceOf(SegmentationImportError);
            expect((error as SegmentationImportError).message).toBe('line-text-mismatch');
            expect((error as SegmentationImportError).row).toBe(2);
        }
    });

    it('rejects empty and malformed input', () => {
        expect(() => parseSegmentationImport('   ', lyrics)).toThrow('empty');
        expect(() => parseSegmentationImport('[not json', lyrics)).toThrow('invalid-json');
        expect(() => parseSegmentationImport('["flat"]', lyrics)).toThrow('invalid-json-shape');
    });
});

describe('isLyricSegmentationRecord', () => {
    it('accepts a record it produced and rejects junk from storage', () => {
        expect(isLyricSegmentationRecord(recordFor([['我'], ['你']]))).toBe(true);
        expect(isLyricSegmentationRecord(null)).toBe(false);
        expect(isLyricSegmentationRecord({ version: 2, songKey: 'x', updatedAt: 0, source: 'ai', lines: {} })).toBe(false);
        expect(isLyricSegmentationRecord({ version: 1, songKey: 'x', updatedAt: 0, source: 'other', lines: {} })).toBe(false);
    });
});
