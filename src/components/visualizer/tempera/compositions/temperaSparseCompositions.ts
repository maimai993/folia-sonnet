import type { TemperaCompositionDrawer } from '../temperaCompositionContext';
import type { TemperaShotKind } from '../types';
import { temperaHash01 } from '../temperaRandom';
import { buildDotGrid, buildScribblePath, buildWavyPath, rectPolygon } from '../temperaHatch';
import { drawLines, drawPolygonFill, drawPolyline, drawSquareMarks } from '../temperaShapes';

// src/components/visualizer/tempera/compositions/temperaSparseCompositions.ts
// Near-empty compositions for breathing paragraphs: hairlines, dot fields and hand-drawn
// strokes, with almost no tone mass so the type reads as a whisper.
const quietLine: TemperaCompositionDrawer = ctx => {
    const { width, height, palette } = ctx;
    const gridWidth = width * 0.7;
    const gridX = (width - gridWidth) / 2;
    [0.38, 0.5, 0.62].forEach((ratio, index) => {
        ctx.add(drawPolygonFill(ctx.pixi, rectPolygon(gridX, height * ratio, gridWidth, 1), palette.line, 1, ctx.gradient),
            { delay: index * 0.08, span: 0.6, enterDX: (index % 2 === 0 ? -1 : 1) * width * 0.2 });
    });
    if (!ctx.showDecor) return;
    ctx.add(drawPolyline(
        ctx.pixi,
        buildScribblePath(ctx.decor.scribbleSeed, 47, width * 0.2, height * 0.26, Math.min(width, height) * 0.09, 2),
        palette.tone4,
        1.6,
        0.7,
    ), { delay: 0.24, span: 0.6 });
    // Grass tufts: short strokes fanned from one baseline point.
    const tuftX = width * 0.82;
    const tuftY = height * 0.74;
    ctx.add(drawLines(ctx.pixi, Array.from({ length: 6 }, (_, index) => {
        const lean = (temperaHash01(ctx.decor.scribbleSeed, index, 59) - 0.5) * 34;
        return { x1: tuftX + index * 7, y1: tuftY, x2: tuftX + index * 7 + lean, y2: tuftY - 24 - index * 3 };
    }), palette.tone4, 1.4, 0.7), { delay: 0.3, span: 0.55 });
};

// A dot lattice that thins out toward one edge; the type floats in the sparse half.
const starfieldDots: TemperaCompositionDrawer = ctx => {
    const { width, height, palette, bleed } = ctx;
    const spacing = Math.max(24, Math.sqrt((width * height) / 900));
    const marks = buildDotGrid(width + bleed, height + bleed, spacing, 2.6);
    const dense = marks.filter(mark => mark.y > height * 0.45);
    const sparse = marks.filter(mark => mark.y <= height * 0.45 && (mark.x + mark.y) % 3 < 1);
    ctx.add(drawSquareMarks(ctx.pixi, dense, palette.tone4, 0.45), { span: 0.6, enterDY: height * 0.2 });
    ctx.add(drawSquareMarks(ctx.pixi, sparse, palette.tone4, 0.25), { delay: 0.08, span: 0.6, enterDY: -height * 0.15 });
    if (!ctx.showDecor) return;
    ctx.add(drawLines(ctx.pixi, [{ x1: -bleed, y1: height * 0.45, x2: width + bleed, y2: height * 0.45 }], palette.tone4, 1.2, 0.5),
        { delay: 0.2, span: 0.5, enterDX: width * 0.2 });
};

// Concentric wobbling lines, the surface of the water seen from just below it.
const rippleLines: TemperaCompositionDrawer = ctx => {
    const { width, height, palette, bleed } = ctx;
    const count = 7;
    for (let index = 0; index < count; index += 1) {
        const y = height * (0.16 + index * 0.11);
        const amplitude = height * (0.006 + index * 0.004);
        ctx.add(drawPolyline(
            ctx.pixi,
            buildWavyPath(ctx.seed, 89 + index, -bleed, width + bleed, y, amplitude, 26),
            palette.tone4,
            index % 3 === 0 ? 2 : 1.1,
            0.55,
        ), { delay: index * 0.045, span: 0.6, enterDX: (index % 2 === 0 ? -1 : 1) * width * 0.15 });
    }
};

export const TEMPERA_SPARSE_COMPOSITIONS: Partial<Record<TemperaShotKind, TemperaCompositionDrawer>> = {
    'quiet-line': quietLine,
    'starfield-dots': starfieldDots,
    'ripple-lines': rippleLines,
};
