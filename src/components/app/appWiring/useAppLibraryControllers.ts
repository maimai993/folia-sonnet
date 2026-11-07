import type { AppFoundation } from './useAppFoundation';
import type { AppAudioOutput } from './useAppAudioOutput';
import type { AppThemeAndNavigation } from './useAppThemeAndNavigation';
import type { AppAccountsAndStage } from './useAppAccountsAndStage';
import { useLocalLibraryCatalog } from '../../../hooks/useLocalLibraryCatalog';
import { usePlayingSongLocatorStore } from '../../../stores/usePlayingSongLocatorStore';
import { createLyricFilterPatternSaver } from '../home/createLyricFilterPatternSaver';
import { type GridViewCollectionDescriptor } from '../home/gridViewCollectionAdapters';
import { createPanelNavigation } from '../navigation/createPanelNavigation';
import { useElectronWindowPlaybackHandoff } from '../playback/restore/useElectronWindowPlaybackHandoff';
import { useSessionRestoreController } from '../playback/restore/useSessionRestoreController';
import { useLibraryPlaybackController } from '../playback/start/useLibraryPlaybackController';
import { createQueueMutations } from '../player-panel/createQueueMutations';
import { useEffect, useCallback, useMemo } from 'react';

// src/components/app/appWiring/useAppLibraryControllers.ts
// 本地曲库与播放控制器：窗口播放交接、本地歌播放、会话恢复、歌词过滤保存、队列改动。

type Input = AppFoundation & AppAudioOutput & AppThemeAndNavigation & AppAccountsAndStage;

