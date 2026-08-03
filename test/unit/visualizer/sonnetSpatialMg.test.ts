import { describe, expect, it } from 'vitest';
import {
    SONNET_GEO_VARIANT_COUNT,
    resolveSonnetHudRotationQuarterTurns,
    resolveSonnetGeoVariant,
    resolveSonnetMoleculeVariant,
} from '@/components/visualizer/sonnet/sonnetSpatialMgGeometry';
import {
    drawThemedSonnetShotMg,
    SONNET_THEMED_GEO_VARIANT_COUNT,
    SONNET_THEMED_GEO_VARIANT_START,
    SONNET_THEMED_GEO_VARIANTS,
} from '@/components/visualizer/sonnet/sonnetThemedShotMg';

// test/unit/visualizer/sonnetSpatialMg.test.ts
// Locks the expanded geometric recipes into Sonnet's existing single MG scene collection.
describe('Sonnet spatial MG variants', () => {
    it('extends the original collection without a second layer family', () => {
        expect(SONNET_GEO_VARIANT_COUNT).toBe(36);
        expect(Array.from({ length: 24 }, (_, seed) => resolveSonnetGeoVariant(seed)))
            .toEqual(Array.from({ length: 24 }, (_, seed) => seed));
    });

    it('keeps selection deterministic and safe for negative seeds', () => {
        for (let seed = -24; seed <= 24; seed += 1) {
            const variant = resolveSonnetGeoVariant(seed);
            expect(variant).toBe(resolveSonnetGeoVariant(seed));
            expect(variant).toBeGreaterThanOrEqual(0);
            expect(variant).toBeLessThan(SONNET_GEO_VARIANT_COUNT);
        }
    });

    it('distributes variant 3 across all molecule sub-variants', () => {
        expect([0, 1, 2].map(cycle => resolveSonnetMoleculeVariant(3 + cycle * SONNET_GEO_VARIANT_COUNT)))
            .toEqual([0, 1, 2]);
    });

    it('distributes variant 8 across all quarter-turn rotations', () => {
        expect([0, 1, 2, 3].map(cycle => resolveSonnetHudRotationQuarterTurns(8 + cycle * SONNET_GEO_VARIANT_COUNT)))
            .toEqual([0, 1, 2, 3]);
    });

    it('reserves twelve themed variants after the existing collection', () => {
        expect(SONNET_THEMED_GEO_VARIANT_START).toBe(24);
        expect(SONNET_THEMED_GEO_VARIANT_COUNT).toBe(12);
        expect(SONNET_THEMED_GEO_VARIANTS).toHaveLength(12);
        expect(SONNET_THEMED_GEO_VARIANT_START + SONNET_THEMED_GEO_VARIANT_COUNT)
            .toBe(SONNET_GEO_VARIANT_COUNT);
    });

    it('builds every themed background from both wireframe and filled paths', () => {
        for (let index = 0; index < SONNET_THEMED_GEO_VARIANT_COUNT; index += 1) {
            let strokes = 0;
            let fills = 0;
            const target = {
                moveTo: () => target,
                lineTo: () => target,
                quadraticCurveTo: () => target,
                bezierCurveTo: () => target,
                arc: () => target,
                circle: () => target,
                rect: () => target,
                stroke: () => { strokes += 1; return target; },
                fill: () => { fills += 1; return target; },
            };
            expect(drawThemedSonnetShotMg({
                target,
                variant: SONNET_THEMED_GEO_VARIANT_START + index,
                radius: 600,
                seed: index + 31,
                primary: 0xffffff,
                secondary: 0x88ccff,
            })).toBe(true);
            expect(strokes).toBeGreaterThan(0);
            expect(fills).toBeGreaterThan(0);
        }
    });
});
