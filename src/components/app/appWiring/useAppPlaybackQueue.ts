import type { AppFoundation } from './useAppFoundation';
import type { AppAudioOutput } from './useAppAudioOutput';
import type { AppThemeAndNavigation } from './useAppThemeAndNavigation';
import type { AppAccountsAndStage } from './useAppAccountsAndStage';
import type { AppLibraryControllers } from './useAppLibraryControllers';
import { useLocalCoverQueueSync } from '../../../hooks/useLocalCoverQueueSync';
import { isWallLibrarySuite, useActiveLibrarySuiteId } from '../../../library/app/librarySuiteChoice';
import { registerLocalTrackFileReader } from '../../../services/analysis/trackAudio';
import { useAutomixDecks } from '../../../services/automix/useAutomixDecks';
import { getLocalSongArrayBuffer } from '../../../services/localMusicService';
import { getSongArtistLabel, getSongCoverUrl } from '../../../services/onlineMusic/songMetadata';
import { currentTime } from '../../../stores/motionSignals';
import { selectDisplayCoverUrl, selectDisplayDuration, selectDisplayPlayerState, selectDisplaySong, selectIsShowingTail, usePlaybackStore } from '../../../stores/usePlaybackStore';
import { setStatusMessage as setStatusMsg } from '../../../stores/useStatusMessageStore';
import { SongResult, UnifiedSong, LocalSong } from '../../../types';
import { MediaId } from '../../../types/onlineMusic';
import { isLocalPlaybackSong } from '../../../utils/appPlaybackGuards';
import { toSafeRemoteUrl } from '../../../utils/appPlaybackHelpers';
import { resolveSongLiked } from '../../../utils/resolveSongLiked';
import { resolveLikeAvailability } from '../../../utils/playerLikeAvailability';
import { resetMediaDiagnostics } from '../../../utils/mediaDiagnostics';
import { shouldShowNowPlayingToast } from '../overlays/now-playing-toast/nowPlayingToastVisibility';
import { resolveNextUpTrack } from '../overlays/now-playing-toast/resolveNextUpTrack';
import { useLyricReadHead } from '../playback/bridges/useLyricReadHead';
import { usePlaybackUiEffects } from '../playback/bridges/usePlaybackUiEffects';
import { usePlaybackQueueController } from '../playback/start/usePlaybackQueueController';
import { createSearchAlbumCollection, createSearchArtistCollection } from '../search/searchCollectionAdapters';
import { useMotionValueEvent } from 'framer-motion';
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';

// src/components/app/appWiring/useAppPlaybackQueue.ts
// 播放队列与 automix 双 deck：队列控制器、搜索结果动作、显示层选择器、下一首预告。

const LOCAL_MUSIC_UPDATED_EVENT = 'folia-local-music-updated';
/** How many seconds before a track ends the now playing card previews the queue's next track. */
const NEXT_UP_LEAD_SEC = 5;

type Input =
    & AppFoundation
    & AppAudioOutput
    & AppThemeAndNavigation
    & AppAccountsAndStage
    & AppLibraryControllers;

