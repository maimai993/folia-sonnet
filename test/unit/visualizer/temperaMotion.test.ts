import { describe, expect, it } from 'vitest';
import {
    easeTemperaEnter,
    easeTemperaInOut,
    easeTemperaSoftBack,
    resolveCubicBezier,
    resolveShotPacedDuration,
    resolveShotStagger,
    resolveTemperaGlyphMotion,
    type TemperaGlyphMotionInput,
} from '@/components/visualizer/tempera/temperaMotion';

// test/unit/visualizer/temperaMotion.test.ts
// Locks the easing contract and the absolute-time glyph solver: a seek must produce exactly
// the frame continuous playback would, and a muted motion setting must pin glyphs in place.
const glyph = (overrides: Partial<TemperaGlyphMotionInput> = {}): TemperaGlyphMotionInput => ({
    startTime: 10,
    settleTime: 10.8,
    endTime: 10.4,
    enterX: 40,
    enterY: -25,
    enterRotation: 0.3,
    enterScale: 0.7,
    driftPhase: 1.1,
    rotation: 0.05,
    ...overrides,
});

describe('Tempera easing', () => {
    it('pins the cubic bezier endpoints and stays monotonic', () => {
        expect(resolveCubicBezier(0.22, 1, 0.36, 1, 0)).toBe(0);
        expect(resolveCubicBezier(0.22, 1, 0.36, 1, 1)).toBe(1);
        let previous = -1;
        for (let step = 0; step <= 20; step += 1) {
            const value = easeTemperaEnter(step / 20);
            expect(value).toBeGreaterThanOrEqual(previous);
            previous = value;
        }
        expect(easeTemperaInOut(0)).toBe(0);
        expect(easeTemperaInOut(1)).toBe(1);
    });

    it('front-loads the enter curve so glyphs decelerate into place', () => {
        // Half the visual travel is done well before half the time has passed.
        expect(easeTemperaEnter(0.25)).toBeGreaterThan(0.5);
        expect(easeTemperaEnter(0.9)).toBeLessThan(1);
    });

    it('overshoots slightly on the soft-back curve then lands on 1', () => {
        expect(easeTemperaSoftBack(0)).toBeCloseTo(0, 6);
        expect(easeTemperaSoftBack(1)).toBeCloseTo(1, 6);
        const peak = Math.max(...Array.from({ length: 40 }, (_, i) => easeTemperaSoftBack(i / 39)));
        expect(peak).toBeGreaterThan(1);
        expect(peak).toBeLessThan(1.15);
    });
});

describe('Tempera glyph motion', () => {
    it('hides a glyph before its start time', () => {
        const frame = resolveTemperaGlyphMotion(glyph(), 9.5, 1);
        expect(frame.visible).toBe(false);
        expect(frame.alpha).toBe(0);
    });

    it('lands on the layout position and full scale once settled', () => {
        const frame = resolveTemperaGlyphMotion(glyph(), 10.8, 1);
        expect(frame.alpha).toBeCloseTo(1, 6);
        expect(Math.hypot(frame.x, frame.y)).toBeLessThan(0.5);
        expect(frame.scale).toBeCloseTo(1, 2);
        expect(frame.rotation).toBeCloseTo(0.05, 3);
    });

    it('emphasises the glyph being sung with a small scale swell, never a backing block', () => {
        const singing = resolveTemperaGlyphMotion(glyph({ enterScale: 1 }), 10.2, 1);
        const after = resolveTemperaGlyphMotion(glyph({ enterScale: 1 }), 12, 1);
        expect(singing.scale).toBeGreaterThan(after.scale);
        // The swell must stay subtle enough to read as weight, not as a pop.
        expect(singing.scale).toBeLessThan(1.06);
        expect(after.scale).toBeCloseTo(1, 2);
    });

    it('starts from the full entrance offset and resolves alpha before position', () => {
        const start = resolveTemperaGlyphMotion(glyph(), 10, 1);
        expect(start.x).toBeCloseTo(40, 6);
        expect(start.y).toBeCloseTo(-25, 6);
        expect(start.scale).toBeCloseTo(0.7, 6);

        const mid = resolveTemperaGlyphMotion(glyph(), 10.36, 1);
        expect(mid.alpha).toBeCloseTo(1, 3);
        expect(Math.abs(mid.x)).toBeGreaterThan(0.5);
    });

    it('pins the glyph to its layout position when motion is zero', () => {
        [10, 10.2, 11, 40].forEach(time => {
            const frame = resolveTemperaGlyphMotion(glyph(), time, 0);
            expect(frame.x).toBeCloseTo(0, 10);
            expect(frame.y).toBeCloseTo(0, 10);
            expect(frame.rotation).toBeCloseTo(0.05, 6);
            expect(frame.scale).toBeCloseTo(1, 6);
        });
    });

    it('only drifts after the entrance has settled, and stays tiny', () => {
        const duringEntrance = resolveTemperaGlyphMotion(glyph(), 10.8, 1);
        const longAfter = resolveTemperaGlyphMotion(glyph(), 24, 1);
        expect(Math.hypot(duringEntrance.x, duringEntrance.y)).toBeLessThan(0.5);
        expect(Math.hypot(longAfter.x, longAfter.y)).toBeGreaterThan(0);
        expect(Math.hypot(longAfter.x, longAfter.y)).toBeLessThan(2.5);
    });

    it('is a pure function of absolute time, so seeking matches playback', () => {
        [9.9, 10.1, 10.5, 12, 30].forEach(time => {
            expect(resolveTemperaGlyphMotion(glyph(), time, 1))
                .toEqual(resolveTemperaGlyphMotion(glyph(), time, 1));
        });
    });
});

describe('Shot-paced durations', () => {
    it('scales with the shot but clamps at both ends', () => {
        expect(resolveShotPacedDuration(4, 0.25, 0.3, 2)).toBeCloseTo(1, 6);
        expect(resolveShotPacedDuration(0.4, 0.25, 0.3, 2)).toBeCloseTo(0.3, 6);
        expect(resolveShotPacedDuration(30, 0.25, 0.3, 2)).toBeCloseTo(2, 6);
    });
});

describe('Shot stagger windows', () => {
    // The stagger fractions the latest-arriving composition items actually use.
    const LATEST = { delay: 0.34, span: 0.6 };

    it('stretches with the shot instead of capping at a fixed number of seconds', () => {
        const short = resolveShotStagger(2, LATEST.delay, LATEST.span);
        const long = resolveShotStagger(9, LATEST.delay, LATEST.span);
        expect(long.delay).toBeGreaterThan(short.delay * 3);
        expect(long.span).toBeGreaterThan(short.span * 3);
    });

    it('keeps the last item moving until near the end of any shot', () => {
        // A long shot must not finish all of its motion early and then hold a still frame.
        [1.5, 3, 6, 12].forEach(duration => {
            const { delay, span } = resolveShotStagger(duration, LATEST.delay, LATEST.span);
            const finishes = delay + span;
            expect(finishes, `${duration}s`).toBeLessThanOrEqual(duration * 0.95 + 1e-6);
            expect(finishes, `${duration}s`).toBeGreaterThan(duration * 0.55);
        });
    });

    it('never collapses to an instant flash on a very short shot', () => {
        const { delay, span } = resolveShotStagger(0.3, LATEST.delay, LATEST.span);
        expect(span).toBeGreaterThanOrEqual(0.25);
        expect(delay).toBeLessThan(span);
    });

    it('is deterministic', () => {
        expect(resolveShotStagger(4, 0.2, 0.5)).toEqual(resolveShotStagger(4, 0.2, 0.5));
    });
});
