import type { TemperaCompositionDrawer } from '../temperaCompositionContext';
import type { TemperaShotKind } from '../types';
import { temperaHash01 } from '../temperaRandom';
import { buildCrossRow, buildDotRow, buildHatchSpec, buildWavyPath, rectPolygon } from '../temperaHatch';
import {
    drawCrossMarks,
    drawHatchFill,
    drawLines,
    drawPolygonFill,
    drawPolyline,
    drawSquareMarks,
} from '../temperaShapes';

// src/components/visualizer/tempera/compositions/temperaBandCompositions.ts
// Horizontal strata. With Tempera's vertical flow these read as depth: the frame descends
// through the bands, which is what turns a shot hand-off into a dive rather than a cut.
const bandStrip: TemperaCompositionDrawer = ctx => {
    const { width, height, palette, bleed } = ctx;
    const bandY = height * 0.37;
    const bandHeight = height * 0.3;
    ctx.add(drawPolygonFill(ctx.pixi, rectPolygon(-bleed, bandY, width + bleed * 2, bandHeight), palette.tone3, 0.96),
        { span: 0.55, enterDX: -width * 0.5 });
    // Guide lines hug the band edges; the lyric inverts against the mid tone between them.
    ctx.add(drawLines(ctx.pixi, [
        { x1: -bleed, y1: bandY - 10, x2: width + bleed, y2: bandY - 22 },
        { x1: -bleed, y1: bandY + bandHeight + 22, x2: width + bleed, y2: bandY + bandHeight + 10 },
    ], palette.tone4, 1.4, 0.75), { delay: 0.12, enterDX: width * 0.25 });

    if (!ctx.showDecor) return;
    ctx.add(drawCrossMarks(ctx.pixi, buildCrossRow(ctx.seed, 17, width * 0.06, bandY - height * 0.16, 4, width * 0.055, 9), palette.ink, 2, 0.8),
        { delay: 0.2, span: 0.5 });
    ctx.add(drawSquareMarks(ctx.pixi, buildDotRow(ctx.seed, 19, width * 0.94, bandY + bandHeight + height * 0.06, 3, height * 0.05, 6), palette.ink, 0.75),
        { delay: 0.26, drift: true });
};

// A waterline: light above, dense below, with a wavy meniscus between the two.
const horizonBand: TemperaCompositionDrawer = ctx => {
    const { width, height, palette, bleed } = ctx;
    const waterline = height * (0.5 + temperaHash01(ctx.seed, 1, 23) * 0.12);
    ctx.add(drawPolygonFill(ctx.pixi, rectPolygon(-bleed, -bleed, width + bleed * 2, waterline + bleed), palette.tone1, 0.94),
        { span: 0.55, enterDY: -height * 0.3 });
    const water = rectPolygon(-bleed, waterline, width + bleed * 2, height - waterline + bleed);
    ctx.add(drawPolygonFill(ctx.pixi, water, palette.tone3, 0.95), { delay: 0.05, span: 0.55, enterDY: height * 0.3 });
    ctx.add(drawHatchFill(ctx.pixi, water, { ...buildHatchSpec(ctx.seed, 29), angle: 0 }, palette.tone4, 0.55),
        { delay: 0.1, span: 0.55, grow: true });
    ctx.add(drawPolyline(ctx.pixi, buildWavyPath(ctx.seed, 31, -bleed, width + bleed, waterline, height * 0.012, 30), palette.ink, 2.2, 0.85),
        { delay: 0.16, span: 0.5 });
};

// Stacked strata that get denser toward the bottom of the frame.
const deepDive: TemperaCompositionDrawer = ctx => {
    const { width, height, palette, bleed } = ctx;
    const tones = [palette.tone1, palette.tone2, palette.tone3, palette.tone4];
    const bandHeight = (height + bleed * 2) / tones.length;
    tones.forEach((tone, index) => {
        const top = -bleed + bandHeight * index;
        ctx.add(drawPolygonFill(ctx.pixi, rectPolygon(-bleed, top, width + bleed * 2, bandHeight + 1), tone, 0.95),
            { delay: index * 0.06, span: 0.55, enterDY: height * 0.3 });
        if (index === 0) return;
        ctx.add(drawPolyline(ctx.pixi, buildWavyPath(ctx.seed, 37 + index, -bleed, width + bleed, top, height * 0.008, 24), palette.paper, 1.6, 0.5),
            { delay: index * 0.06 + 0.05, span: 0.5 });
    });
};

// A density ramp instead of discrete panels: same hatch angle, tightening spacing.
const toneRamp: TemperaCompositionDrawer = ctx => {
    const { width, height, palette, bleed } = ctx;
    const spec = buildHatchSpec(ctx.seed, 41);
    ctx.add(drawPolygonFill(ctx.pixi, rectPolygon(-bleed, -bleed, width + bleed * 2, height + bleed * 2), palette.tone1, 0.92), { span: 0.5 });
    const steps = 4;
    for (let index = 0; index < steps; index += 1) {
        const columnWidth = (width + bleed * 2) / steps;
        const column = rectPolygon(-bleed + columnWidth * index, -bleed, columnWidth, height + bleed * 2);
        ctx.add(drawHatchFill(ctx.pixi, column, { ...spec, spacing: spec.spacing * (1.6 - index * 0.32) }, palette.tone4, 0.6),
            { delay: index * 0.06, span: 0.55, grow: true });
    }
};

export const TEMPERA_BAND_COMPOSITIONS: Partial<Record<TemperaShotKind, TemperaCompositionDrawer>> = {
    'band-strip': bandStrip,
    'horizon-band': horizonBand,
    'deep-dive': deepDive,
    'tone-ramp': toneRamp,
};
