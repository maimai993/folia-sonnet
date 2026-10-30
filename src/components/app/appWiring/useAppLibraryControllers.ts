import type { AppFoundation } from './useAppFoundation';
import type { AppAudioOutput } from './useAppAudioOutput';
import type { AppThemeAndNavigation } from './useAppThemeAndNavigation';
import type { AppAccountsAndStage } from './useAppAccountsAndStage';
import { useLocalLibraryCatalog } from '../../../hooks/useLocalLibraryCatalog';
import { usePlayingSongLocatorStore } from '../../../stores/usePlayingSongLocatorStore';
import { createLyricFilterPatternSaver } from '../home/createLyricFilterPatternSaver';
import { type GridViewCollectionDescriptor } from '../home/gridViewCollectionAdapters';
import { createPanelNavigation } from '../navigation/createPanelNavigation';
import { currentTime } from '../../../stores/motionSignals';
import { makeSongCurrent } from '../playback/currentSong';
import {
    setAudioSrc as setAudioSrcInStore,
    setDuration as setDurationInStore,
    setPlayerState as setPlayerStateInStore,
    setPlayQueue,
} from '../../../stores/usePlaybackStore';
import { nativePlaybackEngine } from '../../../services/playbackEngine/nativePlaybackEngine';
import { readNativeQueueState } from '../../../services/nativeQueueBridge';
import { songFromMirrorEntry } from '../../../utils/queueMirrorEntry';
import { getPlaybackSongKey } from '../../../utils/appPlaybackGuards';
import { useElectronWindowPlaybackHandoff } from '../playback/restore/useElectronWindowPlaybackHandoff';
import { useSessionRestoreController } from '../playback/restore/useSessionRestoreController';
import { useLibraryPlaybackController } from '../playback/start/useLibraryPlaybackController';
import { createQueueMutations } from '../player-panel/createQueueMutations';
import { useEffect, useCallback, useMemo } from 'react';
import type { SongResult } from '../../../types';
import { PlayerState } from '../../../types';

// src/components/app/appWiring/useAppLibraryControllers.ts
// 本地曲库与播放控制器：窗口播放交接、本地歌播放、会话恢复、歌词过滤保存、队列改动。

type Input = AppFoundation & AppAudioOutput & AppThemeAndNavigation & AppAccountsAndStage;