export const useAppLibraryControllers = (model: Input) => {
    const {
        audioQuality, audioRef, blobUrlRef, clearPersistedStagePlaybackCache, currentOnlineAudioUrlFetchedAtRef,
        currentSong, getNowPlayingDisplayTime, handleSetLyricLineRules,
        handleSetLyricStaffAbsorbMode, handleSetLyricStaffMinDwellSeconds, handleSetLyricStaffPattern,
        handleSetLyricStaffPolicy, handleToggleTransparentPlayerBackground, interruptStagePlaybackForMainTransition,
        isElectronWindow, lastAudioRecoverySourceRef, lyricsLoadingWritesRef,
        mainPlaybackSnapshotRef, navigateDirectHome, navigateToCollection, navigateToHome, navigateToPlaybackView,
        navigateToPlayer, nowPlayingLyricPayload, nowPlayingPaused, nowPlayingProgressMs, nowPlayingProgressQuality,
        nowPlayingTrack, pendingResumeTimeRef, persistLastPlaybackCache, playQueue, pushCollection, queueAddBehavior,
        restoreCachedThemeForSong, restoreStagePlaybackHandoff, setIsLyricsLoading, setLyrics, setLyricsStable,
        shouldAutoPlay, stageLyricsClockRef, stageSource, stageStatus, t, user
    } = model;
    const {
        restoreStatus: windowPlaybackHandoffRestoreStatus,
        toggleTransparentModeWithHandoff,
    } = useElectronWindowPlaybackHandoff({
        isElectronWindow,
        userId: user?.id,
        navigateToPlayer,
        audioRef,
        mainPlaybackSnapshotRef,
        stageStatus,
        stageSource,
        stageLyricsClockRef,
        nowPlayingTrack,
        nowPlayingLyricPayload,
        nowPlayingPaused,
        nowPlayingProgressMs,
        nowPlayingProgressQuality,
        getNowPlayingDisplayTime,
        restoreStagePlaybackHandoff,
        setLyrics,
        setIsLyricsLoading,
        blobUrlRef,
        shouldAutoPlayRef: shouldAutoPlay,
        pendingResumeTimeRef,
        lastAudioRecoverySourceRef,
        currentOnlineAudioUrlFetchedAtRef,
        applyTransparentPlayerBackground: handleToggleTransparentPlayerBackground,
        restoreCachedThemeForSong,
        persistLastPlaybackCache,
    });

    const { handleDirectHomeFromPanel } = useMemo(
        () => createPanelNavigation(navigateDirectHome),
        [navigateDirectHome],
    );
    // "Locate the playing song" moves between screens with the app's own navigation.
    useEffect(() => {
        usePlayingSongLocatorStore.getState().setNavigator({ navigateToHome, navigateToCollection, pushCollection });
        return () => usePlayingSongLocatorStore.getState().setNavigator(null);
    }, [navigateToCollection, navigateToHome, pushCollection]);

    // --- Local Music Functions ---

    const {
        localSongs,
        localPlaylists,
        isLyricMatchOpen,
        openLyricMatch,
        closeLyricMatch,
        loadLocalSongs,
        loadLocalPlaylists,
        onRefreshLocalSongs,
        isLocalSongLiked,
        saveCurrentQueueAsLocalPlaylist,
        addPickedSongsToLocalPlaylist,
        createLocalPlaylistWithSongs,
        addPickedSongsToOnlinePlaylist,
        createOnlinePlaylistWithSongs,
        addPickedSongsToNavidromePlaylist,
        createNavidromePlaylistWithSongs,
        loadCurrentSongLyricPreview,
        handleLocalQueueAdd,
        onPlayLocalSong,
        onPlayNavidromeSong,
        handleUpdateLocalLyrics,
        handleChangeLyricsSource,
        handleImportOnlineLyrics,
        handleChangeOnlineLyricsSource,
        handleLyricMatchComplete,
        handleLyricMatchPureMusicMarkChanged,
        handleToggleCurrentSongPureMusicMark,
        handleNaviLyricMatchComplete,
        handleOnlineLyricMatchComplete,
        handleClearOnlineLyricsState,
        handleAutoMatchBestLyricForCurrentSong,
        handleLike,
    } = useLibraryPlaybackController({
        userId: user?.id,
        setLyrics,
        setIsLyricsLoading,
        lyricsLoadingWritesRef,
        navigateToPlaybackView,
        persistLastPlaybackCache,
        restoreCachedThemeForSong,
        interruptStagePlaybackForMainTransition,
        blobUrlRef,
        shouldAutoPlayRef: shouldAutoPlay,
        currentOnlineAudioUrlFetchedAtRef,
        pendingResumeTimeRef,
        lastAudioRecoverySourceRef,
    });

    useSessionRestoreController({
        userId: user?.id,
        blobUrlRef,
        currentOnlineAudioUrlFetchedAtRef,
        setLyrics,
        restoreCachedThemeForSong,
        persistLastPlaybackCache,
        clearPersistedStagePlaybackCache,
        loadLocalSongs,
        loadLocalPlaylists,
        canRestoreSession: windowPlaybackHandoffRestoreStatus === 'none',
        shouldAutoPlayRef: shouldAutoPlay,
        // 「上次听到哪儿」：恢复出来的这一首从那个位置起播（dev 原语义）。
        pendingResumeTimeRef,
        // 「进入应用后自动播放」下面那一项：同一个开关组，起播的同时切到歌词页。
        jumpToPlayerOnLaunch: navigateToPlayer,
    });

    const localLibraryCatalog = useLocalLibraryCatalog(localSongs);
    const openHomeCollection = useCallback(
        (collection: GridViewCollectionDescriptor) => navigateToCollection(collection, 'home'),
        [navigateToCollection],
    );
    const handleSaveLyricFilterPattern = useMemo(() => createLyricFilterPatternSaver({
        handleSetLyricLineRules,
        handleSetLyricStaffPolicy,
        handleSetLyricStaffMinDwellSeconds,
        handleSetLyricStaffAbsorbMode,
        handleSetLyricStaffPattern,
        loadCurrentSongLyricPreview,
        setLyrics: setLyricsStable,
    }), [
        handleSetLyricLineRules,
        handleSetLyricStaffPolicy,
        handleSetLyricStaffMinDwellSeconds,
        handleSetLyricStaffPattern,
        loadCurrentSongLyricPreview,
        setLyricsStable,
    ]);

    // setQueueOrder：速记簿「播放队列」页的拖动重排走这里（上游 v0.7.26 接进 ScratchpadHost）。
    const { addNavidromeSongsToQueue, applyQueueBatchOperation, removeQueueSong, moveQueueSongToEnd, moveQueueSongToNext, moveQueueSong, setQueueOrder } = useMemo(() => createQueueMutations({
        currentSong,
        playQueue,
        persistLastPlaybackCache,
        t,
        queueAddBehavior,
        audioQuality,
        userId: user?.id,
    }), [currentSong, playQueue, persistLastPlaybackCache, t, queueAddBehavior, audioQuality, user?.id]);

    return {
        ...model,
        addNavidromeSongsToQueue, addPickedSongsToLocalPlaylist, addPickedSongsToNavidromePlaylist,
        addPickedSongsToOnlinePlaylist, applyQueueBatchOperation, closeLyricMatch,
        createLocalPlaylistWithSongs, createNavidromePlaylistWithSongs, createOnlinePlaylistWithSongs,
        handleAutoMatchBestLyricForCurrentSong,
        handleChangeLyricsSource, handleChangeOnlineLyricsSource, handleClearOnlineLyricsState,
        handleDirectHomeFromPanel, handleImportOnlineLyrics, handleLike, handleLocalQueueAdd,
        handleLyricMatchComplete, handleLyricMatchPureMusicMarkChanged, handleNaviLyricMatchComplete,
        handleOnlineLyricMatchComplete, handleSaveLyricFilterPattern, handleToggleCurrentSongPureMusicMark,
        handleUpdateLocalLyrics, isLocalSongLiked, isLyricMatchOpen, loadCurrentSongLyricPreview, loadLocalPlaylists,
        loadLocalSongs, localLibraryCatalog, localPlaylists, localSongs, moveQueueSong, moveQueueSongToEnd,
        moveQueueSongToNext, onPlayLocalSong, onPlayNavidromeSong, onRefreshLocalSongs, openHomeCollection,
        openLyricMatch, removeQueueSong, saveCurrentQueueAsLocalPlaylist, setQueueOrder, toggleTransparentModeWithHandoff
    };
};

export type AppLibraryControllers = ReturnType<typeof useAppLibraryControllers>;
