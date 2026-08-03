import { hashSonnetSeed } from './sonnetRandom';

// src/components/visualizer/sonnet/sonnetPosterBlocksLayout.ts
// Anchors emphasis first, then fills the remaining measured rectangles in reading order.
export interface SonnetPosterBlockBox {
    isHero: boolean;
    isSemiHero: boolean;
    displayText: string;
    verticalDisplayText?: string;
    verticalMeasuredWidth?: number;
    verticalMeasuredHeight?: number;
    fontScale: number;
    measuredWidth: number;
    measuredHeight: number;
    x: number;
    y: number;
    rotation: number;
    vertical: boolean;
    layoutDirection: 'horizontal' | 'vertical';
    enterX: number;
    enterY: number;
}

export interface SonnetPosterBlocksPlan<T extends SonnetPosterBlockBox> {
    placements: T[];
    width: number;
    height: number;
    gap: number;
}

interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface PlannedPlacement<T> extends Rect {
    box: T;
    scale: number;
    vertical: boolean;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const rectRight = (rect: Rect) => rect.x + rect.width;
const rectBottom = (rect: Rect) => rect.y + rect.height;

const intersects = (first: Rect, second: Rect) => (
    first.x < rectRight(second)
    && rectRight(first) > second.x
    && first.y < rectBottom(second)
    && rectBottom(first) > second.y
);

const contains = (outer: Rect, inner: Rect) => (
    inner.x >= outer.x
    && inner.y >= outer.y
    && rectRight(inner) <= rectRight(outer)
    && rectBottom(inner) <= rectBottom(outer)
);

// MaxRects-style splitting keeps every remaining region disjoint from placed typography.
const subtractPlacement = (freeRects: Rect[], placed: Rect, gap: number) => {
    const padded = {
        x: placed.x - gap,
        y: placed.y - gap,
        width: placed.width + gap * 2,
        height: placed.height + gap * 2,
    };
    const split: Rect[] = [];
    freeRects.forEach(rect => {
        if (!intersects(rect, padded)) {
            split.push(rect);
            return;
        }
        if (padded.x > rect.x) split.push({ ...rect, width: padded.x - rect.x });
        if (rectRight(padded) < rectRight(rect)) {
            split.push({ ...rect, x: rectRight(padded), width: rectRight(rect) - rectRight(padded) });
        }
        if (padded.y > rect.y) split.push({ ...rect, height: padded.y - rect.y });
        if (rectBottom(padded) < rectBottom(rect)) {
            split.push({ ...rect, y: rectBottom(padded), height: rectBottom(rect) - rectBottom(padded) });
        }
    });
    return split
        .filter(rect => rect.width > gap && rect.height > gap)
        .filter((rect, index, all) => !all.some((other, otherIndex) => otherIndex !== index && contains(other, rect)));
};

const candidateNoise = (seed: number, boxIndex: number, rect: Rect) => (
    hashSonnetSeed(`${seed}:${boxIndex}:${Math.round(rect.x)}:${Math.round(rect.y)}`) / 0xffffffff
);

const findPlacement = <T extends SonnetPosterBlockBox>(
    box: T,
    boxIndex: number,
    freeRects: Rect[],
    canvas: Rect,
    seed: number,
    scaleLimit: number,
    minimumScale: number,
): PlannedPlacement<T> | null => {
    let best: { placement: PlannedPlacement<T>; score: number } | null = null;
    for (const rect of freeRects) {
        const orientations = [{ width: box.measuredWidth, height: box.measuredHeight, vertical: false }];
        if (box.verticalMeasuredWidth && box.verticalMeasuredHeight) {
            orientations.push({
                width: box.verticalMeasuredWidth,
                height: box.verticalMeasuredHeight,
                vertical: true,
            });
        }
        for (const orientation of orientations) {
            const scale = Math.min(scaleLimit, rect.width / orientation.width, rect.height / orientation.height);
            if (scale < minimumScale) continue;
            const width = orientation.width * scale;
            const height = orientation.height * scale;
            const readingOrder = (rect.y - canvas.y) * (canvas.width + 1) + (rect.x - canvas.x);
            const unusedRatio = (rect.width * rect.height - width * height) / Math.max(1, canvas.width * canvas.height);
            const orientationPenalty = orientation.vertical ? 0.04 : 0;
            const score = readingOrder + unusedRatio * 0.5 + orientationPenalty
                + candidateNoise(seed, boxIndex, rect) * 0.1;
            const placement = {
                box,
                scale,
                x: rect.x,
                y: rect.y,
                width,
                height,
                vertical: orientation.vertical,
            };
            if (!best || score < best.score) best = { placement, score };
        }
    }
    return best?.placement ?? null;
};

const tryLayout = <T extends SonnetPosterBlockBox>(
    boxes: T[],
    canvas: Rect,
    gap: number,
    seed: number,
    scaleLimit: number,
) => {
    const primaryHero = boxes.filter(box => box.isHero)
        .sort((first, second) => second.measuredWidth * second.measuredHeight - first.measuredWidth * first.measuredHeight)[0]
        ?? boxes[0];
    const heroScale = Math.min(
        scaleLimit,
        canvas.width * 0.58 / primaryHero.measuredWidth,
        canvas.height * 0.46 / primaryHero.measuredHeight,
    );
    const heroWidth = primaryHero.measuredWidth * heroScale;
    const heroHeight = primaryHero.measuredHeight * heroScale;
    const heroOnRight = (seed & 1) === 0;
    const hero: PlannedPlacement<T> = {
        box: primaryHero,
        scale: heroScale,
        x: heroOnRight ? rectRight(canvas) - heroWidth : canvas.x,
        y: canvas.y,
        width: heroWidth,
        height: heroHeight,
        vertical: false,
    };
    const placements = [hero];
    let freeRects = subtractPlacement([canvas], hero, gap);
    const anchors = boxes.filter(box => box !== primaryHero && (box.isHero || box.isSemiHero));
    const supports = boxes.filter(box => box !== primaryHero && !box.isHero && !box.isSemiHero);
    const minimumScale = Math.max(0.16, scaleLimit * 0.56);

    for (const box of anchors) {
        const placement = findPlacement(
            box,
            boxes.indexOf(box),
            freeRects,
            canvas,
            seed,
            scaleLimit * 0.96,
            minimumScale,
        );
        if (!placement) return null;
        placements.push(placement);
        freeRects = subtractPlacement(freeRects, placement, gap);
    }
    for (const box of supports) {
        const placement = findPlacement(
            box,
            boxes.indexOf(box),
            freeRects,
            canvas,
            seed,
            scaleLimit * 1.08,
            minimumScale,
        );
        if (!placement) return null;
        placements.push(placement);
        freeRects = subtractPlacement(freeRects, placement, gap);
    }
    return placements;
};

export const layoutSonnetPosterBlocks = <T extends SonnetPosterBlockBox>(
    boxes: T[],
    width: number,
    height: number,
    baseFontSize: number,
    seed = 0,
): SonnetPosterBlocksPlan<T> => {
    if (boxes.length === 0) return { placements: [], width: 0, height: 0, gap: 0 };
    const gap = clamp(baseFontSize * 0.08, 2, 8);
    const canvas = {
        x: -width * 0.39,
        y: -height * 0.36,
        width: width * 0.78,
        height: height * 0.72,
    };
    let planned: PlannedPlacement<T>[] | null = null;
    for (const scaleLimit of [1.12, 1, 0.88, 0.76, 0.64, 0.52, 0.42, 0.34, 0.28]) {
        planned = tryLayout(boxes, canvas, gap, seed, scaleLimit);
        if (planned) break;
    }
    if (!planned) planned = tryLayout(boxes, canvas, 0, seed, 0.5) ?? [];

    planned.forEach(placement => {
        const { box } = placement;
        box.fontScale *= placement.scale;
        box.measuredWidth = placement.width;
        box.measuredHeight = placement.height;
        if (placement.vertical && box.verticalDisplayText) box.displayText = box.verticalDisplayText;
        box.x = placement.x + placement.width / 2;
        box.y = placement.y + placement.height / 2;
        box.rotation = 0;
        box.vertical = placement.vertical;
        box.layoutDirection = placement.vertical ? 'vertical' : 'horizontal';
        box.enterX = (placement.x < 0 ? -1 : 1) * Math.min(28, baseFontSize * 0.45);
        box.enterY = Math.min(18, baseFontSize * 0.25);
    });
    return { placements: boxes, width: canvas.width, height: canvas.height, gap };
};
