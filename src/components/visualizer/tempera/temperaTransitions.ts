import {
    TEMPERA_TRANSITION_KINDS,
    type TemperaParagraph,
    type TemperaShot,
    type TemperaTransitionKind,
} from './types';

// src/components/visualizer/tempera/temperaTransitions.ts
// Seek-stable transition frames; block-wipe and camera-pan let the large color fields
// guide the cut instead of dissolving typography.
export interface TemperaTransitionFrame {
    x: number;
    y: number;
    scale: number;
    rotation: number;
    alpha: number;
    blur: number;
    glitch: number;
    glitchSeed: number;
    /** 0..1 sweep coverage of the wipe block drawn by the runtime overlay. */
    wipe: number;
    /** -1 | 0 | 1 pan direction for camera-pan; 0 when unused. */
    panDirection: number;
}

export const IDLE_TEMPERA_TRANSITION_FRAME: TemperaTransitionFrame = {
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
    alpha: 1,
    blur: 0,
    glitch: 0,
    glitchSeed: 0,
    wipe: 0,
    panDirection: 0,
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const easeInOut = (value: number) => {
    const t = clamp01(value);
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};

const resolveBoundaryKind = (seed: number, boundaryIndex: number): TemperaTransitionKind => {
    const mixed = (seed ^ Math.imul(boundaryIndex + 1, 0x9e3779b1)) >>> 0;
    return TEMPERA_TRANSITION_KINDS[mixed % TEMPERA_TRANSITION_KINDS.length];
};

export const resolveTemperaTransitionEffectFrame = (
    kind: TemperaTransitionKind,
    phase: 'enter' | 'exit',
    progress: number,
    seed: number,
): TemperaTransitionFrame => {
    const linear = clamp01(progress);
    const eased = easeInOut(linear);
    const amount = phase === 'exit' ? eased : 1 - eased;

    if (kind === 'fast-blur') {
        return {
            ...IDLE_TEMPERA_TRANSITION_FRAME,
            alpha: phase === 'exit' ? 1 - amount : 1 - amount * 0.82,
            blur: amount * 14,
        };
    }

    if (kind === 'mono-glitch') {
        const step = Math.floor(linear * 14);
        return {
            ...IDLE_TEMPERA_TRANSITION_FRAME,
            alpha: phase === 'exit' && linear > 0.86
                ? 1 - (linear - 0.86) / 0.14
                : 1,
            glitch: amount,
            glitchSeed: seed * 0.0001 + step * 0.173,
        };
    }

    if (kind === 'block-wipe') {
        // The scene stays opaque; a full-height block sweeps across and the cut happens
        // underneath full coverage. Enter replays the sweep in reverse.
        return {
            ...IDLE_TEMPERA_TRANSITION_FRAME,
            wipe: phase === 'exit' ? eased : 1 - eased,
        };
    }

    // camera-pan: the frame tilts vertically as if the next composition is pulled into view.
    const direction = seed % 2 === 0 ? 1 : -1;
    const travel = 0.42 * direction;
    return {
        ...IDLE_TEMPERA_TRANSITION_FRAME,
        y: phase === 'exit' ? eased * travel : -(1 - eased) * travel,
        scale: 1 + amount * 0.05,
        alpha: phase === 'exit' ? 1 - eased * 0.9 : 0.1 + eased * 0.9,
        panDirection: direction,
    };
};

export const resolveTemperaExitTransitionFrame = (
    paragraph: TemperaParagraph,
    time: number,
    enabled: boolean,
    seed: number,
) => {
    const transition = paragraph.transitionOut;
    if (!enabled || !transition || time < transition.startTime) return IDLE_TEMPERA_TRANSITION_FRAME;
    const progress = (time - transition.startTime) / Math.max(transition.endTime - transition.startTime, 0.001);
    return resolveTemperaTransitionEffectFrame(transition.kind, 'exit', progress, seed);
};

export const resolveTemperaEnterTransitionFrame = (
    kind: TemperaTransitionKind | null,
    timeSinceStart: number,
    duration: number,
    enabled: boolean,
    seed: number,
) => {
    if (!enabled || !kind || timeSinceStart < 0 || timeSinceStart > duration) {
        return IDLE_TEMPERA_TRANSITION_FRAME;
    }
    return resolveTemperaTransitionEffectFrame(kind, 'enter', timeSinceStart / Math.max(duration, 0.001), seed);
};

// Gives every shot boundary a short transition; paragraphs commonly contain several shots.
export const resolveTemperaShotTransitionFrame = (
    shots: TemperaShot[],
    activeShotIndex: number,
    time: number,
    enabled: boolean,
    seed: number,
) => {
    if (!enabled || shots.length < 2) return IDLE_TEMPERA_TRANSITION_FRAME;
    const current = shots[activeShotIndex];
    if (!current) return IDLE_TEMPERA_TRANSITION_FRAME;

    if (activeShotIndex > 0) {
        const previous = shots[activeShotIndex - 1];
        const duration = Math.min(0.24, Math.max(0.14, (current.startTime - previous.startTime) * 0.18));
        if (time <= current.startTime + duration) {
            return resolveTemperaEnterTransitionFrame(
                resolveBoundaryKind(seed, activeShotIndex - 1),
                time - current.startTime,
                duration,
                true,
                seed + activeShotIndex * 97,
            );
        }
    }

    const next = shots[activeShotIndex + 1];
    if (!next) return IDLE_TEMPERA_TRANSITION_FRAME;
    const duration = Math.min(0.24, Math.max(0.14, (next.startTime - current.startTime) * 0.18));
    const transitionStart = next.startTime - duration;
    if (time < transitionStart) return IDLE_TEMPERA_TRANSITION_FRAME;
    return resolveTemperaTransitionEffectFrame(
        resolveBoundaryKind(seed, activeShotIndex),
        'exit',
        (time - transitionStart) / duration,
        seed + (activeShotIndex + 1) * 97,
    );
};
