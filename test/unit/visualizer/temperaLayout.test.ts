import { describe, expect, it } from 'vitest';
import type { TemperaSegment } from '@/components/visualizer/tempera/types';
import { resolveTemperaLayout } from '@/components/visualizer/tempera/temperaLayout';
import { TEMPERA_ENTER_STYLES } from '@/components/visualizer/tempera/temperaEnterStyles';
import { TEMPERA_SHOT_KINDS } from '@/components/visualizer/tempera/types';

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
        // Every registered kind, not a sample: a bad region is invisible until that one shot
        // happens to come up in a song.
        TEMPERA_SHOT_KINDS
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
        });
    });

    it('lands the whole shot on one moment, at or after its lyric end', () => {
        // Nothing has finished arriving while the shot is still being sung, so the block reads
        // as one continuous move rather than a run of separate pops.
        const placements = layout();
        const settles = new Set(placements.map(placement => placement.settleTime));
        expect(settles.size).toBe(1);
        const [settle] = [...settles];
        expect(settle).toBeGreaterThanOrEqual(Math.max(...placements.map(p => p.endTime)) - 1e-6);
        // The last glyph still gets a real window instead of being landed on its own start.
        expect(settle - Math.max(...placements.map(p => p.startTime))).toBeGreaterThanOrEqual(0.3399);
    });

    it('never gives a later glyph a longer entrance than an earlier one', () => {
        // The stagger has to shorten smoothly toward the shared landing. Deriving each window
        // from the gap to the next glyph inverted it: everything got a long window except the
        // last few, which hit the pace clamp and snapped, so the final word of every phrase
        // landed harder than the rest of the line.
        const ordered = [...layout()].sort((a, b) => a.startTime - b.startTime);
        ordered.forEach((placement, index) => {
            if (index === 0) return;
            const previous = ordered[index - 1];
            expect(placement.settleTime - placement.startTime)
                .toBeLessThanOrEqual(previous.settleTime - previous.startTime + 1e-9);
        });
    });

    it('ends the entrance on the lyric this shot carries, not on the whole source line', () => {
        // Shots slice a line into half-phrases, so one line commonly runs across several of
        // them and the layout only ever sees its own slice. Aiming at the source line's end
        // would leave a shot's type still arriving long after that shot had handed off.
        const line = [segment('one', 0, 1), segment('two', 1, 2), segment('three', 2, 3)];
        const settleEnd = (lines: TemperaSegment[][]) => Math.max(
            ...layout({ lines }).map(placement => placement.settleTime),
        );
        expect(settleEnd([line.slice(0, 1)])).toBeLessThan(1.4);
        expect(settleEnd([line])).toBeGreaterThan(2.9);
    });

    it('lands two slices shown in the same shot together', () => {
        // A shot can carry slices from two lines at once; staggering their landings would
        // read as two separate gestures instead of one composition arriving.
        const placements = layout();
        expect(new Set(placements.map(placement => placement.lineIndex))).toEqual(new Set([0, 1]));
        expect(new Set(placements.map(placement => placement.settleTime)).size).toBe(1);
    });

    it('gives a slow shot a longer entrance than a dense one', () => {
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

    it('carries theme keyword colours through to the matching glyphs only', () => {
        const placements = resolveTemperaLayout({
            lines: [LINE_A],
            shotKind: 'duo-split',
            width: 1280,
            height: 720,
            baseFontSize: 54,
            fontFamily: 'sans-serif',
            fontWeight: 600,
            seed: 4242,
            segmentColors: [[null, '#e1565f', null]],
        });

        const colored = placements.filter(placement => placement.color !== null);
        expect(colored.map(placement => placement.char).join('')).toBe('the');
        colored.forEach(placement => expect(placement.color).toBe('#e1565f'));
        expect(placements.filter(placement => placement.color === null).length)
            .toBe(placements.length - colored.length);
    });

    it('leaves every glyph uncoloured when the theme has no keywords', () => {
        expect(layout().every(placement => placement.color === null)).toBe(true);
    });

    it('picks one entrance style per word, not per glyph', () => {
        const placements = layout();
        placements.forEach(placement => {
            expect(TEMPERA_ENTER_STYLES).toContain(placement.enterStyle);
        });
        // Every glyph of a word arrives the same way, so a word lands as one gesture.
        const perWord = new Map<string, Set<string>>();
        placements.forEach(placement => {
            const key = `${placement.lineIndex}:${placement.segmentIndex}`;
            const styles = perWord.get(key) ?? new Set<string>();
            styles.add(placement.enterStyle);
            perWord.set(key, styles);
        });
        perWord.forEach(styles => expect(styles.size).toBe(1));
        // Neighbouring words do not all arrive identically.
        const distinct = new Set([...perWord.values()].map(styles => [...styles][0]));
        expect(distinct.size).toBeGreaterThan(1);
    });

    it('extends each glyph past its sung end, bounded by its own line', () => {
        const placements = layout();
        const lineSpan = (lineIndex: number) => {
            const own = placements.filter(placement => placement.lineIndex === lineIndex);
            return Math.max(...own.map(p => p.endTime)) - Math.min(...own.map(p => p.startTime));
        };
        placements.forEach(placement => {
            const releaseStart = Math.max(placement.endTime, placement.settleTime);
            // A sung glyph keeps opening up rather than freezing...
            expect(placement.releaseTime).toBeGreaterThan(releaseStart);
            // ...but never for longer than the line it belongs to.
            expect(placement.releaseTime - releaseStart)
                .toBeLessThanOrEqual(Math.max(0.5, lineSpan(placement.lineIndex)) + 1e-6);
        });
    });

    it('measures the release as a rigid expansion from the block centre', () => {
        const placements = layout();
        // The levers are pure offsets from the mean position, so the release can only widen
        // the block's spacing - it can never move or reshape the layout.
        const sumX = placements.reduce((sum, placement) => sum + placement.trackingX, 0);
        const sumY = placements.reduce((sum, placement) => sum + placement.trackingY, 0);
        expect(Math.abs(sumX)).toBeLessThan(1e-6);
        expect(Math.abs(sumY)).toBeLessThan(1e-6);

        const centerX = placements.reduce((sum, placement) => sum + placement.x, 0) / placements.length;
        placements.forEach(placement => {
            expect(placement.trackingX).toBeCloseTo(placement.x - centerX, 6);
        });
        // Glyphs further from the centre have a longer lever, which is what reads as tracking.
        const outermost = placements.reduce((a, b) => (Math.abs(a.trackingX) > Math.abs(b.trackingX) ? a : b));
        expect(Math.abs(outermost.trackingX)).toBeGreaterThan(outermost.fontSize);
    });

    it('returns nothing for an empty shot', () => {
        expect(layout({ lines: [] })).toEqual([]);
    });
});
