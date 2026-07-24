import { prepareWithSegments, layoutWithLines } from '@chenglou/pretext';
import { type Line, type PendoloTuning } from '../../../types';

// src/components/visualizer/pendolo/pendoloGeometry.ts

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
    currentLineIndex: number,
    escapementAngleOffsetRad: number,
    viewportWidth: number,
    viewportHeight: number,
    tuning: PendoloTuning,
): PendoloLineItem[] {
    const centerX = viewportWidth * (0.5 + tuning.wheelCenterX);
    const centerY = viewportHeight * tuning.wheelCenterY;
    const baseRadius = Math.min(viewportWidth, viewportHeight) * tuning.arcRadius;

    // Angle step between adjacent lyric lines along the wheel arc (in radians)
    const totalArcRad = (tuning.arcAngleDeg * Math.PI) / 180;
    const visibleWindowCount = 9; // Number of lines visible across the arc window
    const angleStepRad = totalArcRad / Math.max(1, visibleWindowCount - 1);

    const activeIndex = Math.max(0, Math.min(lines.length - 1, currentLineIndex));
    const items: PendoloLineItem[] = [];

    // Process lines within a 7-line window around current active line
    const windowStart = Math.max(0, activeIndex - 4);
    const windowEnd = Math.min(lines.length - 1, activeIndex + 4);

    for (let i = windowStart; i <= windowEnd; i++) {
        const line = lines[i];
        if (!line) continue;

        const distanceIndex = i - activeIndex;
        // Base focal angle is 0 (horizontal to right).
        // Past lines curve upward (positive angle), upcoming curve downward (negative angle).
        const rawAngleRad = -distanceIndex * angleStepRad + escapementAngleOffsetRad;

        // Cartesian coordinates on screen relative to center
        const x = centerX + baseRadius * Math.cos(rawAngleRad);
        const y = centerY + baseRadius * Math.sin(rawAngleRad);

        const isActive = i === activeIndex;
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

    return items;
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
