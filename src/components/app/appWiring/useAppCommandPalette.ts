import type { AppFoundation } from './useAppFoundation';
import type { AppAudioOutput } from './useAppAudioOutput';
import type { AppThemeAndNavigation } from './useAppThemeAndNavigation';
import type { AppAccountsAndStage } from './useAppAccountsAndStage';
import type { AppLibraryControllers } from './useAppLibraryControllers';
import type { AppPlaybackQueue } from './useAppPlaybackQueue';
import type { AppPlaybackBridges } from './useAppPlaybackBridges';
import type { AppChromeAndGestures } from './useAppChromeAndGestures';
import type { AppPublishers } from './useAppPublishers';
import { useCommandPaletteContext } from '../../../hooks/useCommandPaletteContext';
import { useIcuFoliaSegmentation } from '../../../hooks/useIcuFoliaSegmentation';
import { useLyricWordSegmentation } from '../../../hooks/useLyricWordSegmentation';
import { useSongThemeAutoGeneration } from '../../../hooks/useSongThemeAutoGeneration';
import { BASE_DUAL_THEME } from '../../../services/baseThemes';
import { FALLBACK_AI_DUAL_THEME } from '../../../services/themeSanitizer';
import { currentTime } from '../../../stores/motionSignals';
import { nextLyricStaffAbsorbMode, nextLyricStaffPolicy } from '../../../utils/lyrics/staffCreditsPolicy';
import { runsOnWindows } from '../../../utils/platform';
import { resolveSongLiked } from '../../../utils/resolveSongLiked';
import { PERSONAL_FM_MODE_COMMAND_ID } from '../../command-palette/commands/fmModeCommand';
import { useCommandPalette } from '../../command-palette/useCommandPalette';
import { buildDebugSnapshot } from '../presentation/buildDebugSnapshot';
import { useRef, useMemo } from 'react';

// src/components/app/appWiring/useAppCommandPalette.ts
// 命令面板与调试快照：面板上下文与控制器、调试面板数据、歌曲主题自动生成、分词器装载。

const DEV_DEBUG_SHORTCUT_LABEL = 'Alt+Shift+D';

type Input =
    & AppFoundation
    & AppAudioOutput
    & AppThemeAndNavigation
    & AppAccountsAndStage
    & AppLibraryControllers
    & AppPlaybackQueue
    & AppPlaybackBridges
    & AppChromeAndGestures
    & AppPublishers;

