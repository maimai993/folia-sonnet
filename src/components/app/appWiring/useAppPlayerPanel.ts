import type { AppFoundation } from './useAppFoundation';
import type { AppAudioOutput } from './useAppAudioOutput';
import type { AppThemeAndNavigation } from './useAppThemeAndNavigation';
import type { AppAccountsAndStage } from './useAppAccountsAndStage';
import type { AppLibraryControllers } from './useAppLibraryControllers';
import type { AppPlaybackQueue } from './useAppPlaybackQueue';
import type { AppPlaybackBridges } from './useAppPlaybackBridges';
import type { AppChromeAndGestures } from './useAppChromeAndGestures';
import type { AppPublishers } from './useAppPublishers';
import type { AppCommandPalette } from './useAppCommandPalette';
import type { AppPlaybackActions } from './useAppPlaybackActions';
import type { AppWallAndHome } from './useAppWallAndHome';
import { omni } from '../../../services/onlineMusic/omni';
import { applyLocalLibraryEntityDisplay } from '../../../services/playbackAdapters';
import { UnifiedSong } from '../../../types';
import { buildLocalLibraryIndex } from '../../../utils/localLibraryIndex';
import { usePlayerPanelModel } from '../player-panel/usePlayerPanelModel';
import { useCallback, useMemo } from 'react';

// src/components/app/appWiring/useAppPlayerPanel.ts
// 播放器面板：展示用曲库索引、当前曲目与队列的展示态、面板模型。

type Input =
    & AppFoundation
    & AppAudioOutput
    & AppThemeAndNavigation
    & AppAccountsAndStage
    & AppLibraryControllers
    & AppPlaybackQueue
    & AppPlaybackBridges
    & AppChromeAndGestures
    & AppPublishers
    & AppCommandPalette
    & AppPlaybackActions
    & AppWallAndHome;

export const useAppPlayerPanel = (model: Input) => {
    const {
        accountController, canGenerateAITheme, commandPalette, displaySong, effectiveLoopMode,
        generateCurrentSongTheme, handleActiveProviderSyncData, handleBgModeChange, handleChangeLyricsSource,
        handleChangeOnlineLyricsSource, handleChangeReplayGainMode, handleClearOnlineLyricsState,
        handleDirectHomeFromPanel, handleFmTrash, handleImportOnlineLyrics, handleLike,
        handleLyricTimelineOffsetChange, handleNextTrack, handleOpenFmModePicker, handlePlayerPanelAlbumSelect,
        handlePlayerPanelArtistSelect, handlePrevTrack, handlePreviewVolume, handleResetTheme,
        handleUpdateLocalLyrics, hasCustomTheme, isGeneratingTheme, isLocalSongLiked, isNowPlayingControlDisabled,
        isProviderSyncing, localLibraryCatalog, localSongs, moveQueueSongToEnd, moveQueueSongToNext,
        navigateToCollection, navigateToHome, navigateToLattice, onlineProviders, openLyricMatch,
        personalFmSelectionLabel, playQueue, playSong, queueScrollRef, removeQueueSong,
        saveCurrentQueueAsLocalPlaylist, setTheme, shouldHidePlayerRightPanelButton, shuffleQueue, theme,
        themeSourceModel, toggleDaylightMode, toggleLoop, togglePlay, toggleTransparentModeWithHandoff,
        rematchCurrentSongMv, isRematchingMv
    } = model;
    const playerDisplayCatalogIndex = useMemo(() => buildLocalLibraryIndex(
        localLibraryCatalog.entities,
        localLibraryCatalog.assignments,
    ), [localLibraryCatalog.assignments, localLibraryCatalog.entities]);
    const playerDisplayCurrentSong = useMemo(() => (
        displaySong
            ? applyLocalLibraryEntityDisplay(displaySong, localLibraryCatalog, playerDisplayCatalogIndex)
            : null
    ), [displaySong, localLibraryCatalog, playerDisplayCatalogIndex]);
    const playerDisplayQueue = useMemo(() => (
        playQueue.map(song => applyLocalLibraryEntityDisplay(song, localLibraryCatalog, playerDisplayCatalogIndex))
    ), [localLibraryCatalog, playQueue, playerDisplayCatalogIndex]);
    // 搜索结果同样在展示时按当前目录重算：结果是提交那一刻的快照，导入后紧接着搜，实体目录可能还没加载完。
    const resolveSearchResultDisplay = useCallback((track: UnifiedSong) => (
        track.isLocal
            ? applyLocalLibraryEntityDisplay(track, localLibraryCatalog, playerDisplayCatalogIndex)
            : track
    ), [localLibraryCatalog, playerDisplayCatalogIndex]);
    const onlinePlaylists = useMemo(() => {
        return playerDisplayCurrentSong ? omni.getPlaylistsForSong(playerDisplayCurrentSong) : [];
    }, [onlineProviders, playerDisplayCurrentSong]);

    const playerPanelModel = usePlayerPanelModel({
        navigateToHome,
        navigateToLattice,
        handleDirectHomeFromPanel,
        currentSong: playerDisplayCurrentSong,
        handleAlbumSelect: handlePlayerPanelAlbumSelect,
        handleArtistSelect: handlePlayerPanelArtistSelect,
        effectiveLoopMode,
        toggleLoop,
        handleLike,
        generateAITheme: generateCurrentSongTheme,
        isGeneratingTheme,
        canGenerateAITheme,
        rematchMv: rematchCurrentSongMv,
        isRematchingMv,
        theme,
        setTheme,
        handleBgModeChange,
        hasCustomTheme,
        themeSourceModel,
        handleResetTheme,
        toggleTransparentModeWithHandoff,
        handleManualMatchOnline: openLyricMatch,
        handleUpdateLocalLyrics,
        handleChangeLyricsSource,
        handleImportOnlineLyrics,
        handleChangeOnlineLyricsSource,
        handleMatchOnlineLyrics: openLyricMatch,
        handleClearOnlineLyricsState,
        handleLyricTimelineOffsetChange,
        handleChangeReplayGainMode,
        fmModeLabel: personalFmSelectionLabel,
        handleOpenFmModePicker,
        handleFmTrash,
        handleNextTrack,
        handlePrevTrack,
        togglePlay,
        handlePreviewVolume,
        isNowPlayingControlDisabled,
        openCommandPalette: commandPalette.open,
        isCommandPaletteOpen: commandPalette.isOpen,
        playQueue: playerDisplayQueue,
        playSong,
        queueScrollRef,
        shuffleQueue,
        removeQueueSong,
        moveQueueSongToEnd,
        moveQueueSongToNext,
        saveCurrentQueueAsLocalPlaylist,
        accountController,
        handleSyncData: handleActiveProviderSyncData,
        isSyncing: isProviderSyncing,
        handleToggleDaylight: toggleDaylightMode,
        // Derived inside the hook, but these are the sources only App.tsx holds.
        isLocalSongLiked,
        shouldHidePlayerRightPanelButton,
        localSongs,
        localLibraryCatalog,
        navigateToCollection,
    });

    return {
        ...model,
        onlinePlaylists, playerPanelModel, resolveSearchResultDisplay
    };
};

export type AppPlayerPanel = ReturnType<typeof useAppPlayerPanel>;
