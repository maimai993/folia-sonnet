import { beforeEach, describe, expect, it } from 'vitest';
import * as pixi from 'pixi.js';
import { AnimatedGraphics } from '@/components/visualizer/sonnet/sonnetAnimatedGraphics';

// test/unit/visualizer/sonnetAnimatedGraphics.test.ts
// Locks the pending-command skip: commands still waiting for their stagger window emit nothing,
// unless the shared path state carries them into a neighbour (arc-led strokes). And an
// AnimatedGraphics is not redrawn for the progress it was last drawn for: lock when it must be,
// another progress, and another recorded command at the same progress.
// Also locks the build-time determinism (issue M9): a circle's record is the whole circle, start
// angle and direction included, so rebuilding a scene must record the same arc instead of
// sampling Math.random.
const instructions = (graphics: AnimatedGraphics) => graphics.display.context.instructions;

describe('Sonnet AnimatedGraphics pending commands', () => {
    it('emits nothing for moveTo-led commands that have not started yet', () => {
        const graphics = new AnimatedGraphics(pixi);
        graphics.moveTo(0, 0).lineTo(40, 0).stroke({ color: 0xffffff, width: 2 });
        graphics.moveTo(0, 10).lineTo(40, 10).stroke({ color: 0xffffff, width: 2 });
        graphics.rect(0, 20, 40, 10).fill({ color: 0xffffff, alpha: 0.5 });
        graphics.circle(20, 50, 6).fill({ color: 0xffffff });

        graphics.update(0);
        expect(instructions(graphics)).toHaveLength(0);

        // The second stroke's window opens at ~0.31 and the circle's at ~0.28; both still wait at 0.2.
        graphics.update(0.2);
        expect(instructions(graphics).map(instruction => instruction.action)).toEqual(['stroke', 'fill']);

        graphics.update(1);
        expect(instructions(graphics)).toHaveLength(4);
    });

    it('keeps pending commands whose path state reaches an arc-led stroke', () => {
        const graphics = new AnimatedGraphics(pixi);
        graphics.circle(20, 20, 6).fill({ color: 0xffffff });
        graphics.arc(20, 20, 12, 0, Math.PI / 2).stroke({ color: 0xffffff, width: 2 });

        graphics.update(0);
        // The arc-led stroke emits no segment yet, so Pixi strokes the fill's path in its place;
        // skipping either command would change that.
        const emitted = instructions(graphics);
        expect(emitted.map(instruction => instruction.action)).toEqual(['fill', 'stroke']);
        const pathOf = (index: number) => (emitted[index].data as { path: pixi.GraphicsPath }).path;
        expect(pathOf(1)).toBe(pathOf(0));
    });
});

const createPixi = () => {
    const counts = { clears: 0, strokes: 0 };
    class Graphics {
        clear() { counts.clears += 1; return this; }
        moveTo() { return this; }
        lineTo() { return this; }
        stroke() { counts.strokes += 1; return this; }
    }
    return { pixi: { Graphics } as unknown as typeof import('pixi.js'), counts };
};

describe('sonnet AnimatedGraphics.update', () => {
    it('redraws for a new progress and not for the same one', () => {
        const { pixi: fakePixi, counts } = createPixi();
        const graphics = new AnimatedGraphics(fakePixi);
        graphics.moveTo(0, 0).lineTo(10, 0).stroke({ width: 1 });

        graphics.update(0.5);
        graphics.update(0.5);
        expect(counts).toEqual({ clears: 1, strokes: 1 });

        graphics.update(1);
        graphics.update(1);
        graphics.update(1);
        expect(counts).toEqual({ clears: 2, strokes: 2 });
    });

    it('redraws when a command was recorded since', () => {
        const { pixi: fakePixi, counts } = createPixi();
        const graphics = new AnimatedGraphics(fakePixi);
        graphics.moveTo(0, 0).lineTo(10, 0).stroke({ width: 1 });
        graphics.update(1);
        graphics.moveTo(0, 5).lineTo(10, 5).stroke({ width: 1 });
        graphics.update(1);
        expect(counts).toEqual({ clears: 2, strokes: 3 });
    });
});

describe('sonnet AnimatedGraphics records deterministic geometry (M9)', () => {
    let randomCalls = 0;

    beforeEach(() => {
        randomCalls = 0;
        let state = 7;
        Math.random = () => {
            randomCalls += 1;
            state = (state * 16807) % 2147483647;
            return state / 2147483647;
        };
    });

    /** The recorded circle path, as the animation would replay it. */
    const circlePath = () => {
        const graphics = new AnimatedGraphics(pixi);
        graphics.circle(20, 20, 6).fill({ color: 0xffffff });
        graphics.update(1);
        const [fill] = instructions(graphics);
        const [hint, arc] = (fill.data as { path: pixi.GraphicsPath }).path.instructions;
        return { hint: hint.data, arc: arc.data.slice(0, 3) };
    };

    it('records the same circle start angle and direction on every build', () => {
        const first = circlePath();
        const second = circlePath();

        expect(randomCalls).toBe(0);
        expect(second).toEqual(first);
    });
});
