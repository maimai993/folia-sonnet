import type { TemperaDecorSpec, TemperaShotKind } from './types';
import type { TemperaPalette } from './temperaPalette';
import { temperaHash01 } from './temperaRandom';
import {
    buildCrossRow,
    buildCrossingLines,
    buildDotRow,
    buildHatchSpec,
    buildScribblePath,
    buildWavyPath,
    diamondPolygon,
    rectPolygon,
} from './temperaHatch';
import {
    drawConcentricDiamonds,
    drawCrossMarks,
    drawHatchFill,
    drawLines,
    drawPolygonFill,
    drawPolygonOutline,
    drawPolyline,
    drawSquareMarks,
} from './temperaShapes';

// src/components/visualizer/tempera/temperaCompositions.ts
// Per-shot-kind screentone compositions: hatch-filled geometry, concentric diamond frames,
// crossing guide lines and doodle strokes. Layout regions match temperaLayout exactly, so
// this file only changes what fills them, never where the lyric sits.
type PixiModule = typeof import('pixi.js');
type Graphics = import('pixi.js').Graphics;
type Container = import('pixi.js').Container;

export interface TemperaBlockOptions {
    alpha?: number;
    enterDX?: number;
    enterDY?: number;
    delay?: number;
    span?: number;
    pulse?: boolean;
    /** Opens the node horizontally from its pivot, used for hatch density reveals. */
    grow?: boolean;
}

export interface TemperaCompositionContext {
    pixi: PixiModule;
    kind: TemperaShotKind;
    palette: TemperaPalette;
    decor: TemperaDecorSpec;
    width: number;
    height: number;
    seed: number;
    showDecor: boolean;
    add: (node: Graphics, options?: TemperaBlockOptions, parent?: Container) => void;
    createGroup: (rotation: number, x: number, y: number) => Container;
}

// Shallow full-bleed guide lines shared by every kind; they carry the eye between shots.
const addCrossingLines = (ctx: TemperaCompositionContext) => {
    const lines = buildCrossingLines(ctx.seed, 31, ctx.width, ctx.height, ctx.decor.crossCount);
    if (lines.length === 0) return;
    ctx.add(drawLines(ctx.pixi, lines, ctx.palette.tone4, 1.3, 0.6), {
        delay: 0.14,
        span: 0.6,
        enterDX: ctx.width * 0.25,
    });
};

const addDuoSplit = (ctx: TemperaCompositionContext) => {
    const { width, height, palette } = ctx;
    const horizontal = temperaHash01(ctx.seed, 1, 3) > 0.5;
    const regionA = horizontal
        ? rectPolygon(0, 0, width, height * 0.52)
        : rectPolygon(0, 0, width * 0.5, height);
    const regionB = horizontal
        ? rectPolygon(0, height * 0.52, width, height * 0.48)
        : rectPolygon(width * 0.5, 0, width * 0.5, height);
    const hatch = buildHatchSpec(ctx.seed, 5);

    ctx.add(drawPolygonFill(ctx.pixi, regionA, palette.tone1, 0.95), {
        enterDY: horizontal ? -height * 0.6 : 0,
        enterDX: horizontal ? 0 : -width * 0.55,
    });
    ctx.add(drawHatchFill(ctx.pixi, regionA, hatch, palette.tone4, 0.55), { delay: 0.06, grow: true, span: 0.5 });
    ctx.add(drawPolygonFill(ctx.pixi, regionB, palette.tone2, 0.95), {
        delay: 0.06,
        enterDY: horizontal ? height * 0.6 : 0,
        enterDX: horizontal ? 0 : width * 0.55,
    });
    // A crosshatch pass reads as the denser tone step opposite the plain hatch region.
    ctx.add(drawHatchFill(ctx.pixi, regionB, { ...hatch, angle: -hatch.angle, spacing: hatch.spacing * 0.7 }, palette.tone4, 0.4),
        { delay: 0.12, grow: true, span: 0.5 });

    const splitBar = horizontal
        ? rectPolygon(0, height * 0.52 - 1.5, width, 3)
        : rectPolygon(width * 0.5 - 1.5, 0, 3, height);
    ctx.add(drawPolygonFill(ctx.pixi, splitBar, palette.ink, 0.85), { delay: 0.16, span: 0.5 });

    if (!ctx.showDecor) return;
    const markX = horizontal ? width * 0.18 : width * 0.5;
    const markY = horizontal ? height * 0.52 : height * 0.2;
    ctx.add(drawConcentricDiamonds(ctx.pixi, markX, markY, 22, 22, 2, palette.ink, 0.9),
        { delay: 0.24, pulse: true });
};

