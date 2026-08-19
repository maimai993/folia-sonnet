import { mixColors } from '../colorMix';
import {
    buildHatchLines,
    type TemperaDecorMark,
    type TemperaHatchLine,
    type TemperaHatchSpec,
} from './temperaHatch';

// src/components/visualizer/tempera/temperaShapes.ts
// Pixi Graphics factories for the screentone language. Every factory returns a finished,
// static node: playback only writes transforms and alpha, never geometry.
type PixiModule = typeof import('pixi.js');
type Graphics = import('pixi.js').Graphics;

export const toPixiColor = (pixi: PixiModule, color: string) => (
    pixi.Color.shared.setValue(color).toNumber()
);

const boundsCenter = (polygon: number[]) => {
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < polygon.length; index += 2) {
        minX = Math.min(minX, polygon[index]);
        maxX = Math.max(maxX, polygon[index]);
        minY = Math.min(minY, polygon[index + 1]);
        maxY = Math.max(maxY, polygon[index + 1]);
    }
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
};

/** Four-colour ramp plus the axis it runs along, supplied by the gradient colour mode. */
export interface TemperaGradientFill {
    colors: string[];
    angle: number;
}

/**
 * In gradient mode a shape is filled with the whole four-colour ramp instead of one tone.
 * Each stop is pulled halfway toward the tone the composition asked for, so the ramp carries
 * the cover's hues while the shape keeps the brightness its place in the composition needs.
 */
const buildGradientFill = (pixi: PixiModule, gradient: TemperaGradientFill, color: string) => {
    const half = 0.5;
    const dx = Math.cos(gradient.angle) * half;
    const dy = Math.sin(gradient.angle) * half;
    const stops = gradient.colors.map((stop, index) => ({
        offset: gradient.colors.length > 1 ? index / (gradient.colors.length - 1) : 0,
        color: mixColors(stop, color, 0.5),
    }));
    return new pixi.FillGradient({
        type: 'linear',
        start: { x: half - dx, y: half - dy },
        end: { x: half + dx, y: half + dy },
        colorStops: stops,
        textureSpace: 'local',
    });
};

export const drawPolygonFill = (
    pixi: PixiModule,
    polygon: number[],
    color: string,
    alpha = 1,
    gradient?: TemperaGradientFill | null,
): Graphics => {
    const node = new pixi.Graphics().poly(polygon);
    return gradient && gradient.colors.length > 1
        ? node.fill({ fill: buildGradientFill(pixi, gradient, color), alpha })
        : node.fill({ color: toPixiColor(pixi, color), alpha });
};

export const drawPolygonOutline = (
    pixi: PixiModule,
    polygon: number[],
    color: string,
    width: number,
    alpha = 1,
): Graphics => new pixi.Graphics()
    .poly(polygon)
    .stroke({ color: toPixiColor(pixi, color), width, alpha });

// Fills a convex polygon with parallel strokes. The node is pivoted on the shape center so
// the caller can open it with a horizontal scale without touching the geometry again.
export const drawHatchFill = (
    pixi: PixiModule,
    polygon: number[],
    spec: TemperaHatchSpec,
    color: string,
    alpha = 1,
): Graphics => {
    const node = new pixi.Graphics();
    const lines = buildHatchLines(polygon, spec);
    lines.forEach(line => {
        node.moveTo(line.x1, line.y1).lineTo(line.x2, line.y2);
    });
    if (lines.length > 0) {
        node.stroke({ color: toPixiColor(pixi, color), width: spec.width, alpha });
    }
    const center = boundsCenter(polygon);
    node.pivot.set(center.x, center.y);
    node.position.set(center.x, center.y);
    return node;
};

export const drawLines = (
    pixi: PixiModule,
    lines: TemperaHatchLine[],
    color: string,
    width: number,
    alpha = 1,
): Graphics => {
    const node = new pixi.Graphics();
    lines.forEach(line => {
        node.moveTo(line.x1, line.y1).lineTo(line.x2, line.y2);
    });
    if (lines.length > 0) {
        node.stroke({ color: toPixiColor(pixi, color), width, alpha });
    }
    return node;
};

export const drawPolyline = (
    pixi: PixiModule,
    points: number[],
    color: string,
    width: number,
    alpha = 1,
): Graphics => {
    const node = new pixi.Graphics();
    if (points.length < 4) return node;
    node.moveTo(points[0], points[1]);
    for (let index = 2; index < points.length; index += 2) {
        node.lineTo(points[index], points[index + 1]);
    }
    return node.stroke({ color: toPixiColor(pixi, color), width, alpha });
};

// Concentric 45°-rotated frames with alternating stroke weight, thickest on the outside.
export const drawConcentricDiamonds = (
    pixi: PixiModule,
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    rings: number,
    color: string,
    alpha = 1,
): Graphics => {
    const node = new pixi.Graphics();
    const stroke = toPixiColor(pixi, color);
    for (let ring = 0; ring < Math.max(1, rings); ring += 1) {
        const shrink = 1 - ring * 0.22;
        node
            .poly([cx, cy - ry * shrink, cx + rx * shrink, cy, cx, cy + ry * shrink, cx - rx * shrink, cy])
            .stroke({ color: stroke, width: ring % 2 === 0 ? 3.5 : 1.4, alpha });
    }
    node.pivot.set(cx, cy);
    node.position.set(cx, cy);
    return node;
};

export const drawCrossMarks = (
    pixi: PixiModule,
    marks: TemperaDecorMark[],
    color: string,
    width: number,
    alpha = 1,
): Graphics => {
    const node = new pixi.Graphics();
    marks.forEach(mark => {
        const cos = Math.cos(mark.rotation + Math.PI / 4) * mark.size;
        const sin = Math.sin(mark.rotation + Math.PI / 4) * mark.size;
        node.moveTo(mark.x - cos, mark.y - sin).lineTo(mark.x + cos, mark.y + sin);
        node.moveTo(mark.x - sin, mark.y + cos).lineTo(mark.x + sin, mark.y - cos);
    });
    if (marks.length > 0) {
        node.stroke({ color: toPixiColor(pixi, color), width, alpha });
    }
    return node;
};

export const drawSquareMarks = (
    pixi: PixiModule,
    marks: TemperaDecorMark[],
    color: string,
    alpha = 1,
): Graphics => {
    const node = new pixi.Graphics();
    marks.forEach(mark => {
        node.rect(mark.x - mark.size / 2, mark.y - mark.size / 2, mark.size, mark.size);
    });
    if (marks.length > 0) {
        node.fill({ color: toPixiColor(pixi, color), alpha });
    }
    return node;
};
