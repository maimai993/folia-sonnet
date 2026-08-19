import type { Line } from '../../../types';
import type { GraphemeTiming } from '../../../utils/lyrics/graphemeTiming';

// src/components/visualizer/tempera/types.ts
// Public, renderer-independent contracts for the deterministic Tempera block PV program.
export type TemperaParagraphKind = 'breath' | 'verse' | 'lift' | 'chorus' | 'break' | 'outro';
export type TemperaParagraphBoundary = 'song-start' | 'time-gap' | 'metadata' | 'duration-cap' | 'line-cap';
/**
 * Every composition Tempera can cut to. Shots are half-phrase sized, so the list has to be
 * long enough that a paragraph rarely repeats one; `temperaShotProfiles.ts` carries the
 * layout region / camera / mood for each, and `temperaCompositions.ts` the drawing.
 */
export const TEMPERA_SHOT_KINDS = [
    // Splits and grids
    'duo-split',
    'quad-split',
    'tri-column',
    'thirds-stack',
    'checker-quad',
    'corner-wedge',
    'diagonal-halves',
    'cross-axis',
    // Bands
    'band-strip',
    'horizon-band',
    'deep-dive',
    'tone-ramp',
    // Frames and windows
    'frame-window',
    'double-frame',
    'circle-window',
    'ladder-frame',
    'corner-brackets',
    // Posters and shapes
    'poster-panel',
    'diamond-stack',
    'slash-poster',
    'arrow-wedge',
    'edge-bleed',
    // Sparse fields
    'quiet-line',
    'starfield-dots',
    'ripple-lines',
] as const;
export type TemperaShotKind = typeof TEMPERA_SHOT_KINDS[number];
/**
 * Every transition is led by the large graphics; nothing cuts hard, because a cut reads as an
 * edit and Tempera's compositions should hand off. None of them translates the scene either:
 * only one paragraph scene is ever drawn, so sliding one out just exposes the empty shell
 * behind it. Covering, scaling and fading are the only moves available here.
 */
export const TEMPERA_TRANSITION_KINDS = [
    'block-wipe',
    'shape-carry',
    'zoom-through',
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

export const TEMPERA_DECOR_MOTIFS = [
    'diamonds',
    'hatch-twin',
    'band-cross',
    'poster-diamond',
    'doodle',
] as const;
export type TemperaDecorMotif = typeof TEMPERA_DECOR_MOTIFS[number];

/** One stray glyph parked in the margins of a sparse composition. */
export interface TemperaDecorFragment {
    char: string;
    /** Fractional viewport position; the scene builder scales it to pixels. */
    x: number;
    y: number;
    rotation: number;
    scale: number;
}

/** Oversized decorative word set behind the composition, poster-watermark style. */
export interface TemperaDecorWatermark {
    text: string;
    /** Fractional viewport position of the word's centre. */
    x: number;
    y: number;
    rotation: number;
    /** Multiplier on the shot's base font size. */
    scale: number;
}

/**
 * Screentone decor for one shot, fully resolved at compile time so the renderer stays
 * free of randomness and every seek paints the identical frame.
 */
export interface TemperaDecorSpec {
    motif: TemperaDecorMotif;
    hatchAngle: number;
    crossCount: number;
    scribbleSeed: number;
    fragments: TemperaDecorFragment[];
    watermark: TemperaDecorWatermark | null;
}

/**
 * A shot shows part of one lyric line: a half-phrase, sliced on word boundaries. Keeping the
 * unit smaller than a line is what lets a single line run across several shots and read as
 * one continuous camera move instead of one static card per line.
 */
export interface TemperaShotSlice {
    /** `sourceIndex` of the compiled line this slice belongs to. */
    lineIndex: number;
    /** Half-open range into that line's `segments`. */
    segmentStart: number;
    segmentEnd: number;
}

export interface TemperaShot {
    id: string;
    kind: TemperaShotKind;
    startTime: number;
    endTime: number;
    slices: TemperaShotSlice[];
    /** Camera keyframe at shot start (fractional viewport offsets). */
    camera: TemperaCameraKey;
    /** Camera keyframe at shot end; the runtime interpolates between the two. */
    cameraEnd: TemperaCameraKey;
    /**
     * Direction (radians) this shot's graphics travel in. Consecutive shots only turn it by
     * a small amount, so blocks keep sweeping the same way across a cut and the boundary
     * reads as one continuous move rather than as an edit.
     */
    flowAngle: number;
    /** Deterministic screentone decor description for the MG layer. */
    decor: TemperaDecorSpec;
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