const addBandStrip = (ctx: TemperaCompositionContext) => {
    const { width, height, palette } = ctx;
    const bandY = height * 0.37;
    const bandHeight = height * 0.3;
    ctx.add(drawPolygonFill(ctx.pixi, rectPolygon(0, bandY, width, bandHeight), palette.tone3, 0.96),
        { span: 0.55, enterDX: -width * 0.6 });
    // Guide lines hug the band edges; the lyric inverts against the mid tone between them.
    ctx.add(drawLines(ctx.pixi, [
        { x1: -width * 0.05, y1: bandY - 10, x2: width * 1.05, y2: bandY - 22 },
        { x1: -width * 0.05, y1: bandY + bandHeight + 22, x2: width * 1.05, y2: bandY + bandHeight + 10 },
    ], palette.tone4, 1.4, 0.75), { delay: 0.12, enterDX: width * 0.3 });

    if (!ctx.showDecor) return;
    const crosses = buildCrossRow(ctx.seed, 17, width * 0.06, bandY - height * 0.16, 4, width * 0.055, 9);
    ctx.add(drawCrossMarks(ctx.pixi, crosses, palette.ink, 2, 0.8), { delay: 0.2, span: 0.5 });
    const dots = buildDotRow(ctx.seed, 19, width * 0.94, bandY + bandHeight + height * 0.06, 3, height * 0.05, 6);
    ctx.add(drawSquareMarks(ctx.pixi, dots, palette.ink, 0.75), { delay: 0.26, pulse: true });
};

const addFrameWindow = (ctx: TemperaCompositionContext) => {
    const { width, height, palette } = ctx;
    const rx = width * 0.42;
    const ry = height * 0.44;
    const cx = width / 2;
    const cy = height / 2;
    const inner = diamondPolygon(cx, cy, rx * 0.78, ry * 0.78);
    ctx.add(drawHatchFill(ctx.pixi, inner, buildHatchSpec(ctx.seed, 23, 1.4), palette.tone2, 0.45),
        { grow: true, span: 0.6 });
    ctx.add(drawConcentricDiamonds(ctx.pixi, cx, cy, rx, ry, 3, palette.ink, 0.9),
        { delay: 0.08, enterDY: height * 0.06, span: 0.55 });

    if (!ctx.showDecor) return;
    const corner = buildCrossRow(ctx.seed, 29, width * 0.08, height * 0.14, 3, width * 0.045, 8);
    ctx.add(drawCrossMarks(ctx.pixi, corner, palette.tone4, 1.8, 0.85), { delay: 0.22 });
    const column = buildDotRow(ctx.seed, 37, width * 0.92, height * 0.62, 4, height * 0.06, 7);
    ctx.add(drawSquareMarks(ctx.pixi, column, palette.tone4, 0.8), { delay: 0.28 });
};

const addPosterPanel = (ctx: TemperaCompositionContext) => {
    const { width, height, palette } = ctx;
    const poster = ctx.createGroup(-0.06, width / 2, height / 2);
    const solid = diamondPolygon(-width * 0.12, 0, width * 0.42, height * 0.66);
    const hatched = diamondPolygon(width * 0.2, -height * 0.06, width * 0.3, height * 0.48);
    ctx.add(drawPolygonFill(ctx.pixi, solid, palette.ink, 0.92),
        { enterDX: -width * 0.7, span: 0.55 }, poster);
    ctx.add(drawHatchFill(ctx.pixi, hatched, buildHatchSpec(ctx.seed, 41), palette.tone4, 0.7),
        { delay: 0.08, grow: true, span: 0.55 }, poster);
    ctx.add(drawPolygonOutline(ctx.pixi, hatched, palette.ink, 2, 0.8),
        { delay: 0.12, span: 0.55 }, poster);
    ctx.add(drawPolyline(
        ctx.pixi,
        buildWavyPath(ctx.seed, 43, -width * 0.6, width * 0.6, height * 0.42, height * 0.02),
        palette.tone4,
        2,
        0.7,
    ), { delay: 0.2, enterDY: height * 0.1 }, poster);
};

