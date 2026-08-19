import { describe, expect, it, vi } from 'vitest';
import type { Line } from '@/types';
import {
    buildTemperaSegments,
    compileTemperaProgram,
    findTemperaParagraphIndexAtTime,
    resolveTemperaParagraphGapThreshold,
    TEMPERA_SHOT_KINDS,
} from '@/components/visualizer/tempera/temperaProgram';
import { TEMPERA_TRANSITION_KINDS } from '@/components/visualizer/tempera/types';

// test/unit/visualizer/temperaProgram.test.ts
// Locks Tempera's lossless segment compiler, deterministic shot direction, and seek-safe lookup.
const line = (
    fullText: string,
    startTime: number,
    endTime: number,
    words: Line['words'] = [{ text: fullText, startTime, endTime }],
    extra: Partial<Line> = {},
): Line => ({ fullText, startTime, endTime, words, ...extra });

describe('Tempera program compiler', () => {
    it('registers every block-composition shot kind exactly once', () => {
        expect(TEMPERA_SHOT_KINDS).toEqual([
            'duo-split',
            'band-strip',
            'frame-window',
            'poster-panel',
            'quiet-line',
        ]);
        expect(new Set(TEMPERA_SHOT_KINDS).size).toBe(TEMPERA_SHOT_KINDS.length);
    });

    it('preserves CJK, whitespace, punctuation, and parser timing losslessly', () => {
        const source = line('世界， 再见！', 1, 4, [
            { text: '世界', startTime: 1, endTime: 2 },
            { text: '再见', startTime: 2.5, endTime: 3.7 },
        ]);
        const segments = buildTemperaSegments(source);

        expect(segments.map(segment => segment.text).join('')).toBe(source.fullText);
        expect(segments[0].text).toContain('，');
        expect(segments.at(-1)?.endTime).toBeLessThanOrEqual(source.endTime);
    });

    it('keeps repeated Latin words and contractions in source order', () => {
        const source = line("It's time, time.", 0, 3, [
            { text: "It's", startTime: 0, endTime: 0.8 },
            { text: 'time', startTime: 1, endTime: 1.7 },
            { text: 'time', startTime: 2, endTime: 2.7 },
        ]);
        const segments = buildTemperaSegments(source);

        expect(segments.map(segment => segment.text).join('')).toBe(source.fullText);
        expect(segments.filter(segment => segment.text.includes('time'))).toHaveLength(2);
        expect(segments.filter(segment => segment.text.includes('time'))[1].startTime).toBeGreaterThanOrEqual(2);
    });

    it('falls back losslessly when Intl.Segmenter is unavailable', () => {
        const original = Intl.Segmenter;
        vi.stubGlobal('Intl', { ...Intl, Segmenter: undefined });
        const source = line('歌🎵 A!', 0, 2);

        expect(buildTemperaSegments(source).map(segment => segment.text).join('')).toBe(source.fullText);
        vi.stubGlobal('Intl', { ...Intl, Segmenter: original });
    });

    it('computes an adaptive threshold and respects timed and metadata boundaries', () => {
        const lines = [
            line('one', 0, 1, undefined, { blockIndex: 0 }),
            line('two', 1.2, 2.2, undefined, { blockIndex: 0 }),
            line('three', 5, 6, undefined, { blockIndex: 1 }),
        ];

        expect(resolveTemperaParagraphGapThreshold(lines)).toBeGreaterThanOrEqual(1.25);
        const program = compileTemperaProgram(lines, 'stable-song');
        expect(program.paragraphs).toHaveLength(2);
        expect(program.paragraphs[1].boundary).toBe('metadata');
    });

    it('is deterministic for the same seed and never repeats adjacent shot kinds', () => {
        const lines = Array.from({ length: 12 }, (_, index) => line(
            `歌词第 ${index} 行`,
            index * 4,
            index * 4 + 3,
        ));
        const first = compileTemperaProgram(lines, 'seed-a');
        const second = compileTemperaProgram(lines, 'seed-a');

        const shotKinds = first.paragraphs.flatMap(paragraph => paragraph.shots.map(shot => shot.kind));
        expect(shotKinds.length).toBeGreaterThan(1);
        expect(second.paragraphs.flatMap(paragraph => paragraph.shots.map(shot => shot.kind)))
            .toEqual(shotKinds);
        for (let index = 1; index < shotKinds.length; index += 1) {
            expect(shotKinds[index]).not.toBe(shotKinds[index - 1]);
        }
        expect(shotKinds.every(kind => TEMPERA_SHOT_KINDS.includes(kind))).toBe(true);
    });

    it('keeps shot groups within the 4-line / 6-second envelope and clamps render tails', () => {
        const lines = Array.from({ length: 6 }, (_, index) => line(
            `line ${index}`,
            index * 2,
            index * 2 + 1.8,
        ));
        const program = compileTemperaProgram(lines, 'grouping');

        program.paragraphs.forEach(paragraph => {
            paragraph.shots.forEach(shot => {
                expect(shot.lineIndices.length).toBeLessThanOrEqual(4);
                expect(shot.endTime - shot.startTime).toBeLessThanOrEqual(6.0 + 1.8);
                expect(shot.endTime).toBeGreaterThanOrEqual(shot.startTime);
            });
            paragraph.lines.forEach((compiled, index) => {
                const next = paragraph.lines[index + 1];
                if (next) expect(compiled.renderEndTime).toBeLessThanOrEqual(next.line.startTime);
            });
        });
    });

    it('assigns valid, non-repeating transitions between paragraphs only', () => {
        const lines = [
            line('alpha', 0, 2),
            line('beta', 2.2, 4),
            line('gamma', 8, 10),
            line('delta', 10.2, 12),
            line('omega', 16, 18),
        ];
        const program = compileTemperaProgram(lines, 'transitions');
        expect(program.paragraphs.length).toBeGreaterThanOrEqual(3);

        const transitions = program.paragraphs.map(paragraph => paragraph.transitionOut);
        expect(transitions.at(-1)).toBeNull();
        const kinds = transitions.filter(Boolean).map(transition => transition!.kind);
        kinds.forEach(kind => expect(TEMPERA_TRANSITION_KINDS).toContain(kind));
        for (let index = 1; index < kinds.length; index += 1) {
            expect(kinds[index]).not.toBe(kinds[index - 1]);
        }
        transitions.filter(Boolean).forEach(transition => {
            expect(transition!.endTime).toBeGreaterThan(transition!.startTime);
        });
    });

    it('routes short breath paragraphs to quiet-line and chorus away from it', () => {
        // A trailing normal paragraph keeps the short opener from being classified as outro.
        const breath = compileTemperaProgram([
            line('嗯', 0, 2),
            line('后面还有一整段歌词继续唱下去', 10, 14),
        ], 'breath');
        expect(breath.paragraphs[0].kind).toBe('breath');
        expect(breath.paragraphs[0].shots[0].kind).toBe('quiet-line');

        const chorus = compileTemperaProgram([
            line('副歌来了', 0, 2, undefined, { isChorus: true }),
            line('一起唱吧', 2.2, 4, undefined, { isChorus: true }),
        ], 'chorus');
        expect(chorus.paragraphs[0].kind).toBe('chorus');
        expect(chorus.paragraphs[0].shots[0].kind).not.toBe('quiet-line');
    });

    it('resolves the active paragraph for any seek target', () => {
        const lines = [
            line('one', 0, 2),
            line('two', 10, 12),
            line('three', 20, 22),
        ];
        const program = compileTemperaProgram(lines, 'seek');
        const lastIndex = program.paragraphs.length - 1;

        expect(findTemperaParagraphIndexAtTime(program, -5)).toBe(0);
        expect(findTemperaParagraphIndexAtTime(program, 0)).toBe(0);
        expect(findTemperaParagraphIndexAtTime(program, 999)).toBe(lastIndex);
    });
});
