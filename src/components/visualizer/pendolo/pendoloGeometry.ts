import { prepareWithSegments, layoutWithLines } from '@chenglou/pretext';
import { type Line, type PendoloTuning } from '../../../types';

// src/components/visualizer/pendolo/pendoloGeometry.ts

export interface PendoloBlockSize {
    width: number;
    height: number;
}

export interface PendoloLineItem {
    line: Line;
    index: number;
    angleRad: number;
    angleDeg: number;
    x: number;
    y: number;
    isActive: boolean;
    distanceFromActive: number;
    alpha: number;
    scale: number;
}

/**
 * Calculates wheel geometry and placement for lyric lines along the pendulum escapement arc.
 */
export function calculatePendoloWheelLayout(
    lines: Line[],
    targetLineIndex: number,
    escapementAngleOffsetRad: number,
    viewportWidth: number,
    viewportHeight: number,
    tuning: PendoloTuning,
    radiusOffsetPx = 0,
    lineBlockHeights?: number[],
    blockSizes?: PendoloBlockSize[],
): PendoloLineItem[] {
    const centerX = viewportWidth * tuning.wheelCenterX;
    const centerY = viewportHeight * tuning.wheelCenterY;
    const baseRadius = Math.min(viewportWidth, viewportHeight) * tuning.arcRadius + radiusOffsetPx;

    // Angle step between adjacent lyric lines along the wheel arc (in radians)
    const totalArcRad = (tuning.arcAngleDeg * Math.PI) / 180;
    const visibleWindowCount = 9; // Number of lines visible across the arc window
    const angleStepRad = totalArcRad / Math.max(1, visibleWindowCount - 1);

    const isIntegerTarget = Number.isInteger(targetLineIndex);
    const activeIndex = isIntegerTarget && targetLineIndex >= 0 && targetLineIndex < lines.length
        ? targetLineIndex
        : -1;
    const hasActive = activeIndex >= 0;
    const items: PendoloLineItem[] = [];

    // Reference center for rendering window
    const centerRef = Math.max(0, Math.min(lines.length - 1, Math.floor(targetLineIndex >= 0 ? targetLineIndex : 0)));
    // Wide enough index window; actual visibility is angle-gated at ±90° (right semicircle only)
    const windowStart = Math.max(0, centerRef - 8);
    const windowEnd = Math.min(lines.length - 1, centerRef + 8);
    const visualAngles = new Map<number, number>();

    if (Number.isInteger(targetLineIndex) && targetLineIndex >= windowStart && targetLineIndex <= windowEnd) {
        const activeIndex = targetLineIndex;
        visualAngles.set(activeIndex, 0);
        for (let index = activeIndex + 1; index <= windowEnd; index += 1) {
            const previousHeight = lineBlockHeights?.[index - 1] ?? 0;
            const currentHeight = lineBlockHeights?.[index] ?? 0;
            const spacing = Math.max(angleStepRad, (previousHeight + currentHeight + 24) / (2 * baseRadius));
            visualAngles.set(index, (visualAngles.get(index - 1) ?? 0) + spacing);
        }
        for (let index = activeIndex - 1; index >= windowStart; index -= 1) {
            const nextHeight = lineBlockHeights?.[index + 1] ?? 0;
            const currentHeight = lineBlockHeights?.[index] ?? 0;
            const spacing = Math.max(angleStepRad, (nextHeight + currentHeight + 24) / (2 * baseRadius));
            visualAngles.set(index, (visualAngles.get(index + 1) ?? 0) - spacing);
        }
    }

    for (let i = windowStart; i <= windowEnd; i++) {
        const line = lines[i];
        if (!line) continue;

        const distanceIndex = i - targetLineIndex;
        // Base focal angle is 0 (horizontal to right).
        // Upcoming lines curve downward (positive angle), past lines curve upward (negative angle).
        const rawAngleRad = (visualAngles.get(i) ?? distanceIndex * angleStepRad) + escapementAngleOffsetRad;

        // Only render lines on the right semicircle (±90° from focal axis)
        if (Math.abs(rawAngleRad) >= Math.PI / 2) continue;

        // Cartesian coordinates on screen relative to center on left edge
        const x = centerX + baseRadius * Math.cos(rawAngleRad);
        const y = centerY + baseRadius * Math.sin(rawAngleRad);

        const isActive = hasActive && i === activeIndex;
        const absDistance = Math.abs(distanceIndex);

        // Alpha decays smoothly as lines move further from the focal position (angle = 0)
        const alpha = Math.max(0.12, Math.pow(Math.cos(rawAngleRad * 0.75), 2.5) * (1 - absDistance * 0.18));

        // Focal line gets activeScale boost, neighboring lines scale down gracefully
        const scale = isActive
            ? tuning.activeScale
            : Math.max(0.7, 1 - absDistance * 0.08);

        items.push({
            line,
            index: i,
            angleRad: rawAngleRad,
            angleDeg: (rawAngleRad * 180) / Math.PI,
            x,
            y,
            isActive,
            distanceFromActive: absDistance,
            alpha,
            scale,
        });
    }

    return dropPendoloOverlappingItems(items, blockSizes);
}

/** 文字块以左中为锚点向右延伸（`transformOrigin: left center`），宽高都乘这一行的 scale。 */
const pendoloBoxOf = (item: PendoloLineItem, size: PendoloBlockSize) => {
    const scale = item.scale;
    return {
        left: item.x,
        right: item.x + size.width * scale,
        top: item.y - (size.height * scale) / 2,
        bottom: item.y + (size.height * scale) / 2,
    };
};

/**
 * 按真实块尺寸剔除会重叠的行。
 *
 * 角间距只按**行高**算（`(prevH + curH + 24) / 2R`），可文字块是**宽**的：越靠近圆弧两端，
 * 相邻两行的中心越是横向错开，而每块从锚点一直向右铺开上百像素 —— 于是横向压在一起。
 * 屏幕越小轮盘越窄，这条越明显（#178）。这里从焦点行往外一行行放，放不下的直接不画，
 * 放得下的与原来完全一致。
 */
const dropPendoloOverlappingItems = (
    items: PendoloLineItem[],
    blockSizes?: PendoloBlockSize[],
): PendoloLineItem[] => {
    if (!blockSizes || blockSizes.length === 0) return items;
    const ordered = [...items].sort((left, right) => left.distanceFromActive - right.distanceFromActive);
    const kept: PendoloLineItem[] = [];
    const boxes: Array<ReturnType<typeof pendoloBoxOf>> = [];
    for (const item of ordered) {
        const size = blockSizes[item.index];
        // 没有尺寸信息的行照旧画：剔除只用于「知道多大却会压住别人」的那些行。
        if (!size || size.width <= 0 || size.height <= 0) {
            kept.push(item);
            continue;
        }
        const box = pendoloBoxOf(item, size);
        const collides = boxes.some(other => (
            box.left < other.right && other.left < box.right
            && box.top < other.bottom && other.top < box.bottom
        ));
        if (collides) continue;
        kept.push(item);
        boxes.push(box);
    }
    return kept.sort((left, right) => left.index - right.index);
}

/**
 * Measures line width using @chenglou/pretext for precise typography alignment.
 */
export function measurePendoloLineWidth(text: string, fontSpec: string): number {
    if (!text) return 0;
    try {
        const prepared = prepareWithSegments(text, fontSpec);
        const layout = layoutWithLines(prepared, 2000, 32);
        return layout.lines[0]?.width ?? 0;
    } catch {
        return text.length * 16;
    }
}