export const useAppPlaybackQueue = (model: Input) => {
    const {
        addNavidromeSongsToQueue, audioContextRef, audioRef, audioSrc, automixEnabled, automixRef, blobUrlRef,
        coverUrl, currentOnlineAudioUrlFetchedAtRef, currentSong, currentSongRef, currentView, effectiveLoopMode,
        globalLyricTimelineOffsetMs, handleLocalQueueAdd, interruptStagePlaybackForMainTransition, isFmMode,
        isNowPlayingStageActive, isLocalSongLiked, lastAudioRecoverySourceRef, likedSongIds, loadLocalPlaylists, loadLocalSongs,
        loadMoreSearchResults, localLibraryCatalog, localSongs, mainPlaybackSnapshotRef, nativeActive,
        nativeFailedKeysRef, nativeTakesRef,
        navigateToCollection, navigateToPlaybackView, navigateToSearch, onPlayLocalSong, onPlayNavidromeSong,
        pendingResumeTimeRef, persistLastPlaybackCache, playQueue, playbackAutoSkipCountRef,
        restoreCachedThemeForSong, setCurrentSong, setDuration, setIsLyricsLoading, setIsPanelOpen, setLyrics,
        setPanelTab, setPlayQueue, shouldAutoPlay, stageTrackPillMode, stageTrackPillOnHome, starredNavidromeSongIds,
        statusMsg, submitSearch,
        t, transitionSettings, user, volumePreviewFrameRef
    } = model;
    // --- Effects ---

    /**
     * The track the listener can see, which a blend holds on the OUTGOING song while the queue has
     * already moved to the incoming one. Null whenever the picture is live, so queue navigation
     * falls through to `currentSong` exactly as before outside a transition.
     */
    const getDisplaySong = useCallback(() => automixRef.current?.transitionDisplay?.song ?? null, []);
    /** A manual skip overtakes a running blend; this is how the queue tells it so. */
    const endHeldTransition = useCallback(() => automixRef.current?.abortTransition(), []);

    const {
        pendingUnavailableReplacement,
        setPendingUnavailableReplacement,
        clearPendingUnavailableSkip,
        addOnlineSongToQueue,
        addOnlineSongsToQueue,
        playSong,
        playOnlineQueueFromStart,
        handleQueueAddAndPlay,
        handleSearchOverlaySubmit,
        handleSearchLoadMore,
        handleSearchResultPlay,
        handleSearchResultAddToQueue,
        handleUnavailableReplacementConfirm,
        handleNextTrack,
        handlePrevTrack,
        skipAfterPlaybackFailure,
        handleStageExternalPlayRequest,
        shuffleQueue,
        clearQueue,
    } = usePlaybackQueueController({
        isNowPlayingStageActive,
        shouldNavigateToPlayerOnTrackChange: currentView !== 'lattice',
        localSongs,
        localLibraryCatalog,
        userId: user?.id,
        setLyrics,
        setIsLyricsLoading,
        navigateToPlaybackView,
        navigateToSearch,
        persistLastPlaybackCache,
        restoreCachedThemeForSong,
        interruptStagePlaybackForMainTransition,
        onPlayLocalSong,
        onPlayNavidromeSong,
        onAddLocalSongToQueue: handleLocalQueueAdd,
        onAddNavidromeSongsToQueue: addNavidromeSongsToQueue,
        searchDeps: {
            submitSearch,
            loadMoreSearchResults,
        },
        audioRef,
        blobUrlRef,
        shouldAutoPlayRef: shouldAutoPlay,
        mainPlaybackSnapshotRef,
        playbackAutoSkipCountRef,
        pendingResumeTimeRef,
        currentOnlineAudioUrlFetchedAtRef,
        lastAudioRecoverySourceRef,
        getDisplaySong,
        endHeldTransition,
        // 两轨合一：点歌 / 切歌的分流。nativeTakes 是「这一首交给原生」的即时判定，
        // 但分流发生在回调里（用户按下时才跑），所以传 ref —— 跟 transport 回调同一套纪律。
        nativePlaybackRef: nativeTakesRef,
        // 队列里每首歌的红心状态：同步读账号缓存，随队列一起落进原生镜像。
        nativeLikeStateOf: (song) => ({
            liked: resolveSongLiked(song, { isLocalSongLiked, starredNavidromeSongIds, likedSongIds }),
            canLike: !resolveLikeAvailability(song, false, false).disabled,
        }),
        nativeFailedKeysRef,
    });
    const handleSearchResultArtistOpen = useCallback(async (
        track: UnifiedSong,
        artistName: string,
        artistId?: MediaId,
        entityId?: string,
    ) => {
        try {
            const collection = await createSearchArtistCollection(track, artistName, artistId, entityId);
            if (collection) {
                navigateToCollection(collection, 'search');
                return;
            }
        } catch (error) {
            console.warn('[CatalogNavigation] Failed to resolve artist:', error);
        }
        setStatusMsg({ type: 'error', text: t('search.catalogUnavailable') });
    }, [navigateToCollection, setStatusMsg, t]);
    const handleSearchResultAlbumOpen = useCallback(async (
        track: UnifiedSong,
        albumName: string,
        albumId?: MediaId,
        entityId?: string,
    ) => {
        try {
            const collection = await createSearchAlbumCollection(track, albumName, albumId, entityId);
            if (collection) {
                navigateToCollection(collection, 'search');
                return;
            }
        } catch (error) {
            console.warn('[CatalogNavigation] Failed to resolve album:', error);
        }
        setStatusMsg({ type: 'error', text: t('search.catalogUnavailable') });
    }, [navigateToCollection, setStatusMsg, t]);

    usePlaybackUiEffects({
        statusMsg,
        loadLocalSongs,
        loadLocalPlaylists,
        localMusicUpdatedEvent: LOCAL_MUSIC_UPDATED_EVENT,
        blobUrlRef,
        volumePreviewFrameRef,
        onClearPendingUnavailableSkip: clearPendingUnavailableSkip,
    });

    // 本地歌的封面常常是「后来才有」的（播放时 / 预热时 / 列表回填时抽出来的），
    // 而磁贴墙铺的是建队列那一刻烤进去的快照 —— 这个订阅把新抽到的封面补回队列条目。
    useLocalCoverQueueSync({ playQueue, setPlayQueue, currentSong, setCurrentSong, localSongs });

    // Bridges the automix hook (built here) to the media-cache writer (built a little further down in
    // usePlaybackAudioBridge). A ref rather than a prop because the writer does not exist yet at this
    // call - the same ordering the harvest/advance callbacks inside the hook solve the same way.
    const cachePlayedOutRef = useRef<(song: SongResult, src: string | null) => void>(() => { });
    // The active deck's last position on single loop, with the source it was on: a looping track
    // never fires `ended`, so its wrap back to the start is what says it was played through.
    const loopPositionRef = useRef<{ src: string; time: number } | null>(null);

    // Reads a local track's bytes off its own file handle, so automix can separate a next-up local
    // song whose head has no prefetch URL and never enters the online media cache. Resolved here
    // because App owns the local library; the real LocalSong (with its handle) is looked up by id.
    const getLocalStemBytes = useCallback(async (song: SongResult): Promise<ArrayBuffer | null> => {
        if (!isLocalPlaybackSong(song)) return null;
        const local = localSongs.find(candidate => candidate.id === song.localRef.songId);
        return getLocalSongArrayBuffer((local ?? song) as unknown as LocalSong);
    }, [localSongs]);
    // The same reader for every analyser (analysis/trackAudio.ts): 智能动感模式 and automix's
    // profile read a local track that has no URL in hand through it too.
    useEffect(() => {
        registerLocalTrackFileReader(getLocalStemBytes);
        return () => registerLocalTrackFileReader(null);
    }, [getLocalStemBytes]);

    const automix = useAutomixDecks({
        audioRef,
        audioContextRef,
        currentSongKeyRef: currentSongRef,
        coverUrl,
        loopMode: effectiveLoopMode,
        // 原生播放（P1）：automix 的双 deck 交叉淡化是靠 Web 音频图做的，图一断它就只剩
        // 「两个空元素互相等」，转场点永远到不了、下一首也就永远不会自己来。原生阶段
        // 直接关掉：切歌回到「播完再切」。
        isEnabled: automixEnabled && !isNowPlayingStageActive && !nativeActive,
        transition: transitionSettings,
        onAdvanceTrack: () => {
            // Same advance the end of a track would trigger, only early enough for the outgoing
            // deck to still be sounding when the next one starts. `fromSong` because this IS the
            // advance: it steps from the track the app is on, never from the held picture, and
            // saying so keeps it independent of whether React has committed the hold yet.
            void handleNextTrack({
                allowStopOnMissing: true,
                shouldNavigateToPlayer: false,
                fromSong: currentSong ?? undefined,
                isAutomixAdvance: true,
            });
        },
        onDeckPlayedOut: (song, src) => cachePlayedOutRef.current(song, src),
        getLocalStemBytes,
    });

    automixRef.current = automix;

    /**
     * The now-playing picture, which lags the app's own idea of what is playing.
     *
     * A transition advances the queue at its START, because that advance is what loads and plays
     * the next track. So from that moment `currentSong`, the lyrics, the cover and the progress
     * bar all describe the track that is arriving - seconds before anybody hears it arrive, which
     * is the listener still hearing one song and reading another one's title.
     *
     * Everything here is presentation and nothing here touches the audio path. That is deliberate:
     * the obvious fix is to defer the advance itself, and it does not work, because for anything
     * already in the media cache `playSong` mints a fresh blob URL - `warmSrc` is null for those
     * tracks and the advance is the only thing that ever gives the incoming deck a source. What is
     * safe to hold back is the picture.
     */
    // Derived in usePlaybackStore now, so that any consumer can read the display layer without
    // being handed it. The ternaries (rather than `??`) live there for the same reason they lived
    // here: null is a real value for lyrics, cover and duration.
    const displaySong = usePlaybackStore(selectDisplaySong);
    const displayCoverUrl = usePlaybackStore(selectDisplayCoverUrl);
    const displayDuration = usePlaybackStore(selectDisplayDuration);
    /** While true the progress bar is driven by the deck that is finishing, not the active one. */
    const isShowingTail = usePlaybackStore(selectIsShowingTail);
    /**
     * The transport the picture belongs to, which is not idle just because the next track is.
     *
     * `playSong` resets the state to IDLE for the track it is loading, and that is correct for the
     * track it is loading - but the advance happens at the START of a blend, so nothing puts it
     * back until the incoming deck actually starts making sound. Measured at about a second, and
     * the outgoing deck is sounding for all of it: "idle" there describes nothing anybody can hear.
     *
     * IDLE only. PAUSED during a blend is a listener pressing pause and has to be shown.
     */
    const displayPlayerState = usePlaybackStore(selectDisplayPlayerState);
    // The bar is driven by the tail deck for the length of a blend, so at BOTH edges of the hold
    // it briefly reads one track's position against the other's length. One write at each edge
    // rather than waiting up to a quarter second for the next timeupdate to correct it.
    //
    // Entering used to be missing, and that edge is the one anybody sees: `playSong` zeroes the
    // clock for the arriving track from the same block that starts the hold, so the bar dropped to
    // the beginning and stayed there until the OUTGOING deck's next timeupdate put it back - a song
    // change that visibly happened and then visibly un-happened, while the title never moved.
    const getDisplayElement = automix.getDisplayElement;
    useEffect(() => {
        const element = isShowingTail ? getDisplayElement() : audioRef.current;
        if (element) currentTime.set(element.currentTime);
    }, [audioRef, currentTime, getDisplayElement, isShowingTail]);

    // Restores the displayed song's offset and resets its read-head, unless a blend handed it over.
    const incomingLyricTimelineOffsetMs = useLyricReadHead(globalLyricTimelineOffsetMs);

    /**
     * The now playing card is allowed on screen right now.
     *
     * One definition for two readers - the overlay model, which mounts the card, and the track-end
     * countdown below, which is only worth running while something can show its result. The lyrics
     * player and Lattice pages always allow it; the home page is opt-in, and that opt-in is the
     * whole rule: how the app arrived at the home page does not enter into it, so a cold start that
     * lands there and a walk back from another page behave the same.
     */
    const activeLibrarySuiteId = useActiveLibrarySuiteId();
    const stageTrackPillOnScreen = shouldShowNowPlayingToast({
        mode: stageTrackPillMode,
        view: currentView,
        showOnHome: stageTrackPillOnHome,
        // bravais 的墙与 Lattice 同类：卡片在墙上常在，不看「在首页显示」（2026-10-10）。
        homeIsWall: isWallLibrarySuite(activeLibrarySuiteId),
    });

    /**
     * Open the right-hand panel on its song card - what clicking the now playing card does once you
     * are already on the lyrics page. Same two calls the command palette's "Panel: cover" makes, so
     * the card and the command land in the same place.
     */
    const openSongCardPanel = useCallback(() => {
        setPanelTab('cover');
        setIsPanelOpen(true);
    }, []);

    /**
     * The queue track a plain track-end would advance to, or null when nothing resolvable.
     * Mirrors handleNextTrack's index rules so the preview is always the track that will actually play.
     */
    const nextUpTrack = useMemo(() => resolveNextUpTrack({
        playQueue,
        song: currentSong,
        loopMode: effectiveLoopMode,
        isFmMode,
        isStageActive: isNowPlayingStageActive,
        fallbackToQueueHead: true,
    }), [playQueue, currentSong, effectiveLoopMode, isFmMode, isNowPlayingStageActive]);

    /**
     * The track a running blend is bringing in: the queue successor of the DISPLAYED song.
     * The displayed picture is frozen on the outgoing track for the whole blend, while currentSong
     * advances asynchronously at the arm — reading the successor of the displayed song is correct
     * from the first frame and stays correct until settle. No queue-head fallback here: mid-blend a
     * song missing from the queue means the queue moved under the blend, and guessing would announce
     * a track that is not arriving.
     */
    const blendNextUpTrack = useMemo(() => (isShowingTail ? resolveNextUpTrack({
        playQueue,
        song: displaySong,
        loopMode: effectiveLoopMode,
        isFmMode,
        isStageActive: isNowPlayingStageActive,
    }) : null), [isShowingTail, displaySong, playQueue, effectiveLoopMode, isFmMode, isNowPlayingStageActive]);

    /** True while the card previews the next track (plain track-end countdown, not the blend). */
    const [countdownActive, setCountdownActive] = useState(false);
    useMotionValueEvent(currentTime, 'change', (time) => {
        const shouldPreview = stageTrackPillOnScreen
            && nextUpTrack !== null
            && Number.isFinite(displayDuration)
            && displayDuration > 0
            && displayDuration - time > 0
            && displayDuration - time <= NEXT_UP_LEAD_SEC;
        setCountdownActive(prev => (prev === shouldPreview ? prev : shouldPreview));
    });

    /**
     * The track the card shows while announcing a switch.
     * During a blend the arriving track comes from the queue successor of the displayed
     * (outgoing) song — never from currentSong, which lags the arm by a few async frames and
     * briefly made the card announce the OUTGOING song as "next".
     */
    const stageNextUpTrack = isShowingTail ? blendNextUpTrack : nextUpTrack;
    const stageNextUp = useMemo(() => {
        if (stageTrackPillMode === 'never' || !stageNextUpTrack) return null;
        return {
            title: stageNextUpTrack.name || '',
            artist: getSongArtistLabel(stageNextUpTrack) || null,
            // Same sanitising every other cover in the app goes through (see createCoverUrlResolver):
            // upgrades the http: covers netease/kugou still hand out - blocked as mixed content in the
            // packaged window - and keeps only the first of a comma-joined multi-value.
            coverUrl: toSafeRemoteUrl(getSongCoverUrl(stageNextUpTrack)) ?? null,
        };
    }, [stageTrackPillMode, stageNextUpTrack]);
    const stageIsNextUp = stageNextUp !== null && (isShowingTail || countdownActive);


    // The duration normally arrives on `loadedmetadata`, which fires when an element is given a
    // source. A warmed deck breaks that: it is handed the next track seconds early, fires the event
    // while it is still idle - where every handler here ignores it - and then never fires again,
    // because the whole point of warming is that its src string does not change when it takes over.
    // Meanwhile playSong has reset the duration to 0 for the new track.
    //
    // So a source the element already knows about needs reading directly. Keyed on `audioSrc`
    // rather than on the deck role, because the role swaps a moment BEFORE playSong zeroes the
    // duration and reading first would simply be overwritten.
    //
    // Left at zero this is not only a wrong progress bar: checkTransitionPoint needs a duration to
    // schedule against, so the track after a blend would get no transition at all.
    useEffect(() => {
        const element = audioRef.current;
        // currentSrc, not the src attribute: it only names a resource the element has actually
        // selected, so a deck one tick into loading something new cannot answer with the old
        // track's duration.
        if (!audioSrc || element?.currentSrc !== audioSrc) return;
        if (Number.isFinite(element.duration) && element.duration > 0) {
            setDuration(element.duration);
        }
    }, [audioSrc, audioRef, setDuration]);

    // 换歌就复位播放侧停顿计数：上一首的卡顿不该算到这一首头上。
    useEffect(() => {
        resetMediaDiagnostics();
    }, [audioSrc]);

    return {
        ...model,
        addOnlineSongToQueue, addOnlineSongsToQueue, automix, cachePlayedOutRef, clearQueue, displayCoverUrl,
        displayDuration, displayPlayerState, displaySong, handleNextTrack, handlePrevTrack, handleSearchLoadMore,
        handleSearchOverlaySubmit, handleSearchResultAddToQueue, handleSearchResultAlbumOpen,
        handleSearchResultArtistOpen, handleSearchResultPlay, handleStageExternalPlayRequest,
        handleUnavailableReplacementConfirm, incomingLyricTimelineOffsetMs, isShowingTail, loopPositionRef,
        openSongCardPanel, pendingUnavailableReplacement, playOnlineQueueFromStart, playSong,
        setPendingUnavailableReplacement, shuffleQueue, skipAfterPlaybackFailure, stageIsNextUp, stageNextUp,
        stageTrackPillOnScreen
    };
};

export type AppPlaybackQueue = ReturnType<typeof useAppPlaybackQueue>;
