import type { Line } from '../../../types';
import type { GraphemeTiming } from '../../../utils/lyrics/graphemeTiming';

// src/components/visualizer/tempera/types.ts
// Public, renderer-independent contracts for the deterministic Tempera block PV program.
export type TemperaParagraphKind = 'breath' | 'verse' | 'lift' | 'chorus' | 'break' | 'outro';
export type TemperaParagraphBoundary = 'song-start' | 'time-gap' | 'metadata' | 'duration-cap' | 'line-cap';
export type TemperaShotKind =
    | 'duo-split'
    | 'band-strip'
    | 'frame-window'
    | 'poster-panel'
    | 'quiet-line';
export const TEMPERA_TRANSITION_KINDS = [
    'fast-blur',
    'mono-glitch',
    'block-wipe',
    'camera-pan',
] as const;
export type TemperaTransitionKind = typeof TEMPERA_TRANSITION_KINDS[number];

export interface TemperaSegment {
    text: string;
    startOffset: number;
    endOffset: number;
    startTime: number;
    endTime: number;
    graphemes: GraphemeTiming[];
    isWordLike: boolean;
}

export interface TemperaCompiledLine {
    sourceIndex: number;
    line: Line;
    renderEndTime: number;
    segments: TemperaSegment[];
}

export interface TemperaCameraKey {
    x: number;
    y: number;
    zoom: number;
    rotation: number;
}

export interface TemperaShot {
    id: string;
    kind: TemperaShotKind;
    startTime: number;
    endTime: number;
    lineIndices: number[];
    /** Camera keyframe at shot start (fractional viewport offsets). */
    camera: TemperaCameraKey;
    /** Camera keyframe at shot end; the runtime interpolates between the two. */
    cameraEnd: TemperaCameraKey;
}

export interface TemperaTransition {
    kind: TemperaTransitionKind;
    startTime: number;
    endTime: number;
}

export interface TemperaParagraph {
    id: string;
    kind: TemperaParagraphKind;
    boundary: TemperaParagraphBoundary;
    startTime: number;
    endTime: number;
    lines: TemperaCompiledLine[];
    shots: TemperaShot[];
    transitionOut: TemperaTransition | null;
}

export interface TemperaProgram {
    version: 1;
    seed: string;
    paragraphGapThreshold: number;
    paragraphs: TemperaParagraph[];
}
