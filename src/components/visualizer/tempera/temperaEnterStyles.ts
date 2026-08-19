import { easeTemperaSoftBack } from './temperaMotionEasing';

// src/components/visualizer/tempera/temperaEnterStyles.ts
// The ways a glyph can arrive. One style is picked per word at layout time, so a word lands as
// a unit while neighbouring words arrive differently — that variety is what keeps a collage
// from reading as one uniform slide-in.
export const TEMPERA_ENTER_STYLES = [
    'slide',
    'drop',
    'stamp',
    'swing',
    'rise',
] as const;
export type TemperaEnterStyle = typeof TEMPERA_ENTER_STYLES[number];

export interface TemperaEnterInput {
    enterX: number;
    enterY: number;
    enterRotation: number;
    enterScale: number;
}

export interface TemperaEnterFrame {
    x: number;
    y: number;
    rotation: number;
    scaleX: number;
    scaleY: number;
    /** 0 when the style has no travel worth echoing (a stamp has nowhere to trail from). */
    echo: number;
}

/**
 * Resolves one style's offset/rotation/scale at a point in its entrance.
 * `travel` runs 1 -> 0 across the window and `linear` is the raw 0 -> 1 progress; styles that
 * need their own curve re-ease `linear` rather than reusing the shared travel.
 */
export const resolveTemperaEnterFrame = (
    style: TemperaEnterStyle,
    input: TemperaEnterInput,
    travel: number,
    linear: number,
): TemperaEnterFrame => {
    const settle = easeTemperaSoftBack(linear);
    const uniform = input.enterScale + (1 - input.enterScale) * settle;

    switch (style) {
        case 'drop':
            // Straight down from above the layout line, landing with the soft-back overshoot.
            return {
                x: input.enterX * 0.15 * travel,
                y: -Math.abs(input.enterY) * 2.1 * travel,
                rotation: input.enterRotation * 0.35 * travel,
                scaleX: uniform,
                scaleY: uniform,
                echo: travel,
            };
        case 'stamp':
            // Slams down onto the page from oversize; no travel, so no echo trail.
            return {
                x: 0,
                y: 0,
                rotation: input.enterRotation * 0.6 * travel,
                scaleX: 1 + travel * 0.95,
                scaleY: 1 + travel * 0.95,
                echo: 0,
            };
        case 'swing':
            // Rotates in around its own centre from a wide angle.
            return {
                x: input.enterX * 0.55 * travel,
                y: input.enterY * 0.55 * travel,
                rotation: (input.enterRotation + Math.sign(input.enterRotation || 1) * 0.95) * travel,
                scaleX: uniform,
                scaleY: uniform,
                echo: travel * 0.8,
            };
        case 'rise':
            // Grows up out of the baseline from below.
            return {
                x: input.enterX * 0.2 * travel,
                y: Math.abs(input.enterY) * 1.5 * travel,
                rotation: input.enterRotation * 0.3 * travel,
                scaleX: uniform,
                scaleY: Math.max(0.05, uniform * (1 - travel * 0.7)),
                echo: travel * 0.7,
            };
        case 'slide':
        default:
            return {
                x: input.enterX * travel,
                y: input.enterY * travel,
                rotation: input.enterRotation * travel,
                scaleX: uniform,
                scaleY: uniform,
                echo: travel,
            };
    }
};
