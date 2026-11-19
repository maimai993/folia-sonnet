// test/unit/visualizer/particlesCoverMapping.test.ts
// Pins #435: the cover particles and the relief (displacement) follow the cover's own aspect
// ratio and stay centred, and the relief's vertical direction matches the cover texture instead of
// being flipped. These are the pure mapping functions the vertex shader and applyCoverDepth share.

import { describe, expect, it } from 'vitest';
import {
    coverUvCoefficients,
    coverUvFromGrid,
    gridFromCoverPixel,
    resolveCoverFrame,
    type CoverFrame,
} from '../../../src/components/visualizer/backgrounds/particles/coverMapping';

const VIEW_WIDE = { viewWidth: 3.5, viewHeight: 2.0, coverAspect: 1 };   // 16:9 screen, square cover
const VIEW_TALL = { viewWidth: 2.0, viewHeight: 3.5, coverAspect: 1 };   // 9:16 screen, square cover

describe('resolveCoverFrame: cover keeps its own aspect ratio, centred', () => {
    it('fits a square cover into a wide view by height, not stretched to the width', () => {
        const frame = resolveCoverFrame(VIEW_WIDE);
        expect(frame.height).toBeCloseTo(2.0, 6);
        expect(frame.width).toBeCloseTo(2.0, 6);
        // in a 16:9 view that is a centred square, i.e. 57% of the viewport width, not all of it
        expect(frame.width).toBeLessThan(VIEW_WIDE.viewWidth);
        expect(frame.centerX).toBe(0);
        expect(frame.centerY).toBe(0);
    });

    it('fits a square cover into a tall view by width', () => {
        const frame = resolveCoverFrame(VIEW_TALL);
        expect(frame.width).toBeCloseTo(2.0, 6);
        expect(frame.height).toBeCloseTo(2.0, 6);
        expect(frame.height).toBeLessThan(VIEW_TALL.viewHeight);
    });

    it('keeps a wide cover wide instead of squaring it', () => {
        const frame = resolveCoverFrame({ viewWidth: 2.0, viewHeight: 2.0, coverAspect: 2 });
        expect(frame.width / frame.height).toBeCloseTo(2, 6);
        expect(frame.width).toBeCloseTo(2.0, 6);
        expect(frame.height).toBeCloseTo(1.0, 6);
    });

    it('never exceeds the viewport, and stays inside it on both axes', () => {
        for (const aspect of [0.5, 1, 16 / 9, 2.4]) {
            for (const view of [VIEW_WIDE, VIEW_TALL, { viewWidth: 2, viewHeight: 2, coverAspect: aspect }]) {
                const frame = resolveCoverFrame(view);
                expect(frame.width).toBeLessThanOrEqual(view.viewWidth + 1e-9);
                expect(frame.height).toBeLessThanOrEqual(view.viewHeight + 1e-9);
            }
        }
    });

    it('falls back to a square for a missing or nonsense cover aspect', () => {
        for (const coverAspect of [Number.NaN, 0, -3, Number.POSITIVE_INFINITY]) {
            const frame = resolveCoverFrame({ viewWidth: 2, viewHeight: 1, coverAspect });
            expect(frame.width).toBeCloseTo(1, 6);
            expect(frame.height).toBeCloseTo(1, 6);
        }
    });

    it('scales both axes together when fill is above 1, so the ratio is untouched', () => {
        const frame = resolveCoverFrame(VIEW_WIDE, 1.5);
        expect(frame.width / frame.height).toBeCloseTo(1, 6);
        expect(frame.width).toBeCloseTo(3.0, 6);
    });
});

