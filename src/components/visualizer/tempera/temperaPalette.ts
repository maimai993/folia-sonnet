import type { TemperaTuning, Theme } from '../../../types';
import { colorWithAlpha, mixColors, parseColorChannels } from '../colorMix';

// src/components/visualizer/tempera/temperaPalette.ts
// Derives Tempera's block palette from the active DualTheme side; mono mode collapses
// every derived step to a grayscale ink↔paper ladder so hue never leaks through.
export interface TemperaPalette {
    paper: string;
    ink: string;
    blockA: string;
    blockB: string;
    blockC: string;
    accent: string;
    line: string;
    shadow: string;
    /** Monotonic paper -> ink brightness ladder driving hatch density and graphic shading. */
    tone1: string;
    tone2: string;
    tone3: string;
    tone4: string;
}

/** Fixed paper -> ink mix positions; the screentone layer maps tone index to hatch density. */
export const TEMPERA_TONE_STOPS = [0.12, 0.3, 0.52, 0.72] as const;

// Collapses a color to its Rec.709 luminance so mono blocks stay a true grayscale ladder.
const toGray = (color: string, fallback: string) => {
    const channels = parseColorChannels(color);
    if (!channels) return fallback;
    const luminance = Math.round(channels.r * 0.2126 + channels.g * 0.7152 + channels.b * 0.0722);
    return `rgb(${luminance}, ${luminance}, ${luminance})`;
};

const grayLevel = (color: string) => parseColorChannels(color)?.r ?? 128;

const luminanceOf = (color: string) => {
    const channels = parseColorChannels(color);
    if (!channels) return 128;
    return channels.r * 0.2126 + channels.g * 0.7152 + channels.b * 0.0722;
};

// Rescales a tinted color back onto the untinted step's luminance, so adding hue never
// reorders the tone ladder.
const matchLuminance = (color: string, target: string) => {
    const channels = parseColorChannels(color);
    if (!channels) return target;
    const current = luminanceOf(color);
    const wanted = luminanceOf(target);
    if (current <= 0.5) return target;
    const gain = wanted / current;
    const scaled = {
        r: Math.round(Math.min(255, channels.r * gain)),
        g: Math.round(Math.min(255, channels.g * gain)),
        b: Math.round(Math.min(255, channels.b * gain)),
    };
    // Clipping a bright channel would break the match; fall back to the neutral step.
    if (Math.abs(luminanceOf(`rgb(${scaled.r}, ${scaled.g}, ${scaled.b})`) - wanted) > 1.5) return target;
    return `rgb(${scaled.r}, ${scaled.g}, ${scaled.b})`;
};

// Builds the four screentone steps. Hue tints only shift chroma: each tinted step is pulled
// back to the neutral step's luminance so the paper -> ink brightness order always holds.
const buildToneLadder = (paper: string, ink: string, tintA?: string, tintB?: string) => {
    const step = (index: number, tint?: string) => {
        const base = mixColors(paper, ink, TEMPERA_TONE_STOPS[index]);
        return tint ? matchLuminance(mixColors(base, tint, 0.3), base) : base;
    };
    return {
        tone1: step(0, tintA),
        tone2: step(1, tintB),
        tone3: step(2, tintA),
        tone4: step(3),
    };
};

export const resolveTemperaPalette = (
    theme: Theme,
    tuning: Pick<TemperaTuning, 'colorMode'>,
): TemperaPalette => {
    if (tuning.colorMode === 'mono') {
        const paper = toGray(theme.backgroundColor, '#111111');
        let ink = toGray(theme.primaryColor, '#f5f5f5');
        // Guarantee legible contrast even when the themed ink is a mid-gray.
        if (Math.abs(grayLevel(ink) - grayLevel(paper)) < 96) {
            ink = grayLevel(paper) < 128 ? '#f2f2f2' : '#141414';
        }
        return {
            paper,
            ink,
            blockA: mixColors(paper, ink, 0.08),
            blockB: mixColors(paper, ink, 0.18),
            blockC: mixColors(paper, ink, 0.34),
            accent: mixColors(paper, ink, 0.85),
            line: colorWithAlpha(mixColors(paper, ink, 0.55), 0.55),
            shadow: colorWithAlpha(mixColors(paper, ink, 0.75), 0.35),
            ...buildToneLadder(paper, ink),
        };
    }
    const paper = theme.backgroundColor;
    const ink = theme.primaryColor;
    return {
        paper,
        ink,
        blockA: mixColors(paper, theme.accentColor, 0.55),
        blockB: mixColors(paper, theme.secondaryColor, 0.6),
        blockC: mixColors(paper, theme.primaryColor, 0.78),
        accent: theme.accentColor,
        line: colorWithAlpha(mixColors(paper, ink, 0.6), 0.5),
        shadow: colorWithAlpha(mixColors(paper, ink, 0.8), 0.32),
        // duo keeps the same brightness ladder but tints the mid steps with the theme hues,
        // so a screentone composition reads identically in both color modes.
        ...buildToneLadder(paper, ink, theme.accentColor, theme.secondaryColor),
    };
};