export const useAppLibraryControllers = (model: Input) => {
    const {
        audioQuality, audioRef, blobUrlRef, clearPersistedStagePlaybackCache, currentOnlineAudioUrlFetchedAtRef,
        currentSong, getNowPlayingDisplayTime, handleSetLyricFilterEnabled, handleSetLyricFilterPattern,
        handleSetLyricStaffAbsorbMode, handleSetLyricStaffMinDwellSeconds, handleSetLyricStaffPattern,
        handleSetLyricStaffPolicy, handleToggleTransparentPlayerBackground, interruptStagePlaybackForMainTransition,
        isElectronWindow, lastAudioRecoverySourceRef, lyricFilterEnabled, lyricFilterPattern, lyricsLoadingWritesRef,
        mainPlaybackSnapshotRef, nativeActive, nativeTakesRef, navigateDirectHome, navigateToCollection, navigateToHome, navigateToPlaybackView,
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
        addCurrentSongToLocalPlaylist,
        createCurrentLocalPlaylist,
        addCurrentSongToOnlinePlaylist,
        createCurrentOnlinePlaylist,
        addCurrentSongToNavidromePlaylist,
        createCurrentNavidromePlaylist,
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
        /*
         * native-first 恢复（issue #106）：原生手上真有歌时，会话恢复**认领原生**，
         * 不再从持久化缓存把旧歌 setAudioSrc 回去 —— 那会把原生正在放的歌重新
         * prepare 成缓存里那首，表现就是「打开 App 唤醒时自动切歌」。
         *
         * 认领与 onSyncToSong 的 UI-only 路径同语义：currentSong / 队列 / 位置 /
         * 播放状态全部以原生为准，audioSrc 不动（原生的源就是真源）。原生没歌
         * （web 全流程的歌、或已经停止）回 false，照旧走缓存恢复。
         */
        adoptNativePlayback: async () => {
            // 判据只看「原生插件可用」，**不看 audioSrc**：冷启动时 audioSrc 还是
            // null（nativeTakes 因此为 false），而这正是最需要 native-first 的那条
            // 路径 —— 用 nativeTakes 判断会让这里恒回 false，issue #106 修不掉。
            // 「原生手上真有歌」由下面的 hasSong + songKey 判断。
            if (!nativeActive) return false;
            const native = await readNativeQueueState();
            if (!native || !native.hasSong || !native.songKey) return false;
            // 冷启动时原生播放器正在放 = 原生真的在播（这里不问 web 的 store，
            // 它还没恢复完，正是要被对齐的一方）。
            // songKey 是原生的真源：镜像里找不到这条（镜像旧了）也照样认领，
            // currentSong 从队列条目建不出来时按快照的元数据先占位。
            const entry = native.entries.find((item) => item.songKey === native.songKey);
            const nativeQueue = native.entries.map((item) => songFromMirrorEntry(item));
            const song: SongResult = entry
                ? songFromMirrorEntry(entry)
                : ({
                    id: native.songKey,
                    name: native.title || native.songKey,
                    artists: native.artist ? [{ id: `${native.songKey}-a0`, name: native.artist }] : [],
                    album: { id: `${native.songKey}-al`, name: native.album || '' },
                    durationMs: native.durationMs,
                } as unknown as SongResult);
            const queue = nativeQueue.some((item) => getPlaybackSongKey(item) === getPlaybackSongKey(song))
                ? nativeQueue
                : [song, ...nativeQueue];
            setPlayQueue(queue);
            makeSongCurrent(song);
            /*
             * 把引擎那半边也对齐：冷启动时 JS 的引擎状态是空的，而原生一直在放。
             * `adoptSource` 只记账、不 prepare —— 之后装源 effect 看到地址相同会跳过，
             * 不会把原生正在放的歌从头再放（issue #106）。
             */
            const adoptedUrl = entry?.url?.trim();
            if (adoptedUrl && nativePlaybackEngine.supports(adoptedUrl)) {
                nativePlaybackEngine.adoptSource(adoptedUrl, {
                    positionMs: native.positionMs,
                    durationMs: native.durationMs,
                    playing: native.playing,
                });
                setAudioSrcInStore(adoptedUrl);
            }
            // 位置 0 是「原生刚 prepare 还没走」的正常值，不要用它把界面进度归零
            // （缓存的进度可能是有意义的），与 onSyncToSong 里同一写法。
            if (native.positionMs > 0) currentTime.set(native.positionMs / 1000);
            if (native.durationMs > 0) setDurationInStore(native.durationMs / 1000);
            setPlayerStateInStore(native.playing ? PlayerState.PLAYING : PlayerState.PAUSED);
            void persistLastPlaybackCache(song, queue);
            return true;
        },
        clearPersistedStagePlaybackCache,
        loadLocalSongs,
        loadLocalPlaylists,
        canRestoreSession: windowPlaybackHandoffRestoreStatus === 'none',
        shouldAutoPlayRef: shouldAutoPlay,
        // 「进入应用后自动播放」下面那一项：同一个开关组，起播的同时切到歌词页。
        jumpToPlayerOnLaunch: navigateToPlayer,
    });

    const localLibraryCatalog = useLocalLibraryCatalog(localSongs);
    const openHomeCollection = useCallback(
        (collection: GridViewCollectionDescriptor) => navigateToCollection(collection, 'home'),
        [navigateToCollection],
    );
    const handleSaveLyricFilterPattern = useMemo(() => createLyricFilterPatternSaver({
        currentEffectivePattern: lyricFilterEnabled ? lyricFilterPattern : '',
        handleSetLyricFilterPattern,
        handleSetLyricFilterEnabled,
        handleSetLyricStaffPolicy,
        handleSetLyricStaffMinDwellSeconds,
        handleSetLyricStaffAbsorbMode,
        handleSetLyricStaffPattern,
        loadCurrentSongLyricPreview,
        setLyrics: setLyricsStable,
    }), [
        lyricFilterPattern,
        lyricFilterEnabled,
        handleSetLyricFilterPattern,
        handleSetLyricFilterEnabled,
        handleSetLyricStaffPolicy,
        handleSetLyricStaffMinDwellSeconds,
        handleSetLyricStaffPattern,
        loadCurrentSongLyricPreview,
        setLyricsStable,
    ]);

    const { addNavidromeSongsToQueue, applyQueueBatchOperation, removeQueueSong, moveQueueSongToEnd, moveQueueSongToNext, moveQueueSong } = useMemo(() => createQueueMutations({
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
        addCurrentSongToLocalPlaylist, addCurrentSongToNavidromePlaylist, addCurrentSongToOnlinePlaylist,
        addNavidromeSongsToQueue, applyQueueBatchOperation, closeLyricMatch, createCurrentLocalPlaylist,
        createCurrentNavidromePlaylist, createCurrentOnlinePlaylist, handleAutoMatchBestLyricForCurrentSong,
        handleChangeLyricsSource, handleChangeOnlineLyricsSource, handleClearOnlineLyricsState,
        handleDirectHomeFromPanel, handleImportOnlineLyrics, handleLike, handleLocalQueueAdd,
        handleLyricMatchComplete, handleLyricMatchPureMusicMarkChanged, handleNaviLyricMatchComplete,
        handleOnlineLyricMatchComplete, handleSaveLyricFilterPattern, handleToggleCurrentSongPureMusicMark,
        handleUpdateLocalLyrics, isLocalSongLiked, isLyricMatchOpen, loadCurrentSongLyricPreview, loadLocalPlaylists,
        loadLocalSongs, localLibraryCatalog, localPlaylists, localSongs, moveQueueSong, moveQueueSongToEnd,
        moveQueueSongToNext, onPlayLocalSong, onPlayNavidromeSong, onRefreshLocalSongs, openHomeCollection,
        openLyricMatch, removeQueueSong, saveCurrentQueueAsLocalPlaylist, toggleTransparentModeWithHandoff
    };
};

export type AppLibraryControllers = ReturnType<typeof useAppLibraryControllers>;