describe('coverUvFromGrid: sample the cover without a vertical flip', () => {
    const planeWidth = 3.5;
    const planeHeight = 2.0;
    const frame: CoverFrame = { width: 2.0, height: 2.0, centerX: 0, centerY: 0 };

    it('maps the grid centre to the cover centre', () => {
        const uv = coverUvFromGrid(0.5, 0.5, planeWidth, planeHeight, frame);
        expect(uv.u).toBeCloseTo(0.5, 6);
        expect(uv.v).toBeCloseTo(0.5, 6);
    });

    it('keeps the cover upright: bottom of the screen samples the bottom of the cover', () => {
        // three's textures default to flipY, so v = 0 is the picture's own bottom row.
        const bottom = coverUvFromGrid(0.5, 0, planeWidth, planeHeight, frame);
        const top = coverUvFromGrid(0.5, 1, planeWidth, planeHeight, frame);
        expect(bottom.v).toBeLessThan(top.v);
        // the cover frame is 2 world units tall inside a 2 unit view: it spans the whole height
        expect(bottom.v).toBeCloseTo(0, 6);
        expect(top.v).toBeCloseTo(1, 6);
    });

    it('puts the horizontal edges of a square cover inside a wide screen', () => {
        const left = coverUvFromGrid(0, 0.5, planeWidth, planeHeight, frame);
        const right = coverUvFromGrid(1, 0.5, planeWidth, planeHeight, frame);
        // the cover is 2 units wide inside a 3.5 unit view, so the screen's left edge is outside it
        expect(left.u).toBeLessThan(0);
        expect(right.u).toBeGreaterThan(1);
        // and the mapping is linear and symmetric about the centre
        expect(left.u + right.u).toBeCloseTo(1, 6);
    });

    it('agrees with coverUvCoefficients, which is what the shader actually evaluates', () => {
        const coefficients = coverUvCoefficients(planeWidth, planeHeight, frame);
        for (const u of [0, 0.13, 0.5, 0.87, 1]) {
            for (const v of [0, 0.37, 0.5, 0.91, 1]) {
                const uv = coverUvFromGrid(u, v, planeWidth, planeHeight, frame);
                expect(u * coefficients.scaleU + coefficients.offsetU).toBeCloseTo(uv.u, 6);
                expect(v * coefficients.scaleV + coefficients.offsetV).toBeCloseTo(uv.v, 6);
            }
        }
    });
});

describe('gridFromCoverPixel: the depth map lands on the pixel it was taken from', () => {
    const planeWidth = 3.5;
    const planeHeight = 2.0;
    const frame: CoverFrame = { width: 2.0, height: 2.0, centerX: 0, centerY: 0 };
    const size = 64;

    it('round-trips through coverUvFromGrid with the row flipped to sample-space v', () => {
        for (const [px, py] of [[0, 0], [12, 40], [31, 31], [63, 63]]) {
            const grid = gridFromCoverPixel(px!, py!, size, planeWidth, planeHeight, frame);
            const uv = coverUvFromGrid(grid.u, grid.v, planeWidth, planeHeight, frame);
            expect(uv.u).toBeCloseTo(px! / (size - 1), 6);
            // py counts picture rows from the top; the sampled cover v counts from the bottom.
            expect(uv.v).toBeCloseTo(1 - py! / (size - 1), 6);
        }
    });

    it('keeps the depth upright: the picture top row lands at the top of the mesh', () => {
        // py = 0 is the picture's top row. It must land at the largest grid v (top of the screen),
        // never at v = 0 — a plain py/(size-1) here is what mirrored the relief vertically (#435).
        const pictureTop = gridFromCoverPixel(size - 1, 0, size, planeWidth, planeHeight, frame);
        const pictureBottom = gridFromCoverPixel(size - 1, size - 1, size, planeWidth, planeHeight, frame);
        expect(pictureTop.v).toBeGreaterThan(pictureBottom.v);
        expect(pictureTop.v).toBeCloseTo(1, 6);
        expect(pictureBottom.v).toBeCloseTo(0, 6);
    });

    it('agrees with coverUvFromGrid on which cover row each mesh row reads', () => {
        // The relief and the colour must come from the same picture row: for both, mesh v = 1
        // is the picture's top row. This is the #435 "relief points the wrong way" guard.
        const meshTop = coverUvFromGrid(0.5, 1, planeWidth, planeHeight, frame);
        const meshBottom = coverUvFromGrid(0.5, 0, planeWidth, planeHeight, frame);
        // flipY: v = 1 is the texture's top row, v = 0 is its bottom row.
        expect(meshTop.v).toBeGreaterThan(meshBottom.v);
        const depthTop = gridFromCoverPixel(32, 0, size, planeWidth, planeHeight, frame);
        const depthBottom = gridFromCoverPixel(32, size - 1, size, planeWidth, planeHeight, frame);
        expect(depthTop.v).toBeGreaterThan(depthBottom.v);
    });
});
