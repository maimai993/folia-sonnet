import { describe, expect, it } from 'vitest';
import { normalizeNebbiaTuning } from '@/components/visualizer/nebbia/tuning';
import { DEFAULT_NEBBIA_TUNING, NEBBIA_LIMITS } from '@/components/visualizer/nebbia/types';
import { nebbiaFrameUniforms } from '@/components/visualizer/nebbia/nebbiaFrameUniforms';
import { NebbiaGlassMotion } from '@/components/visualizer/nebbia/nebbiaDrops';
import { windDrift } from '@/components/visualizer/nebbia/nebbiaDrops';
import { NebbiaSpot } from '@/components/visualizer/nebbia/nebbiaSpot';

// test/unit/visualizer/nebbiaFogDetail.test.ts
// 霧的細節（原型寫死參數開放成 tuning）：預設值同原來的常量、範圍夾緊、舊存檔補預設、數值真的流到 uniform 和 motion。

const KEYS = ['edge', 'beads', 'drip', 'refract', 'glint', 'fieldDrops', 'wind', 'endBead', 'beadHold', 'breathSpread', 'breathHold', 'breathFade', 'breathThick', 'bumpRate', 'bumpFall'] as const;
// 原 nebbiaConstants.ts 的 NEBBIA_FIXED 預設值，開放後畫面必須不變
const ORIGINAL = { edge: 0.6, beads: 0.35, drip: 0.25, refract: 1, glint: 1, fieldDrops: 0.5, wind: 0, endBead: 1, beadHold: 4, breathSpread: 1.2, breathHold: 1, breathFade: 8, breathThick: 0.7, bumpRate: 1, bumpFall: 0.5 };

describe('nebbia fog detail tuning', () => {
    it('defaults equal the former hard-coded constants', () => {
        for (const key of KEYS) expect(DEFAULT_NEBBIA_TUNING[key]).toBe(ORIGINAL[key]);
    });

    it('fills an old stored tuning with the defaults', () => {
        const read = normalizeNebbiaTuning({ mist: 0.5, strokeWidth: 0.06 });
        for (const key of KEYS) expect(read[key]).toBe(ORIGINAL[key]);
        expect(read).toMatchObject({ mist: 0.5, strokeWidth: 0.06 });
    });

    it('clamps every detail into its limits and rejects bad types', () => {
        const high = normalizeNebbiaTuning(Object.fromEntries(KEYS.map(k => [k, 999])));
        const low = normalizeNebbiaTuning(Object.fromEntries(KEYS.map(k => [k, -999])));
        for (const key of KEYS) {
            expect(high[key]).toBe(NEBBIA_LIMITS[key].max);
            expect(low[key]).toBe(NEBBIA_LIMITS[key].min);
        }
        const bad = normalizeNebbiaTuning(Object.fromEntries(KEYS.map(k => [k, 'x'])));
        for (const key of KEYS) expect(bad[key]).toBe(ORIGINAL[key]);
    });

    it('keeps every default inside its range', () => {
        for (const key of KEYS) {
            expect(ORIGINAL[key]).toBeGreaterThanOrEqual(NEBBIA_LIMITS[key].min);
            expect(ORIGINAL[key]).toBeLessThanOrEqual(NEBBIA_LIMITS[key].max);
        }
    });

    it('passes edge, refract, glint and breath thickness to the shader uniforms', () => {
        const u = nebbiaFrameUniforms({ ...DEFAULT_NEBBIA_TUNING, edge: 1.2, refract: 1.5, glint: 0.3, breathThick: 0.4 }, [0, 0], new NebbiaSpot(), 800, 600, 0);
        expect(u).toMatchObject({ edge: 1.2, refract: 1.5, glint: 0.3, breathThick: 0.4 });
    });

    it('wind pushes drops sideways only when it is above zero', () => {
        expect(windDrift(100, 1, 0)).toBeCloseTo(0);
        expect(windDrift(100, 1, 0.5)).toBeCloseTo(-50);
        expect(windDrift(100, 0, 0.5)).toBeCloseTo(0);
    });

    it('field drop density follows tuning.fieldDrops', () => {
        const count = (density: number) => {
            const motion = new NebbiaGlassMotion();
            motion.fieldDensity = density;
            motion.buildField(400, 800);
            return motion.fieldInstances([], 1).length / 6;
        };
        expect(count(0)).toBe(0);
        expect(count(1)).toBeGreaterThan(count(0.5));
    });

    it('bump rate zero stops random bumps', () => {
        const motion = new NebbiaGlassMotion();
        motion.bumpRate = 0;
        for (let t = 0; t < 60; t += 0.5) motion.beginFrame(t, false, true);
        expect(motion.shake()).toEqual([0, 0]);
    });
});
