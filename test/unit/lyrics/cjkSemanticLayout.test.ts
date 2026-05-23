import { describe, expect, it, vi } from 'vitest';
import type { Word } from '@/types';
import { buildCjkSemanticLayoutUnits } from '@/utils/lyrics/cjkSemanticLayout';

// test/unit/lyrics/cjkSemanticLayout.test.ts
// Verifies CJK layout grouping while preserving original word timing.

const createCharacterWords = (text: string): Word[] => Array.from(text).map((char, index) => ({
    text: char,
    startTime: index,
    endTime: index + 0.5,
}));

const createTokenWords = (tokens: string[]): Word[] => tokens.map((token, index) => ({
    text: token,
    startTime: index,
    endTime: index + 0.5,
}));

describe('buildCjkSemanticLayoutUnits', () => {
    it('groups a CJK word while preserving per-character timing', () => {
        const words = createCharacterWords('世界');
        const units = buildCjkSemanticLayoutUnits({ fullText: '世界', words });

        expect(units).toHaveLength(1);
        expect(units[0].text).toBe('世界');
        expect(units[0].words).toEqual(words);
        expect(units[0].startTime).toBe(0);
        expect(units[0].endTime).toBe(1.5);
        expect(units[0].isSemantic).toBe(true);
    });

    it('keeps common Chinese words together for layout', () => {
        const fullText = '编织那没有诗意，却能将你带到现实的神文之诗。';
        const units = buildCjkSemanticLayoutUnits({
            fullText,
            words: createCharacterWords(fullText),
        });
        const unitTexts = units.map(unit => unit.text);

        expect(unitTexts).toContain('编织');
        expect(unitTexts).toContain('没有');
        expect(unitTexts).toContain('诗意，');
        expect(unitTexts).toContain('现实');
        expect(units.find(unit => unit.text === '现实')?.words.map(word => word.text)).toEqual(['现', '实']);
    });

    it('maps common Japanese preview segments', () => {
        const fullText = '詩情を持たずとも、あなたを現実へと導くその神文の詩を紡ぐ。';
        const units = buildCjkSemanticLayoutUnits({
            fullText,
            words: createCharacterWords(fullText),
        });
        const unitTexts = units.map(unit => unit.text);

        expect(unitTexts).toContain('詩情');
        expect(unitTexts).toContain('あなた');
        expect(unitTexts).toContain('現実');
        expect(units.find(unit => unit.text === 'あなた')?.words.map(word => word.text)).toEqual(['あ', 'な', 'た']);
    });

    it('leaves non-CJK tokenized lyrics unchanged', () => {
        const words = createTokenWords(['Weave', 'that', 'prosaic', 'divine', 'poem']);
        const units = buildCjkSemanticLayoutUnits({
            fullText: 'Weave that prosaic divine poem',
            words,
        });

        expect(units.map(unit => unit.text)).toEqual(words.map(word => word.text));
        expect(units.every(unit => unit.words.length === 1 && !unit.isSemantic)).toBe(true);
    });

    it('falls back when Intl.Segmenter is unavailable', () => {
        vi.stubGlobal('Intl', { ...Intl, Segmenter: undefined });

        try {
            const words = createCharacterWords('世界');
            const units = buildCjkSemanticLayoutUnits({ fullText: '世界', words });

            expect(units.map(unit => unit.text)).toEqual(['世', '界']);
            expect(units.every(unit => unit.words.length === 1 && !unit.isSemantic)).toBe(true);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('falls back when fullText cannot be aligned to words', () => {
        const words = createCharacterWords('世界');
        const units = buildCjkSemanticLayoutUnits({ fullText: '世界啊', words });

        expect(units.map(unit => unit.text)).toEqual(['世', '界']);
        expect(units.every(unit => unit.words.length === 1 && !unit.isSemantic)).toBe(true);
    });
});