const addQuietLine = (ctx: TemperaCompositionContext) => {
    const { width, height, palette } = ctx;
    const gridWidth = width * 0.7;
    const gridX = (width - gridWidth) / 2;
    [0.38, 0.5, 0.62].forEach((ratio, index) => {
        ctx.add(drawPolygonFill(ctx.pixi, rectPolygon(gridX, height * ratio, gridWidth, 1), palette.line, 1),
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

// Motif overlay: one extra screentone element chosen at compile time, layered on any kind.
const addMotif = (ctx: TemperaCompositionContext) => {
    const { width, height, palette, decor } = ctx;
    const cornerX = temperaHash01(ctx.seed, 61, 7) > 0.5 ? width * 0.14 : width * 0.86;
    const cornerY = temperaHash01(ctx.seed, 63, 7) > 0.5 ? height * 0.18 : height * 0.82;
    switch (decor.motif) {
        case 'diamonds':
            ctx.add(drawConcentricDiamonds(ctx.pixi, cornerX, cornerY, 34, 34, 3, palette.tone4, 0.8),
                { delay: 0.34, pulse: true });
            return;
        case 'hatch-twin': {
            const spec = { ...buildHatchSpec(ctx.seed, 67), angle: decor.hatchAngle };
            [0, 1].forEach(index => {
                const box = rectPolygon(cornerX - 34 + index * 46, cornerY - 26, 38, 38);
                ctx.add(drawHatchFill(ctx.pixi, box, index === 0 ? spec : { ...spec, spacing: spec.spacing * 0.55 }, palette.tone4, 0.75),
                    { delay: 0.34 + index * 0.05, grow: true });
                ctx.add(drawPolygonOutline(ctx.pixi, box, palette.tone4, 1.2, 0.6), { delay: 0.38 + index * 0.05 });
            });
            return;
        }
        case 'band-cross':
            ctx.add(drawCrossMarks(
                ctx.pixi,
                buildCrossRow(ctx.seed, 71, cornerX - width * 0.1, cornerY, 5, width * 0.05, 8, decor.hatchAngle * 0.4),
                palette.tone4,
                2,
                0.8,
            ), { delay: 0.34, span: 0.5 });
            return;
        case 'poster-diamond':
            // Deliberately parked past the edge so the shape bleeds off frame.
            ctx.add(drawPolygonFill(
                ctx.pixi,
                diamondPolygon(cornerX < width / 2 ? -width * 0.04 : width * 1.04, cornerY, width * 0.14, height * 0.2),
                palette.tone3,
                0.85,
            ), { delay: 0.32, span: 0.55, enterDX: (cornerX < width / 2 ? -1 : 1) * width * 0.1 });
            return;
        case 'doodle':
        default:
            ctx.add(drawPolyline(
                ctx.pixi,
                buildScribblePath(decor.scribbleSeed, 73, cornerX, cornerY, Math.min(width, height) * 0.08, 3),
                palette.tone4,
                1.5,
                0.72,
            ), { delay: 0.34, span: 0.6 });
    }
};

export const drawTemperaComposition = (ctx: TemperaCompositionContext) => {
    switch (ctx.kind) {
        case 'duo-split': addDuoSplit(ctx); break;
        case 'band-strip': addBandStrip(ctx); break;
        case 'frame-window': addFrameWindow(ctx); break;
        case 'poster-panel': addPosterPanel(ctx); break;
        case 'quiet-line':
        default: addQuietLine(ctx); break;
    }
    addCrossingLines(ctx);
    if (ctx.showDecor) addMotif(ctx);
};
