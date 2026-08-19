import { describe, expect, it, vi } from 'vitest';
import type { Line } from '@/types';
import {
    buildTemperaSegments,
    compileTemperaProgram,
    findTemperaParagraphIndexAtTime,
    resolveTemperaParagraphGapThreshold,
    TEMPERA_SHOT_KINDS,
} from '@/components/visualizer/tempera/temperaProgram';
import { TEMPERA_DECOR_MOTIFS, TEMPERA_TRANSITION_KINDS } from '@/components/visualizer/tempera/types';

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

    it('slices lines into half-phrase shots that tile the paragraph without holes', () => {
        const lines = Array.from({ length: 6 }, (_, index) => line(
            `first second third fourth fifth ${index}`,
            index * 4,
            index * 4 + 3.6,
            [
                { text: 'first', startTime: index * 4, endTime: index * 4 + 0.6 },
                { text: 'second', startTime: index * 4 + 0.6, endTime: index * 4 + 1.2 },
                { text: 'third', startTime: index * 4 + 1.2, endTime: index * 4 + 1.8 },
                { text: 'fourth', startTime: index * 4 + 1.8, endTime: index * 4 + 2.4 },
                { text: 'fifth', startTime: index * 4 + 2.4, endTime: index * 4 + 3 },
                { text: `${index}`, startTime: index * 4 + 3, endTime: index * 4 + 3.6 },
            ],
        ));
        const program = compileTemperaProgram(lines, 'grouping');

        program.paragraphs.forEach(paragraph => {
            // Every shot draws from exactly one line, and a line takes more than one shot.
            const perLine = new Map<number, number>();
            paragraph.shots.forEach(shot => {
                expect(shot.slices).toHaveLength(1);
                const slice = shot.slices[0];
                expect(slice.segmentEnd).toBeGreaterThan(slice.segmentStart);
                expect(shot.endTime).toBeGreaterThan(shot.startTime);
                perLine.set(slice.lineIndex, (perLine.get(slice.lineIndex) ?? 0) + 1);
            });
            expect(Math.max(...perLine.values())).toBeGreaterThan(1);

            // Consecutive shots tile: the next one opens exactly where the last one closed.
            paragraph.shots.forEach((shot, index) => {
                const next = paragraph.shots[index + 1];
                if (next) expect(shot.endTime).toBeCloseTo(next.startTime, 6);
            });
            expect(paragraph.shots.at(-1)!.endTime)
                .toBeGreaterThanOrEqual(paragraph.lines.at(-1)!.renderEndTime);

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

    it('compiles deterministic screentone decor for every shot', () => {
        const lines = [
            line('第一句歌词很长可以撑满一个镜头', 0, 3),
            line('第二句歌词继续往下走', 3.2, 6),
            line('第三句换一个分镜', 10, 13),
            line('第四句收尾', 13.2, 16),
        ];
        const first = compileTemperaProgram(lines, 'decor');
        const second = compileTemperaProgram(lines, 'decor');
        expect(first).toEqual(second);

        const shots = first.paragraphs.flatMap(paragraph => paragraph.shots);
        expect(shots.length).toBeGreaterThan(1);
        shots.forEach(shot => {
            expect(TEMPERA_DECOR_MOTIFS).toContain(shot.decor.motif);
            expect(Math.abs(shot.decor.hatchAngle)).toBeLessThanOrEqual(Math.PI / 4);
            expect(shot.decor.crossCount).toBeGreaterThanOrEqual(1);
            expect(shot.decor.crossCount).toBeLessThanOrEqual(3);
            expect(Number.isInteger(shot.decor.scribbleSeed)).toBe(true);
        });
        // Neighbouring shots must not repeat a motif, otherwise the MG layer stops reading
        // as a cut. The guarantee spans paragraph boundaries too.
        const motifs = shots.map(shot => shot.decor.motif);
        for (let index = 1; index < motifs.length; index += 1) {
            expect(motifs[index]).not.toBe(motifs[index - 1]);
        }
        expect(compileTemperaProgram(lines, 'other-seed').paragraphs.flatMap(p => p.shots).map(s => s.decor.motif))
            .not.toEqual(motifs);
    });

    it('scatters margin fragments taken from the paragraph text on sparse shots', () => {
        const program = compileTemperaProgram([
            line('嗯', 0, 2),
            line('后面还有一整段歌词继续唱下去', 10, 14),
        ], 'fragments');
        const quiet = program.paragraphs[0].shots[0];
        expect(quiet.kind).toBe('quiet-line');
        expect(quiet.decor.fragments.length).toBeGreaterThan(0);

        const pool = program.paragraphs.flatMap(paragraph => paragraph.lines)
            .map(item => item.line.fullText).join('');
        quiet.decor.fragments.forEach(fragment => {
            expect(pool).toContain(fragment.char);
            expect(fragment.char.trim()).toBe(fragment.char);
            expect(fragment.x).toBeGreaterThan(0);
            expect(fragment.x).toBeLessThan(1);
            expect(fragment.y).toBeGreaterThan(0);
            expect(fragment.y).toBeLessThan(1);
            expect(fragment.scale).toBeGreaterThan(0);
        });
    });

    it('leaves dense compositions free of margin fragments', () => {
        const program = compileTemperaProgram([
            line('副歌来了要唱得很满', 0, 2, undefined, { isChorus: true }),
            line('一起唱吧把声音放大', 2.2, 4, undefined, { isChorus: true }),
        ], 'dense');
        expect(program.paragraphs[0].kind).toBe('chorus');
        expect(program.paragraphs[0].shots[0].decor.fragments).toEqual([]);
    });

    it('turns the flow angle only slightly between consecutive shots', () => {
        const program = compileTemperaProgram([
            line('第一句歌词很长可以撑满一个镜头', 0, 3),
            line('第二句歌词继续往下走', 3.2, 6),
            line('第三句换一个分镜', 10, 13),
            line('第四句收尾这里也要够长', 13.2, 16),
            line('第五句还要再多一点内容', 20, 23),
        ], 'flow');
        const flows = program.paragraphs.flatMap(paragraph => paragraph.shots).map(shot => shot.flowAngle);
        expect(flows.length).toBeGreaterThan(2);
        for (let index = 1; index < flows.length; index += 1) {
            // A small turn keeps the graphics sweeping the same way across a cut; a big jump
            // would make the boundary read as an edit.
            expect(Math.abs(flows[index] - flows[index - 1])).toBeLessThanOrEqual(0.4);
        }
        // Camera travel is aligned to that flow rather than to a fixed axis.
        program.paragraphs.flatMap(paragraph => paragraph.shots).forEach(shot => {
            const travelX = shot.cameraEnd.x - shot.camera.x;
            const travelY = shot.cameraEnd.y - shot.camera.y;
            if (Math.hypot(travelX, travelY) < 1e-6) return;
            const alignment = Math.cos(shot.flowAngle) * travelX + Math.sin(shot.flowAngle) * travelY;
            expect(alignment).toBeGreaterThan(0);
        });
    });

    it('gives boundaries a transition long enough for the graphics to carry the cut', () => {
        const program = compileTemperaProgram([
            line('alpha', 0, 2),
            line('beta', 8, 10),
            line('gamma', 20, 22),
        ], 'duration');
        const transitions = program.paragraphs.map(paragraph => paragraph.transitionOut).filter(Boolean);
        expect(transitions.length).toBeGreaterThan(0);
        transitions.forEach(transition => {
            const duration = transition!.endTime - transition!.startTime;
            expect(duration).toBeGreaterThanOrEqual(0.35);
            expect(duration).toBeLessThanOrEqual(1.0001);
        });
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
