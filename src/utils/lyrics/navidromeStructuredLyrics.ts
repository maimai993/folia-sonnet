import type { LyricData, Line, Word } from '../../types';
import type { StructuredLyric, StructuredLyricCueLine } from '../../types/navidrome';
import { finalizeParsedLyricLines } from './parserCore';
import type { LyricProcessingOptions } from './types';

// Converts OpenSubsonic songLyrics v2 cue timing into Folia's native lyric timeline.
const pickMainCueLines = (lyrics: StructuredLyric): StructuredLyricCueLine[] => {
    const mainAgentIds = new Set(
        lyrics.agents?.filter(agent => agent.role === 'main').map(agent => agent.id) ?? []
    );
    const byIndex = new Map<number, StructuredLyricCueLine>();

    for (const cueLine of lyrics.cueLine ?? []) {
        const existing = byIndex.get(cueLine.index);
        if (!existing || (cueLine.agentId && mainAgentIds.has(cueLine.agentId) && !mainAgentIds.has(existing.agentId ?? ''))) {
            byIndex.set(cueLine.index, cueLine);
        }
    }

    return [...byIndex.values()].sort((left, right) => (
        left.index - right.index || (left.start ?? 0) - (right.start ?? 0)
    ));
};

const finiteTime = (value: number | undefined): number | undefined => (
    typeof value === 'number' && Number.isFinite(value) ? value / 1000 : undefined
);

export const parseNavidromeStructuredLyrics = (
    lyrics: StructuredLyric,
    options: LyricProcessingOptions = {}
): LyricData | null => {
    const cueLines = pickMainCueLines(lyrics).filter(cueLine => cueLine.cue?.some(cue => finiteTime(cue.start) !== undefined));
    if (cueLines.length === 0) {
        return null;
    }

    const lines: Line[] = cueLines.map((cueLine, lineIndex) => {
        const cues = cueLine.cue ?? [];
        const startTime = finiteTime(cueLine.start) ?? finiteTime(cues[0]?.start) ?? 0;
        const nextLineStart = finiteTime(cueLines[lineIndex + 1]?.start);
        const explicitEnd = finiteTime(cueLine.end);
        const fallbackLineEnd = explicitEnd ?? nextLineStart ?? (startTime + 5);
        const words: Word[] = cues.flatMap((cue, wordIndex) => {
            const wordStart = finiteTime(cue.start);
            if (wordStart === undefined) {
                return [];
            }

            const nextWordStart = finiteTime(cues[wordIndex + 1]?.start);
            const wordEnd = Math.max(
                finiteTime(cue.end) ?? nextWordStart ?? fallbackLineEnd,
                wordStart + 0.001
            );
            return [{ text: cue.value, startTime: wordStart, endTime: wordEnd }];
        });
        const endTime = Math.max(explicitEnd ?? words[words.length - 1]?.endTime ?? fallbackLineEnd, startTime + 0.001);

        return {
            words,
            startTime,
            endTime,
            fullText: cueLine.value || words.map(word => word.text).join(''),
        };
    });

    return {
        lines: finalizeParsedLyricLines(lines, options),
        title: lyrics.displayTitle,
        artist: lyrics.displayArtist,
    };
};
