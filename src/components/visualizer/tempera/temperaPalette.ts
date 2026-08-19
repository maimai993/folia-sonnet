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
}

// Collapses a color to its Rec.709 luminance so mono blocks stay a true grayscale ladder.
const toGray = (color: string, fallback: string) => {
    const channels = parseColorChannels(color);
    if (!channels) return fallback;
    const luminance = Math.round(channels.r * 0.2126 + channels.g * 0.7152 + channels.b * 0.0722);
    return `rgb(${luminance}, ${luminance}, ${luminance})`;
};

const grayLevel = (color: string) => parseColorChannels(color)?.r ?? 128;

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
    };
};
