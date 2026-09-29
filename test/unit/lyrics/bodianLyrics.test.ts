import { describe, expect, it } from 'vitest';
import { decodeBodianWordTiming, parseBodianLyrics } from '@/utils/lyrics/bodianLyrics';

// test/unit/lyrics/bodianLyrics.test.ts
// Timing pairs are from the observed protocol; lyric words are replaced with synthetic text.

describe('Bodian word timing', () => {
    it('decodes variable octal factors rather than interpreting obfuscated pairs as milliseconds', () => {
        const content = '[kuwo:127]\n[00:29.264]<2730,-2730>甲<5864,376>乙<9392,3120>丙';
        expect(decodeBodianWordTiming(content)).toContain('<0,390>甲<390,392>乙<782,448>丙');
        const result = parseBodianLyrics(content);
        expect(result.lyrics?.isWordByWord).toBe(true);
        const words = result.lyrics!.lines.find(line => line.fullText === '甲乙丙')!.words;
        expect(words[0].startTime).toBeCloseTo(29.264);
        expect(words[0].endTime).toBeCloseTo(29.654);
        expect(words[2].startTime).toBeCloseTo(30.046);
        expect(words[2].endTime).toBeCloseTo(30.494);
    });

    it('uses the per-file factors and keeps untagged decoded word pairs usable', () => {
        expect(decodeBodianWordTiming('[kuwo:27]\n[00:01.000]<50,-10>甲')).toContain('<10,10>甲');
        expect(decodeBodianWordTiming('[00:01.000]<50,-10>甲')).toContain('<20,30>甲');
    });

    it('falls back to clean line lyrics when the timing factor is invalid', () => {
        const result = parseBodianLyrics('[kuwo:0]\n[00:01.000]<7,-7>甲');
        expect(result.lyrics?.lines[0].fullText).toBe('甲');
        expect(result.wordByWordText).toBeUndefined();
    });

    it('distinguishes missing lyrics from a declared instrumental', () => {
        expect(parseBodianLyrics('')).toMatchObject({ lyrics: null, isPureMusic: false });
        expect(parseBodianLyrics('[00:00.000]纯音乐，请欣赏')).toMatchObject({ isPureMusic: true });
    });
});
