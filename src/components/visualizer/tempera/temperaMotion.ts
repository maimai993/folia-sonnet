// src/components/visualizer/tempera/temperaMotion.ts
// Pure absolute-time motion evaluation for Tempera. Every value is derived from the clock
// and per-glyph constants, so a seek paints exactly the frame continuous playback would.
export const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const cubicCoordinate = (point1: number, point2: number, time: number) => {
    const inverse = 1 - time;
    return 3 * inverse * inverse * time * point1
        + 3 * inverse * time * time * point2
        + time * time * time;
};

// Resolves CSS-style cubic-bezier timing by solving the x curve before sampling y.
export const resolveCubicBezier = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    value: number,
) => {
    const target = clamp01(value);
    if (target === 0 || target === 1) return target;
    let low = 0;
    let high = 1;
    let parameter = target;
    for (let iteration = 0; iteration < 12; iteration += 1) {
        const x = cubicCoordinate(x1, x2, parameter);
        if (x < target) low = parameter;
        else high = parameter;
        parameter = (low + high) / 2;
    }
    return cubicCoordinate(y1, y2, parameter);
};

/** Long, soft deceleration: decisive at the start, then a long creeping tail. */
export const easeTemperaEnter = (value: number) => resolveCubicBezier(0.22, 1, 0.36, 1, value);
export const easeTemperaInOut = (value: number) => resolveCubicBezier(0.62, 0, 0.32, 1, value);
/** Mild anticipation on the way out; used for scale so glyphs settle with a small overshoot. */
export const easeTemperaSoftBack = (value: number) => {
    const t = clamp01(value);
    const c = 1.42;
    return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};

export interface TemperaGlyphMotionInput {
    startTime: number;
    settleTime: number;
    /** When the grapheme stops being sung; drives the small current-glyph emphasis. */
    endTime: number;
    enterX: number;
    enterY: number;
    enterRotation: number;
    enterScale: number;
    driftPhase: number;
    rotation: number;
}

export interface TemperaGlyphMotionFrame {
    visible: boolean;
    alpha: number;
    x: number;
    y: number;
    rotation: number;
    scale: number;
}

const DRIFT_PIXELS = 1.6;
const DRIFT_ROTATION = 0.0055;
const CURRENT_EMPHASIS = 0.05;

// Resolves one glyph's entrance plus the slow settled drift that keeps a finished line alive.
// `motion` is the tuning/theme-scaled amount; 0 pins glyphs to their layout position.
export const resolveTemperaGlyphMotion = (
    glyph: TemperaGlyphMotionInput,
    time: number,
    motion: number,
): TemperaGlyphMotionFrame => {
    const window = Math.max(glyph.settleTime - glyph.startTime, 0.08);
    const linear = clamp01((time - glyph.startTime) / window);
    const travel = 1 - easeTemperaEnter(linear);
    const scale = glyph.enterScale + (1 - glyph.enterScale) * easeTemperaSoftBack(linear);
    // Alpha resolves faster than position, so the glyph is readable while it is still moving.
    const alpha = easeTemperaInOut(clamp01(linear * 2.4));

    // Settled drift: a tiny two-frequency float that starts only once the entrance is done.
    // Current-glyph emphasis is a small scale swell, not a painted backing block: anything
    // drawn behind the glyph would become the backdrop the inversion filter reads, which is
    // exactly what turns the effect into a colored box instead of a reaction to the artwork.
    const sungWindow = Math.max(glyph.endTime - glyph.startTime, 0.08);
    const emphasis = (1 - easeTemperaInOut(clamp01((time - glyph.startTime) / (sungWindow + 0.18))))
        * easeTemperaInOut(clamp01((time - glyph.startTime) / 0.12));

    const settled = clamp01((time - glyph.settleTime) / 0.9);
    const phase = glyph.driftPhase;
    const drift = settled * motion;
    const driftX = Math.sin(time * 0.62 + phase) * DRIFT_PIXELS * drift;
    const driftY = Math.cos(time * 0.47 + phase * 1.7) * DRIFT_PIXELS * 0.7 * drift;

    return {
        visible: time >= glyph.startTime,
        alpha,
        x: glyph.enterX * travel * motion + driftX,
        y: glyph.enterY * travel * motion + driftY,
        rotation: glyph.rotation + glyph.enterRotation * travel * motion
            + Math.sin(time * 0.39 + phase * 2.3) * DRIFT_ROTATION * drift,
        // A muted motion setting pulls the entrance scale back toward 1 instead of inverting it.
        scale: scale + (1 - scale) * (1 - clamp01(motion)) + emphasis * CURRENT_EMPHASIS * clamp01(motion),
    };
};

/**
 * Maps a shot-relative fraction onto seconds, clamped so a very short or very long shot
 * still animates at a watchable speed. This is what ties block motion to the line's pace
 * instead of to a fixed wall-clock duration.
 */
export const resolveShotPacedDuration = (
    shotDuration: number,
    fraction: number,
    minSeconds: number,
    maxSeconds: number,
) => Math.min(maxSeconds, Math.max(minSeconds, shotDuration * fraction));