export const useAppCommandPalette = (model: Input) => {
    const {
        aiTheme, applyQueueBatchOperation, audioSrc, bgMode, canGenerateAITheme, canUseTransitionPerformance,
        clearQueue, coverUrl, currentSearchSourceTabInPalette, currentSong, currentView, customTheme,
        devDebugCurrentLineIndex, displaySong, generateAITheme, generateCurrentSongTheme, getThemeParkSeedTheme,
        handleAutoMatchBestLyricForCurrentSong, handleChangeReplayGainMode, handleLike, handleNextTrack,
        handlePrevTrack, handlePreviewVolume, handleSaveLyricFilterPattern, handleThemeGenerationSourceChange,
        handleToggleCurrentSongPureMusicMark, isDev, isDevDebugOverlayVisible, isElectronWindow, isGeneratingTheme,
        isLocalSongLiked, isLyricMatchOpen, isLyricsLoading, isNowPlayingStageActive, isPersonalFmModeSupported,
        isSearchOpen, isSettingsModalOpen, localLibraryCatalog, localSongs, lyricLineRules,
        lyricSegmentationActions, lyricStaffAbsorbMode, lyricStaffMinDwellSeconds,
        lyricStaffPattern, lyricStaffPolicy, lyrics, moveQueueSongToEnd, moveQueueSongToNext, navigateToHome,
        navigateToLattice, navigateToPlayer, navigateToSearch, nowPlayingConnectionStatus, nowPlayingDebugInfo,
        nowPlayingLyricPayload, nowPlayingPaused, nowPlayingProgressMs, nowPlayingProgressQuality, nowPlayingTrack,
        pendingUnavailableReplacement, playSong, playerState, removeQueueSong, setPersonalFmSelection, shuffleQueue,
        songThemeAutoGenerateEnabled, songThemeAutoSwitchEnabled, stageSource, starredNavidromeSongIds,
        themeGenerationSource, toggleBrowserFullscreen, toggleDaylightMode, toggleLoop, toggleMainWindowAlwaysOnTop,
        togglePlay, toggleRemoteControlWindow, toggleTransparentModeWithHandoff, transparentPlayerBackground,
        visualizerMode
    } = model;
    const commandPaletteContext = useCommandPaletteContext({

        currentSearchSourceTab: currentSearchSourceTabInPalette,
        localSongs,
        localLibraryCatalog,
        navigateToSearch,

        previewVolume: handlePreviewVolume,
        togglePlay,
        toggleLoop,
        next: handleNextTrack,
        prev: handlePrevTrack,
        playSong,
        shuffleQueue,
        clearQueue,
        applyQueueBatchOperation,
        removeQueueSong,
        moveQueueSongToNext,
        moveQueueSongToEnd,
        setReplayGainMode: handleChangeReplayGainMode,
        isPersonalFmModeSupported,
        setPersonalFmSelection,
        runAutoMatchBestLyric: handleAutoMatchBestLyricForCurrentSong,
        toggleCurrentSongPureMusicMark: handleToggleCurrentSongPureMusicMark,
        toggleSongLike: handleLike,
        isSongLiked: resolveSongLiked(displaySong, { isLocalSongLiked, starredNavidromeSongIds }),

        navigateToHome,
        navigateToPlayer,
        navigateToLattice,
        toggleBrowserFullscreen,
        toggleRemoteControlWindow,
        toggleMainWindowAlwaysOnTop,


        toggleTransparentBackground: () => { void toggleTransparentModeWithHandoff(!transparentPlayerBackground); },
        toggleDaylightMode,
        cycleLyricStaffPolicy: () => handleSaveLyricFilterPattern({
            rules: lyricLineRules,
            staffPolicy: nextLyricStaffPolicy(lyricStaffPolicy),
            staffMinDwellSeconds: lyricStaffMinDwellSeconds,
            staffAbsorbMode: lyricStaffAbsorbMode,
            staffPattern: lyricStaffPattern,
        }),
        cycleLyricStaffAbsorbMode: () => handleSaveLyricFilterPattern({
            rules: lyricLineRules,
            staffPolicy: lyricStaffPolicy,
            staffMinDwellSeconds: lyricStaffMinDwellSeconds,
            staffAbsorbMode: nextLyricStaffAbsorbMode(lyricStaffAbsorbMode),
            staffPattern: lyricStaffPattern,
        }),
        canGenerateAITheme,
        isGeneratingTheme,
        generateAITheme: generateCurrentSongTheme,
        themeGenerationSource,
        setThemeGenerationSource: handleThemeGenerationSourceChange,
        voiceInputPauseSupported: isElectronWindow && runsOnWindows(),
        canUseTransitionPerformance,
    }, lyricSegmentationActions);
    const commandPalette = useCommandPalette({
        isBlocked: isSettingsModalOpen
            || (currentView === 'home' && isSearchOpen)
            || isLyricMatchOpen
            || Boolean(pendingUnavailableReplacement),
        context: commandPaletteContext,
    });
    // The FM tab reuses the palette's picker instead of carrying its own copy of the mode list.
    // Read through a ref rather than depended on: openCommandById tracks the palette's isExecuting
    // flag, so depending on it would rebuild the player panel model on unrelated renders. The
    // picker only ever runs from a click, so the latest one is the right one.
    const openCommandByIdRef = useRef(commandPalette.openCommandById);
    openCommandByIdRef.current = commandPalette.openCommandById;
    const handleOpenFmModePicker = useMemo(() => (
        isPersonalFmModeSupported ? () => openCommandByIdRef.current(PERSONAL_FM_MODE_COMMAND_ID) : undefined
    ), [isPersonalFmModeSupported]);
    const nowPlayingDebugSnapshot = useMemo(() => (
        stageSource === 'now-playing'
            ? {
                connectionStatus: nowPlayingConnectionStatus,
                isActive: isNowPlayingStageActive,
                paused: nowPlayingPaused,
                progressMs: nowPlayingProgressMs,
                progressQuality: nowPlayingProgressQuality,
                trackTitle: nowPlayingTrack?.title ?? nowPlayingLyricPayload?.title ?? null,
                durationSec: (nowPlayingTrack?.durationMs ?? nowPlayingLyricPayload?.durationMs ?? 0) / 1000,
                ...nowPlayingDebugInfo,
            }
            : null
    ), [
        isNowPlayingStageActive,
        nowPlayingConnectionStatus,
        nowPlayingDebugInfo,
        nowPlayingLyricPayload?.durationMs,
        nowPlayingLyricPayload?.title,
        nowPlayingPaused,
        nowPlayingProgressMs,
        nowPlayingProgressQuality,
        nowPlayingTrack?.durationMs,
        nowPlayingTrack?.title,
        stageSource,
    ]);
    const activeDualTheme = useMemo(() => {
        if (bgMode === 'custom' && customTheme) {
            return customTheme;
        }
        if (bgMode === 'ai') {
            return aiTheme ?? FALLBACK_AI_DUAL_THEME;
        }
        return BASE_DUAL_THEME;
    }, [bgMode, customTheme, aiTheme]);

    // Built while the overlay is open even outside dev, because the packaged desktop build has no
    // console of its own and this overlay is the only way to read one. Still gated rather than
    // unconditional: nothing here is worth computing on every render of a session nobody is
    // debugging.
    const devDebugSnapshot = useMemo(() => (
        isDev || isDevDebugOverlayVisible
            ? buildDebugSnapshot({
                shortcutLabel: DEV_DEBUG_SHORTCUT_LABEL,
                currentSong,
                currentView,
                playerState,
                visualizerMode,
                lyrics: lyrics,
                currentLineIndex: devDebugCurrentLineIndex,
                currentTimeValue: currentTime.get(),
                audioSrc,
                coverUrl,
                nowPlayingDebug: nowPlayingDebugSnapshot,
                themeMode: bgMode,
                activeDualTheme,
            })
            : null
    ), [
        audioSrc,
        coverUrl,
        devDebugCurrentLineIndex,
        currentSong,
        currentTime,
        currentView,
        isDev,
        isDevDebugOverlayVisible,
        nowPlayingDebugSnapshot,
        playerState,
        lyrics,
        visualizerMode,
        bgMode,
        activeDualTheme,
    ]);
    const themeParkSeedTheme = useMemo(() => getThemeParkSeedTheme(), [getThemeParkSeedTheme]);
    useSongThemeAutoGeneration({
        enabled: songThemeAutoSwitchEnabled && songThemeAutoGenerateEnabled,
        isLyricsLoading,
        themeGenerationSource,
        generateAITheme,
    });
    // Loads the playing song's saved word segmentation into the store the lyric setter reads.
    useLyricWordSegmentation();
    // Loads icu-folia, the default word segmenter, once a word-based mode shows Chinese or Japanese.
    useIcuFoliaSegmentation(visualizerMode);

    return {
        ...model,
        commandPalette, commandPaletteContext, devDebugSnapshot, handleOpenFmModePicker, themeParkSeedTheme
    };
};

export type AppCommandPalette = ReturnType<typeof useAppCommandPalette>;
