import { describe, expect, it } from 'vitest';
import {
    parseEnhancedLRC,
    parseLRC,
    parseLyricsByFormat,
    parseVTT,
    parseYRC
} from '@/utils/lyrics/parserCore';

const expectNonDecreasingWordTimes = (words: Array<{ startTime: number; endTime: number }>) => {
    for (let index = 1; index < words.length; index += 1) {
        expect(words[index].startTime).toBeGreaterThanOrEqual(words[index - 1].startTime);
        expect(words[index].endTime).toBeGreaterThanOrEqual(words[index].startTime);
    }
};

describe('parserCore', () => {
    it('parses standard LRC with translation matching and interlude insertion', () => {
        const lyrics = parseLRC(
            '[00:04.00]Hello world\n[00:10.00]再见',
            '[00:04.20]你好 世界\n[00:10.10]Goodbye'
        );

        expect(lyrics.lines).toHaveLength(3);
        expect(lyrics.lines[0].fullText).toBe('......');
        expect(lyrics.lines[1].fullText).toBe('Hello world');
        expect(lyrics.lines[1].translation).toBe('你好 世界');
        expect(lyrics.lines[2].fullText).toBe('再见');
        expect(lyrics.lines[2].translation).toBe('Goodbye');
        expectNonDecreasingWordTimes(lyrics.lines[1].words);
    });

    it('parses enhanced LRC metadata and precise word timing', () => {
        const lyrics = parseEnhancedLRC(
            '[ti:Song]\n[ar:Artist]\n[00:00.000]<00:00.000>你<00:00.300>好<00:00.600>!<00:00.900>',
            '[00:00.000]Hello'
        );

        expect(lyrics.title).toBe('Song');
        expect(lyrics.artist).toBe('Artist');
        expect(lyrics.lines).toHaveLength(1);
        expect(lyrics.lines[0].fullText).toBe('你好!');
        expect(lyrics.lines[0].translation).toBe('Hello');
        expect(lyrics.lines[0].words.map(word => word.text)).toEqual(['你', '好', '!']);
        expect(lyrics.lines[0].words[0].startTime).toBe(0);
        expect(lyrics.lines[0].words[0].endTime).toBe(0.3);
    });

    it('parses YRC with translation alignment and preserved word timing', () => {
        const lyrics = parseYRC(
            '[1000,800](1000,250,0)你(1250,250,0)好',
            '[00:01.00]hello'
        );

        expect(lyrics.lines).toHaveLength(1);
        expect(lyrics.lines[0].startTime).toBe(1);
        expect(lyrics.lines[0].endTime).toBe(1.8);
        expect(lyrics.lines[0].fullText).toBe('你好');
        expect(lyrics.lines[0].translation).toBe('hello');
        expect(lyrics.lines[0].words.map(word => word.text)).toEqual(['你', '好']);
        expectNonDecreasingWordTimes(lyrics.lines[0].words);
    });

    it('parses VTT cues and strips cue markup', () => {
        const lyrics = parseVTT(
            'WEBVTT\n\n00:00.000 --> 00:01.500\n<c.red>Hello&nbsp;&amp; hi</c>',
            'WEBVTT\n\n00:00.000 --> 00:01.500\n你好'
        );

        expect(lyrics.lines).toHaveLength(1);
        expect(lyrics.lines[0].fullText).toBe('Hello & hi');
        expect(lyrics.lines[0].translation).toBe('你好');
        expect(lyrics.lines[0].endTime).toBe(1.5);
    });

    it('dispatches formats through parseLyricsByFormat', () => {
        const lyrics = parseLyricsByFormat(
            'enhanced-lrc',
            '[00:00.000]<00:00.000>A<00:00.500>B<00:01.000>',
            ''
        );

        expect(lyrics.lines).toHaveLength(1);
        expect(lyrics.lines[0].words.map(word => word.text)).toEqual(['A', 'B']);
    });
});
