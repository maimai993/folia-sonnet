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
import { useFoliumHostActions } from '../../../mods/runtime/hostActions';
import { resolveSongCatalogRef } from '../../../services/onlineMusic/catalogRefs';
import { nativePlaybackEngine } from '../../../services/playbackEngine/nativePlaybackEngine';
import { playbackFade } from '../../../services/playbackFade';
import { refreshPrefetchAfterQueueEdit } from '../../../services/prefetchService';
import { currentTime, lyricCurrentTime } from '../../../stores/motionSignals';
import { setStatusMessage as setStatusMsg } from '../../../stores/useStatusMessageStore';
import { Album, Artist, PlayerState, SongResult, UnifiedSong } from '../../../types';
import { useVisualizerRendererModel } from '../../visualizer/useVisualizerRendererModel';
import { readLiveLyricTime } from '../backgroundThrottling/backgroundLyricHoldStore';
import { askForSong, showSong } from '../playback/currentSong';
import { useCallback } from 'react';

// src/components/app/appWiring/useAppPlaybackActions.ts
// 播放控制动作：混音过渡取消、seek、歌词行跳转、Folium 动作与歌词行点击。

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
    & AppCommandPalette;

export const useAppPlaybackActions = (model: Input) => {
    const {
        activePlaybackContext, addOnlineSongToQueue, adoptActiveDeckSource, audioQuality, audioRef, audioSrc,
        automix, backCollection, closeSearchView, commandPalette, commandPaletteContext, currentSong, duration,
        handleLike, handleNextTrack,
        handlePrevTrack, isLyricsLoading, isNowPlayingControlDisabled, isObsBrowserSourceRendering,
        isPlayerPageTransparent, nativeTakesRef, navigateBackFromLattice, navigateBackFromPlayer,
        navigateToCollection, navigateToHome,
        navigateToPlayer, pauseDuringTransitionRef, pausePlayback, persistLastPlaybackCache, playSong, playerState,
        publishStagePlayerPlaybackUpdate, resumePlayback, seekDuringTransitionRef, seekMainAudioRef, setAudioSrc,
        setCachedCoverUrl, setDuration, setLyrics, setPlayerState, shouldHidePlayerTranslationSubtitle,
        shouldPauseVisualizerBackground, shuffleQueue, stageActiveEntryKind, stageLyricsClockRef,
        syncStageLyricsClock, t, togglePlay, user, visualizerGeometrySeed, visualizerSubtitleTheme, visualizerTheme
    } = model;
    /**
     * Cancels a blend back onto the track the listener is hearing, or null when there is none.
     *
     * Mid-blend the app runs two of everything: the song on screen is the one FINISHING - the
     * outgoing deck's - while `audioRef`, `currentSong` and the transport already name the track
     * arriving underneath it. So any control the listener presses about "this song" lands on a deck
     * that is not the one they mean, and the two reports this answers are the same mistake twice: a
     * drag moved the hidden deck and the bar snapped back, a pause stopped the hidden deck and the
     * blend ran on into the next song regardless.
     *
     * The track they mean is already loaded and sounding on its own deck, so nothing needs
     * reloading: cancel onto that deck (`cancelBlendKeepingTail`) and hand it back the whole frozen
     * picture. An older fix re-played the song from scratch, which ran the entire song-change path -
     * a fresh blob URL, lyrics refetched, the read-head reset - for a track that never left; the
     * visualizers read that as a song change and answered with a switch animation, and the reload
     * cost a visible hitch. `adoptActiveDeckSource` is what stops the audio bridge reloading the
     * deck out from under us. (Touching that deck at all depends on its blob URL still being live -
     * see `retireBlobUrl`, which is why the source outlives the advance now.)
     *
     * Returns the deck now carrying that track, for the caller to move or to stop. `resume` says
     * which way the transport is going afterwards, and it is the only difference between the two
     * callers.
     */
    const cancelBlendToDisplayedTrack = (resume: boolean): HTMLAudioElement | null => {
        if (!automix.isTransitionAudible()) return null;
        // The whole frozen picture, not just the song. A blend deliberately runs two sets of these:
        // the visible ones (this snapshot, the OUTGOING track) and the live state, which `playSong`
        // moved to the incoming track at the arm. Cancelling clears the snapshot, so every value in
        // it has to be handed back to the live state or the app keeps the incoming track's copy
        // under the outgoing track's name. `duration` is the one that breaks playback rather than
        // just looking wrong: the progress bar would rescale to the OTHER song's length, so the next
        // drag maps to a time past the real end of this one and the deck stops there - "I dragged
        // and it went silent". The old re-play fix got this back for free, because reloading the
        // song fired `onLoadedMetadata` again; keeping the deck means nothing refires it.
        const frozen = automix.transitionDisplay;
        const exitingSong = frozen?.song ?? currentSong;
        if (!exitingSong) return null;
        // The deck still playing the outgoing track - the one the frozen picture reads from.
        const tailElement = automix.getDisplayElement();
        if (!tailElement) return null;
        // The exact string that deck is rendering, so re-pointing `audioSrc` at it below changes no
        // src attribute and reloads nothing. Falls back to the element's own URL, then to `audioSrc`.
        const keepSrc = automix.tailSrc ?? tailElement.currentSrc ?? audioSrc;
        // Tell the bridge the active deck already holds this source, THEN cancel onto it: the cancel
        // repoints the audio ref at that deck, and the setAudioSrc below must not trigger a reload.
        if (keepSrc) adoptActiveDeckSource(keepSrc);
        const wasArmed = automix.cancelBlendKeepingTail();
        if (keepSrc) setAudioSrc(keepSrc);
        // Put the display and the queue pointer back on the outgoing song (both key off currentSong).
        showSong(exitingSong);
        if (resume) {
            // Force PLAYING: the advance dropped the transport to IDLE and only the incoming deck
            // starting would have cleared it - but that deck is the one being discarded.
            setPlayerState(PlayerState.PLAYING);
        } else if (wasArmed) {
            // Stopping, and the advance is already in flight: the incoming deck is loading with an
            // autoplay intent standing behind it, and cancelling cannot recall that. The intent now
            // points at the deck we just kept, so left alone the audio bridge presses play on the
            // very track this pause meant to stop. Same knob the ordinary mid-blend pause uses (the
            // playerState effect in useAutomixDecks), set here because by the time that effect runs
            // the session is already idle and it can no longer tell an armed blend was interrupted.
            automix.suppressAutoplayRef.current = true;
        }
        // The rest of the frozen picture - every field of it, which is the point: `TransitionDisplay`
        // is exactly the set of values a blend holds back, so handing all four to the live state is
        // what makes cancelling a no-op rather than a half-move. Without the length the deck reads
        // its own position against the other track's, which both mis-draws the bar and hands
        // `checkTransitionPoint` a wrong number to plan the NEXT blend from; the cover has to be put
        // back through `cachedCoverUrl` because the resolver prefers it over the song's own metadata.
        if (frozen) {
            setDuration(frozen.duration);
            setLyrics(frozen.lyrics);
            setCachedCoverUrl(frozen.coverUrl);
        }
        // The advance pointed this at the incoming track; playSong normally moves it, but this path
        // does not run playSong. Left stale, every callback gated on "is this still the current song"
        // (recovery, scrobble, the deck-playing handler) would answer for a track that isn't playing.
        // Put back, not started again: the outgoing song never stopped playing.
        askForSong(exitingSong, { putBack: true });
        // One line per cancel, because everything this path does is invisible by design - it is the
        // absence of a song change. Without it a report of "I pressed something and it went wrong"
        // has nothing in the log to sit next to, which is exactly how the wrong-duration bug above
        // stayed hidden.
        console.log(
            `[Automix] blend cancelled by a ${resume ? 'seek' : 'pause'} while ${wasArmed ? 'armed' : 'fading'},`
            + ` staying on "${exitingSong.name}" (${(frozen?.duration ?? 0).toFixed(1)}s long)`,
        );
        return tailElement;
    };
    /**
     * A seek that lands during an automix blend, or false when there is no blend to cancel.
     *
     * Held in a ref - declared up by the transport controller, and reused by the Electron bridge for
     * the remote's own seek - refreshed every render, so `seekMainAudio` itself can stay a stable
     * callback (it is threaded through the memoised overlay model) while this closure always sees
     * the live song, queue-mode and blend state.
     */
    seekDuringTransitionRef.current = (time: number) => {
        const tailElement = cancelBlendToDisplayedTrack(true);
        if (!tailElement) return false;
        const seekTarget = Math.max(0, time);
        tailElement.currentTime = seekTarget;
        currentTime.set(seekTarget);
        return true;
    };
    /**
     * A pause that lands during an automix blend, or false when there is no blend to cancel.
     *
     * Pressing pause is a statement about the track on screen, and mid-blend that track is on the
     * deck no control points at. Pausing the active deck instead stopped the ARRIVING track - silent
     * anyway for the whole lead - and left the outgoing one playing with its blend still scheduled,
     * so the listener pressed pause and then watched it hand over to the next song. Cancel onto the
     * track they meant and stop that deck; both end up silent, because the cancel's own settle
     * pauses the deck being discarded.
     *
     * Held in a ref for the same reason as the seek above: the transport controller that calls it is
     * wired far above the point where automix exists to write it.
     */
    pauseDuringTransitionRef.current = () => {
        const tailElement = cancelBlendToDisplayedTrack(false);
        if (!tailElement) return false;
        tailElement.pause();
        return true;
    };
    const seekMainAudio = useCallback((time: number) => {
        // A seek is a statement that playback should go on, same as it is on a paused track. If a
        // pause is still fading out, take it back (the audio never stopped) so the pending pause
        // cannot land after the seek.
        const resumedFromFade = playbackFade.cancelPendingPause();
        if (resumedFromFade) {
            setPlayerState(PlayerState.PLAYING);
        }
        if (seekDuringTransitionRef.current(time)) {
            return;
        }
        // 原生播放（P1）：元素是空的，写它的 currentTime 没有意义，还会顺手把那个空元素
        // 「播」起来。交给 ExoPlayer。
        if (nativeTakesRef.current) {
            void nativePlaybackEngine.seek(time);
            void publishStagePlayerPlaybackUpdate();
            return;
        }
        if (audioRef.current) {
            audioRef.current.currentTime = time;
            if (audioRef.current.paused) {
                void audioRef.current.play();
                setPlayerState(PlayerState.PLAYING);
            }
            void publishStagePlayerPlaybackUpdate();
        }
    }, [publishStagePlayerPlaybackUpdate]);
    seekMainAudioRef.current = seekMainAudio;

    const handleMonetLyricLineSeek = useCallback((lyricTimeSec: number) => {
        if (isNowPlayingControlDisabled) {
            return;
        }

        // Not lyricCurrentTime itself: 后台节流 holds that still while the window is hidden and playback runs on.
        const playbackTime = Math.max(0, lyricTimeSec + currentTime.get() - readLiveLyricTime());
        if (activePlaybackContext === 'stage' && stageActiveEntryKind === 'lyrics' && !audioSrc) {
            syncStageLyricsClock(playbackTime, duration, playerState, stageLyricsClockRef.current.startTimeSec);
            currentTime.set(playbackTime);
            if (playerState !== PlayerState.PLAYING) {
                setPlayerState(PlayerState.PLAYING);
            }
            void publishStagePlayerPlaybackUpdate();
        } else {
            seekMainAudio(playbackTime);
        }
    }, [
        activePlaybackContext,
        audioSrc,
        currentTime,
        duration,
        isNowPlayingControlDisabled,
        lyricCurrentTime,
        playerState,
        publishStagePlayerPlaybackUpdate,
        seekMainAudio,
        stageActiveEntryKind,
        stageLyricsClockRef,
        syncStageLyricsClock,
    ]);

    // Folium services (folium.playback / folium.ui) call through to these App handlers.
    useFoliumHostActions({
        play: resumePlayback,
        pause: pausePlayback,
        toggle: () => togglePlay(),
        seek: seekMainAudio,
        seekToLyricTime: handleMonetLyricLineSeek,
        next: () => { void handleNextTrack(); },
        previous: handlePrevTrack,
        playSong: (song) => playSong(song),
        playQueueSong: (song, queue, isFm) => playSong(song, queue, isFm),
        enqueue: addOnlineSongToQueue,
        navigateToPlayer,
        navigateToHome,
        navigateBackFromPlayer,
        navigateBackFromLattice,
        backCollection,
        closeSearchView,
        shuffleQueue,
        toggleLike: handleLike,
        openVolume: () => commandPalette.invokeCommandById('playback-volume'),
        isLiked: commandPaletteContext.playback.isSongLiked,
        controlsDisabled: isNowPlayingControlDisabled,
        isLyricsLoading,
        persistQueue: persistLastPlaybackCache,
        refreshQueuePrefetch: (song, previous, next) => refreshPrefetchAfterQueueEdit(song, previous, next, audioQuality, user?.id),
    });

    const visualizerRendererModel = useVisualizerRendererModel({
        theme: visualizerTheme,
        subtitleTheme: visualizerSubtitleTheme,
        seed: visualizerGeometrySeed,
        isObsBrowserSourceRendering,
        shouldPauseVisualizerBackground,
        hideTranslationSubtitle: shouldHidePlayerTranslationSubtitle,
        isPlayerPageTransparent,
        onLyricLineSeek: handleMonetLyricLineSeek,
        onBack: navigateBackFromPlayer,
    });

    const handlePlayerPanelAlbumSelect = useCallback(async (song: SongResult, album: Album) => {
        try {
            const ref = await resolveSongCatalogRef(song as UnifiedSong, 'album', album);
            if (ref) {
                navigateToCollection({
                    source: 'online',
                    providerId: ref.providerId,
                    id: ref.id,
                    type: 'album',
                    name: album.name || t('home.albums'),
                    coverUrl: album.coverUrl,
                }, 'player');
                return;
            }
        } catch (error) {
            console.warn('[CatalogNavigation] Failed to resolve player album:', error);
        }
        setStatusMsg({ type: 'error', text: t('search.catalogUnavailable') });
    }, [navigateToCollection, setStatusMsg, t]);

    const handlePlayerPanelArtistSelect = useCallback(async (song: SongResult, artist: Artist) => {
        try {
            const ref = await resolveSongCatalogRef(song as UnifiedSong, 'artist', artist);
            if (ref) {
                navigateToCollection({
                    source: 'online',
                    providerId: ref.providerId,
                    id: ref.id,
                    type: 'artist',
                    name: artist.name || t('navidrome.artists'),
                }, 'player');
                return;
            }
        } catch (error) {
            console.warn('[CatalogNavigation] Failed to resolve player artist:', error);
        }
        setStatusMsg({ type: 'error', text: t('search.catalogUnavailable') });
    }, [navigateToCollection, setStatusMsg, t]);

    return {
        ...model,
        handlePlayerPanelAlbumSelect, handlePlayerPanelArtistSelect, seekMainAudio, visualizerRendererModel
    };
};

export type AppPlaybackActions = ReturnType<typeof useAppPlaybackActions>;
