import { describe, expect, it } from 'vitest';
import type { TemperaSegment } from '@/components/visualizer/tempera/types';
import { resolveTemperaLayout } from '@/components/visualizer/tempera/temperaLayout';

// test/unit/visualizer/temperaLayout.test.ts
// Locks the collage typesetter: reading order survives, the composition stays inside its
// region, and the seeded hierarchy (word sizes, row tilts, per-glyph entrances) is real.
const segment = (text: string, startTime: number, endTime: number): TemperaSegment => {
    const chars = Array.from(text);
    const step = (endTime - startTime) / Math.max(chars.length, 1);
    return {
        text,
        startOffset: 0,
        endOffset: text.length,
        startTime,
        endTime,
        isWordLike: true,
        graphemes: chars.map((char, index) => ({
            char,
            startTime: startTime + step * index,
            endTime: startTime + step * (index + 1),
        })),
    };
};

const LINE_A = [
    segment('remember', 0, 1),
    segment('the', 1, 1.3),
    segment('quiet', 1.3, 2),
];
const LINE_B = [
    segment('morning', 2, 2.8),
    segment('light', 2.8, 3.4),
];

const layout = (overrides: Partial<Parameters<typeof resolveTemperaLayout>[0]> = {}) => resolveTemperaLayout({
    lines: [LINE_A, LINE_B],
    shotKind: 'duo-split',
    width: 1280,
    height: 720,
    baseFontSize: 54,
    fontFamily: 'sans-serif',
    fontWeight: 600,
    seed: 4242,
    ...overrides,
});

describe('Tempera collage layout', () => {
    it('places every non-space grapheme once, in source order', () => {
        const placements = layout();
        const expected = [...LINE_A, ...LINE_B]
            .flatMap(item => item.graphemes.map(grapheme => grapheme.char))
            .filter(char => char.trim().length > 0);
        expect(placements.map(placement => placement.char)).toEqual(expected);
    });

    it('is deterministic per seed and varies across seeds', () => {
        expect(layout()).toEqual(layout());
        const other = layout({ seed: 99 });
        expect(other.map(item => [item.x, item.y])).not.toEqual(layout().map(item => [item.x, item.y]));
        // A different seed must not lose or reorder characters.
        expect(other.map(item => item.char)).toEqual(layout().map(item => item.char));
    });

    it('keeps the composition inside the viewport', () => {
        (['duo-split', 'band-strip', 'frame-window', 'poster-panel', 'quiet-line'] as const)
            .forEach(shotKind => {
                layout({ shotKind }).forEach(placement => {
                    expect(placement.x).toBeGreaterThan(-placement.fontSize);
                    expect(placement.x).toBeLessThan(1280 + placement.fontSize);
                    expect(placement.y).toBeGreaterThan(-placement.fontSize);
                    expect(placement.y).toBeLessThan(720 + placement.fontSize);
                });
            });
    });

    it('builds a size hierarchy instead of one uniform font size', () => {
        const sizes = new Set(layout().map(placement => Math.round(placement.fontSize)));
        expect(sizes.size).toBeGreaterThan(1);
        const values = [...sizes];
        // The hero word is meaningfully larger, not a rounding difference.
        expect(Math.max(...values) / Math.min(...values)).toBeGreaterThan(1.15);
    });

    it('tilts words and rows so the block never reads as plain typesetting', () => {
        const placements = layout();
        const rotations = new Set(placements.map(placement => placement.rotation.toFixed(5)));
        expect(rotations.size).toBeGreaterThan(1);
        placements.forEach(placement => {
            // Tilt stays subtle; this is a collage, not a scatter.
            expect(Math.abs(placement.rotation)).toBeLessThan(0.25);
        });
    });

    it('gives every glyph its own entrance vector', () => {
        const placements = layout();
        const vectors = new Set(placements.map(p => `${p.enterX.toFixed(3)}:${p.enterY.toFixed(3)}`));
        expect(vectors.size).toBe(placements.length);
        placements.forEach(placement => {
            expect(placement.enterScale).toBeGreaterThan(0.5);
            expect(placement.enterScale).toBeLessThan(1);
            expect(placement.driftPhase).toBeGreaterThanOrEqual(0);
            expect(placement.driftPhase).toBeLessThanOrEqual(Math.PI * 2);
        });
    });

    it('paces the settle window from the gap to the next glyph', () => {
        layout().forEach(placement => {
            const window = placement.settleTime - placement.startTime;
            expect(window).toBeGreaterThanOrEqual(0.3399);
            expect(window).toBeLessThanOrEqual(1.3501);
        });

        // A slow line stretches the entrance; a dense one keeps it tight.
        const slow = resolveTemperaLayout({
            lines: [[segment('slow', 0, 6)]],
            shotKind: 'duo-split',
            width: 1280,
            height: 720,
            baseFontSize: 54,
            fontFamily: 'sans-serif',
            fontWeight: 600,
            seed: 7,
        });
        const dense = resolveTemperaLayout({
            lines: [[segment('dense', 0, 0.5)]],
            shotKind: 'duo-split',
            width: 1280,
            height: 720,
            baseFontSize: 54,
            fontFamily: 'sans-serif',
            fontWeight: 600,
            seed: 7,
        });
        const windowOf = (items: ReturnType<typeof resolveTemperaLayout>) => (
            items[0].settleTime - items[0].startTime
        );
        expect(windowOf(slow)).toBeGreaterThan(windowOf(dense));
    });

    it('lets word segmentation set sizes without spacing the text out', () => {
        // Offsets are what tell a real space from a mere CJK segmentation boundary.
        const sequence = (texts: string[], separator: string) => {
            let offset = 0;
            let time = 0;
            return texts.map(text => {
                const startOffset = offset;
                const chars = Array.from(text);
                const startTime = time;
                time += chars.length * 0.2;
                offset = startOffset + text.length + separator.length;
                return {
                    ...segment(text, startTime, time),
                    startOffset,
                    endOffset: startOffset + text.length,
                };
            });
        };
        const spanOf = (line: ReturnType<typeof sequence>) => {
            const placements = resolveTemperaLayout({
                lines: [line],
                shotKind: 'duo-split',
                width: 1280,
                height: 720,
                baseFontSize: 54,
                fontFamily: 'sans-serif',
                fontWeight: 600,
                seed: 31,
            });
            const xs = placements.map(placement => placement.x);
            return { span: Math.max(...xs) - Math.min(...xs), size: placements[0].fontSize };
        };

        const tight = spanOf(sequence(['再現性', 'は', '未知'], ''));
        const spaced = spanOf(sequence(['再現性', 'は', '未知'], ' '));
        // Identical segmentation means identical sizes; only the spacing may differ.
        expect(spaced.size).toBeCloseTo(tight.size, 6);
        expect(spaced.span).toBeGreaterThan(tight.span);
        // Two boundaries of real space, and nothing close to that without them.
        expect(spaced.span - tight.span).toBeGreaterThan(tight.size * 0.35);
        expect(spaced.span - tight.span).toBeLessThan(tight.size * 0.7);
    });

    it('returns nothing for an empty shot', () => {
        expect(layout({ lines: [] })).toEqual([]);
    });
});
