import {
    clamp01,
    easeTemperaEnter,
    easeTemperaInOut,
    easeTemperaOutward,
    easeTemperaSoftBack,
    resolveCubicBezier,
} from './temperaMotionEasing';
import { resolveTemperaEnterFrame, type TemperaEnterStyle } from './temperaEnterStyles';

// src/components/visualizer/tempera/temperaMotion.ts
// Pure absolute-time motion evaluation for Tempera. Every value is derived from the clock
// and per-glyph constants, so a seek paints exactly the frame continuous playback would.
export {
    clamp01,
    easeTemperaEnter,
    easeTemperaInOut,
    easeTemperaOutward,
    easeTemperaSoftBack,
    resolveCubicBezier,
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
    rotation: number;
    enterStyle: TemperaEnterStyle;
    /**
     * When the post-sung release reaches full amplitude. Bounded by the line's own duration,
     * so a glyph keeps opening up for as long as its line lasts and no longer.
     */
    releaseTime: number;
    /** Offset of this glyph from the block centre; the release scales it to widen tracking. */
    trackingX: number;
    trackingY: number;
}

export interface TemperaGlyphMotionFrame {
    visible: boolean;
    alpha: number;
    x: number;
    y: number;
    rotation: number;
    /** Separate axes: several entrance styles open the glyph on one axis only. */
    scaleX: number;
    scaleY: number;
    /** Offset of the first motion echo, and its opacity; both die by the settle time. */
    echoX: number;
    echoY: number;
    echoAlpha: number;
}

const CURRENT_EMPHASIS = 0.05;
const ECHO_ALPHA = 0.5;
/** How much wider the sung block gets. Deliberately small: this is tracking, not drift. */
const RELEASE_TRACKING = 0.055;

// Resolves one glyph's entrance plus the post-sung tracking release that keeps a finished
// line alive without breaking its layout.
// `motion` is the tuning/theme-scaled amount; 0 pins glyphs to their layout position.
export const resolveTemperaGlyphMotion = (
    glyph: TemperaGlyphMotionInput,
    time: number,
    motion: number,
): TemperaGlyphMotionFrame => {
    const window = Math.max(glyph.settleTime - glyph.startTime, 0.08);
    const linear = clamp01((time - glyph.startTime) / window);
    const travel = 1 - easeTemperaEnter(linear);
    const entrance = resolveTemperaEnterFrame(glyph.enterStyle, glyph, travel, linear);
    // Alpha resolves faster than position, so the glyph is readable while it is still moving.
    const alpha = easeTemperaInOut(clamp01(linear * 2.4));

    // Settled drift: a tiny two-frequency float that starts only once the entrance is done.
    // Current-glyph emphasis is a small scale swell, not a painted backing block: anything
    // drawn behind the glyph would become the backdrop the inversion filter reads, which is
    // exactly what turns the effect into a colored box instead of a reaction to the artwork.
    const sungWindow = Math.max(glyph.endTime - glyph.startTime, 0.08);
    const emphasis = (1 - easeTemperaInOut(clamp01((time - glyph.startTime) / (sungWindow + 0.18))))
        * easeTemperaInOut(clamp01((time - glyph.startTime) / 0.12));

    // Release: once a glyph has been sung the block slowly opens its tracking instead of
    // freezing. A line that finished early would otherwise sit dead for the rest of a long
    // shot. This is a rigid, centre-out expansion - no wander, no float, no rotation - because
    // a drifting glyph would contradict the deterministic typesetting the mode is built on.
    // The ramp starts at the later of "sung" and "settled" so it never fights the entrance.
    const releaseStart = Math.max(glyph.endTime, glyph.settleTime);
    const release = easeTemperaInOut(clamp01(
        (time - releaseStart) / Math.max(glyph.releaseTime - releaseStart, 0.001),
    ));
    const spread = release * clamp01(motion) * RELEASE_TRACKING;
    const driftX = glyph.trackingX * spread;
    const driftY = glyph.trackingY * spread;

    // A muted motion setting pulls the entrance back toward the resting pose instead of
    // inverting it, so `glyphMotion: 0` pins every style to its layout position.
    const amount = clamp01(motion);
    const swell = emphasis * CURRENT_EMPHASIS * amount;
    return {
        visible: time >= glyph.startTime,
        alpha,
        x: entrance.x * motion + driftX,
        y: entrance.y * motion + driftY,
        rotation: glyph.rotation + entrance.rotation * motion,
        scaleX: entrance.scaleX + (1 - entrance.scaleX) * (1 - amount) + swell,
        scaleY: entrance.scaleY + (1 - entrance.scaleY) * (1 - amount) + swell,
        echoX: entrance.x * motion,
        echoY: entrance.y * motion,
        echoAlpha: entrance.echo * ECHO_ALPHA * amount,
    };
};

export interface TemperaStaggerWindow {
    delay: number;
    span: number;
}

/**
 * Spreads one staggered item across the shot it belongs to. There is deliberately no upper
 * clamp in seconds: capping the window meant a long shot finished all of its motion early
 * and then sat on a still frame. The only guards are a floor, so a very short shot does not
 * flash, and a compression pass so the last item still lands before the shot ends.
 */
export const resolveShotStagger = (
    shotDuration: number,
    delayFraction: number,
    spanFraction: number,
    minSpan = 0.42,
): TemperaStaggerWindow => {
    const span = Math.max(minSpan, shotDuration * spanFraction);
    const delay = Math.max(0, shotDuration * delayFraction);
    const budget = Math.max(minSpan, shotDuration * 0.94);
    const compress = Math.min(1, budget / (delay + span));
    return { delay: delay * compress, span: Math.max(minSpan * 0.6, span * compress) };
};
