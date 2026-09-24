import type { Line, Theme } from '@/types';
import { getLineRenderEndTime } from '@/utils/lyrics/renderHints';
import { segmentLyricWords } from '@/utils/lyrics/wordSegmentation';
import { resolveThemeFontStack, resolveThemeFontWeight, resolveThemeTranslationFontStack } from '@/utils/fontStacks';
import { getRecentCompletedLine, getUpcomingLine, getUpcomingLines } from '@/components/visualizer/runtime';
import { buildWordColorRanges, resolveWordColor } from '@/components/visualizer/wordColoring';
import type { FoliumLine, FoliumLyricsHelpers, FoliumThemeHelpers } from './contract';

// src/mods/folium/sharedHelpers.ts
// `folium.lyrics` and `folium.theme`: the pure helpers builtin visualizers
// share, handed to mods so they lay out, time and color lyrics the same way.
// FoliumLine / FoliumTheme mirror the host Line / Theme, so every helper here
// is the host function itself behind a type boundary, not a second copy.
// Nothing here holds state, and both the main and the export window get it.

// FoliumLine carries every Line field the helpers read, under the same names.
const asLines = (lines: readonly FoliumLine[]) => lines as unknown as Line[];

const lyricsHelpers: FoliumLyricsHelpers = {
    getLineRenderEndTime: (line) => getLineRenderEndTime(line),
    segmentWords: (line) => segmentLyricWords({ fullText: line.fullText, wordSegments: line.wordSegments }),
    getRecentCompletedLine: (lines, lineIndex, time) => (
        getRecentCompletedLine({
            lines: asLines(lines),
            currentLineIndex: lineIndex,
            currentTime: time,
            getLineEndTime: getLineRenderEndTime,
        }) as unknown as FoliumLine | null
    ),
    getUpcomingLine: (lines, lineIndex, time) => getUpcomingLine(asLines(lines), lineIndex, time) as unknown as FoliumLine | null,
    getUpcomingLines: (lines, lineIndex, count) => getUpcomingLines(asLines(lines), lineIndex, count) as unknown as FoliumLine[],
    buildWordColorRanges: (fullText, wordColors) => buildWordColorRanges(fullText, wordColors),
    resolveWordColor: (wordText, wordColors, fallbackColor, options) => (
        resolveWordColor(wordText, wordColors, fallbackColor, { cjkMatchMode: options?.cjkMatchMode })
    ),
};

export const FOLIUM_LYRICS_HELPERS: FoliumLyricsHelpers = Object.freeze(lyricsHelpers);

const themeHelpers: FoliumThemeHelpers = {
    resolveFontStack: (theme) => resolveThemeFontStack(theme as Pick<Theme, 'fontStyle' | 'fontFamily' | 'fontFamilyStack'>),
    resolveTranslationFontStack: (theme) => (
        resolveThemeTranslationFontStack(theme as Pick<Theme, 'fontStyle' | 'fontFamily' | 'fontFamilyStack'>)
    ),
    resolveFontWeight: (theme, fallback) => resolveThemeFontWeight(theme, fallback),
};

export const FOLIUM_THEME_HELPERS: FoliumThemeHelpers = Object.freeze(themeHelpers);
