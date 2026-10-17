import { useEffect, useRef, useState } from 'react';
import type { GenerateAIThemeOptions, GenerateAIThemeResult } from './useThemeController';
import type { LyricData, SongResult } from '../types';
import type { ThemeGenerationSource } from '../services/themePreferences';
import { getSongThemeAutoGenerationKey, isSongThemeGenerationStillCurrent, shouldRequestSongThemeAutoGeneration } from '../utils/songThemeAutoGeneration';
import { usePlaybackStore } from '../stores/usePlaybackStore';
import { isPlaybackInterfaceHidden } from '../services/playbackRecovery/backgroundFailureNotice';

// src/hooks/useSongThemeAutoGeneration.ts
// Each input epoch owns its application permission; cached results are managed by requestStage.
type GenerateAITheme = (
    lyrics: LyricData | null,
    currentSong: SongResult | null,
    options?: GenerateAIThemeOptions,
) => Promise<GenerateAIThemeResult>;

type UseSongThemeAutoGenerationParams = {
    enabled: boolean;
    isLyricsLoading: boolean;
    themeGenerationSource: ThemeGenerationSource;
    generateAITheme: GenerateAITheme;
};
const AUTO_GENERATE_DELAY_MS = 650;

export function useSongThemeAutoGeneration({
    enabled, isLyricsLoading, themeGenerationSource, generateAITheme,
}: UseSongThemeAutoGenerationParams) {
    const currentSong = usePlaybackStore(state => state.currentSong);
    const lyrics = usePlaybackStore(state => state.lyrics);
    const epochRef = useRef(0);
    const [inputRevision, setInputRevision] = useState(0);
    const generateRef = useRef(generateAITheme);
    generateRef.current = generateAITheme;

    useEffect(() => {
        const epoch = ++epochRef.current;
        const controller = new AbortController();
        // Store subscriptions revoke permission synchronously, including batched A -> B -> A.
        const offPlayback = usePlaybackStore.subscribe((state, previous) => {
            if (state.currentSong !== previous.currentSong || state.lyrics !== previous.lyrics) {
                epochRef.current += 1;
                controller.abort();
                // Song/lyric replacements are discrete, including batched return-to-A transitions.
                setInputRevision(value => value + 1);
            }
        });
        const shouldApply = () => isSongThemeGenerationStillCurrent({
            latestSongKey: getSongThemeAutoGenerationKey(usePlaybackStore.getState().currentSong),
            targetSongKey: getSongThemeAutoGenerationKey(currentSong) ?? '', enabled, latestEpoch: epochRef.current,
            targetEpoch: epoch, signal: controller.signal,
        }) && usePlaybackStore.getState().lyrics === lyrics;
        const attempt = async () => {
            if (!shouldApply() || !currentSong || !shouldRequestSongThemeAutoGeneration({
                enabled, currentSong, lyrics, isLyricsLoading, hasCachedTheme: false,
                requiresPromptSource: themeGenerationSource !== 'cover',
            })) return;
            try {
                await generateRef.current(lyrics, currentSong, {
                    source: 'auto', signal: controller.signal, shouldApply,
                });
            } catch {
                // The controller owns user-visible failures; cancelled consumers stay silent.
            }
        };
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        if (isPlaybackInterfaceHidden()) void attempt();
        else timeoutId = setTimeout(() => void attempt(), AUTO_GENERATE_DELAY_MS);
        return () => {
            epochRef.current += 1;
            controller.abort();
            offPlayback();
            if (timeoutId !== null) clearTimeout(timeoutId);
        };
    }, [enabled, isLyricsLoading, themeGenerationSource, currentSong, lyrics, inputRevision]);
}
