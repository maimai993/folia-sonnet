import { describe, expect, it } from 'vitest';
import {
    LYRIC_SEGMENTATION_SYNTAX_SPEC,
    looksLikeSegmentationPaste,
    parseLyricSegmentationQuery,
} from '../../../src/components/command-palette/lyricSegmentationQuery';
import { SEGMENTATION_DELIMITER } from '../../../src/utils/lyrics/lyricSegmentationRecord';

// test/unit/lyrics/lyricSegmentationQuery.test.ts
// The palette input is the surface's only input: it takes the `--flag` actions and it takes a
// pasted segmentation. Those two have to stay distinguishable, which is what these pin.

describe('parseLyricSegmentationQuery', () => {
    it.each([
        ['--ai', 'ai'],
        ['--segment', 'ai'],
        ['--copy-prompt', 'copy-prompt'],
        ['--prompt', 'copy-prompt'],
        ['--copy-seg', 'copy-seg'],
        ['--copy-current', 'copy-seg'],
        ['--copy-segmentation', 'copy-seg'],
    ])('resolves %s to %s', (input, action) => {
        expect(parseLyricSegmentationQuery(input).action).toBe(action);
    });

    it('reports a half-typed flag so completions can be offered', () => {
        const parsed = parseLyricSegmentationQuery('--co');
        expect(parsed.action).toBeNull();
        expect(parsed.actionDraft).toBe('co');
    });

    it('treats plain text as text, not as an action', () => {
        expect(parseLyricSegmentationQuery('我/想要').action).toBeNull();
        expect(parseLyricSegmentationQuery('').action).toBeNull();
    });

    it('declares every flag it resolves', () => {
        const names = LYRIC_SEGMENTATION_SYNTAX_SPEC.flags.map(flag => flag.name);
        expect(names).toEqual(['ai', 'copy-seg', 'copy-prompt']);
        expect(LYRIC_SEGMENTATION_SYNTAX_SPEC.facets).toEqual([]);
    });
});

describe('looksLikeSegmentationPaste', () => {
    const looks = (text: string) => looksLikeSegmentationPaste(text, SEGMENTATION_DELIMITER);

    it('recognises the two exchange formats', () => {
        expect(looks('我/想要/说\n你/听见/了吗')).toBe(true);   // delimiter, multi-line
        expect(looks('我/想要/说')).toBe(true);                 // delimiter, single line
        expect(looks('[["我","想要"]]')).toBe(true);            // JSON
        expect(looks('  \n [["a"]] ')).toBe(true);              // JSON with surrounding space
    });

    it('leaves ordinary typing and flags alone, so a paste of those still behaves normally', () => {
        expect(looks('--ai')).toBe(false);
        expect(looks('--copy-prompt')).toBe(false);
        expect(looks('some words')).toBe(false);
        expect(looks('   ')).toBe(false);
        expect(looks('')).toBe(false);
    });
});
