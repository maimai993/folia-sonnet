import { beforeEach, describe, expect, it } from 'vitest';
import * as pixi from 'pixi.js';
import type { Theme } from '@/types';
import type { SonnetSemanticSegment } from '@/components/visualizer/sonnet/types';
import { createSonnetGuide, resolveSonnetGuideCue } from '@/components/visualizer/sonnet/sonnetGuides';
import type { SonnetTypographyPlacement } from '@/components/visualizer/sonnet/sonnetTypographyLayout';

// test/unit/visualizer/sonnetGuides.test.ts
// Ensures every semantic text cue receives a short visual lead before its first glyph, and that the
// decoration a guide is built from is deterministic (issue M9): sonnetProgram declares the whole
// timeline seek-safe, so the same segment must lay out its shapes, silk threads and HUD spline the
// same way on every rebuild. The cases below sample the build-time randomness by replacing
// Math.random with a generator that records each call; the random call must be gone.
const segment = (startTime: number, endTime: number): SonnetSemanticSegment => ({
    text: '光',
    startOffset: 0,
    endOffset: 1,
    startTime,
    endTime,
    wordIndices: [0],
    graphemes: [{ char: '光', startTime, endTime }],
    isWordLike: true,
});

const theme = {
    name: 'test',
    backgroundColor: '#000000',
    primaryColor: '#ffffff',
    secondaryColor: '#8888ff',
    accentColor: '#ff2255',
    fontStyle: 'sans',
} as unknown as Theme;

/** A placement of the given role, with the geometry a guide reads. */
const placement = (role: SonnetTypographyPlacement['role'], variant = 0): SonnetTypographyPlacement => ({
    role,
    fontScale: 1,
    x: variant * 10,
    y: 0,
    rotation: 0,
    enterX: 30 + variant,
    enterY: -20 + variant,
    vertical: false,
    timingPhase: variant / 10,
} as SonnetTypographyPlacement);

let randomCalls = 0;

beforeEach(() => {
    randomCalls = 0;
    let state = 1;
    Math.random = () => {
        randomCalls += 1;
        state = (state * 16807) % 2147483647;
        return state / 2147483647;
    };
});

/** The Graphics commands that decide a shape: the path and the style, never the fill's texture
 * or the path's own uid, which is a counter over every Graphics the process has made. */
const describeInstructions = (graphics: pixi.Graphics) => JSON.stringify(
    graphics.context.instructions.map(instruction => ({
        action: instruction.action,
        data: instruction.data,
    })),
    (key, value) => (key === 'texture' || key === 'uid' ? undefined : value),
);

/** Everything a guide build decides that can be read off the built view. */
const describeGuide = (guide: ReturnType<typeof createSonnetGuide>) => {
    const [graphics, shapes] = guide.container.children as pixi.Container[];
    return {
        cue: { startTime: guide.startTime, endTime: guide.endTime, maxAlpha: guide.maxAlpha },
        graphics: describeInstructions(graphics as pixi.Graphics),
        shapes: shapes.children.map(shape => ({
            x: shape.x,
            y: shape.y,
            rotation: shape.rotation,
            instructions: describeInstructions(shape as pixi.Graphics),
        })),
    };
};

describe('Sonnet guide cues', () => {
    it('starts before text and overlaps only the initial arrival moment', () => {
        const source = segment(3, 4);
        const cue = resolveSonnetGuideCue(source);

        expect(cue.startTime).toBeLessThan(source.startTime);
        expect(source.startTime - cue.startTime).toBeGreaterThanOrEqual(0.2);
        expect(cue.endTime).toBeCloseTo(source.startTime + 0.65);
    });

    it('caps guide lead time for long semantic segments', () => {
        const source = segment(10, 20);
        const cue = resolveSonnetGuideCue(source);

        expect(source.startTime - cue.startTime).toBeCloseTo(0.38);
    });
});

describe('Sonnet guide decoration is deterministic (M9)', () => {
    it('lays out the same guide twice without touching Math.random', () => {
        const source = segment(3, 4);
        const build = () => createSonnetGuide(pixi, source, placement('hero'), theme, 48, 3);

        const first = describeGuide(build());
        const second = describeGuide(build());

        expect(randomCalls).toBe(0);
        expect(second).toEqual(first);
    });

    it('draws the same animation for the same segment on every build', () => {
        const source = segment(3, 4);
        const instructionsAt = (progress: number) => {
            const guide = createSonnetGuide(pixi, source, placement('support'), theme, 32, 3);
            const [graphics, shapes] = guide.container.children as pixi.Container[];
            guide.update!(progress);
            return {
                graphics: describeInstructions(graphics as pixi.Graphics),
                shapes: shapes.children.map(shape => [shape.x, shape.y, shape.rotation, shape.alpha]),
            };
        };

        expect(randomCalls).toBe(0);
        expect(instructionsAt(0.5)).toEqual(instructionsAt(0.5));
    });

    it('gives different segments different decoration', () => {
        const first = describeGuide(createSonnetGuide(pixi, segment(3, 4), placement('hero'), theme, 48, 3));
        const second = describeGuide(createSonnetGuide(
            pixi,
            segment(5, 6),
            placement('hero', 3),
            theme,
            48,
            5,
        ));

        expect(randomCalls).toBe(0);
        expect(second).not.toEqual(first);
    });
});
