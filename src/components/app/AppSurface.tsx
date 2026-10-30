import type { AppFoundation } from './appWiring/useAppFoundation';
import type { AppAudioOutput } from './appWiring/useAppAudioOutput';
import type { AppThemeAndNavigation } from './appWiring/useAppThemeAndNavigation';
import type { AppAccountsAndStage } from './appWiring/useAppAccountsAndStage';
import type { AppLibraryControllers } from './appWiring/useAppLibraryControllers';
import type { AppPlaybackQueue } from './appWiring/useAppPlaybackQueue';
import type { AppPlaybackBridges } from './appWiring/useAppPlaybackBridges';
import type { AppChromeAndGestures } from './appWiring/useAppChromeAndGestures';
import type { AppPublishers } from './appWiring/useAppPublishers';
import type { AppCommandPalette } from './appWiring/useAppCommandPalette';
import type { AppPlaybackActions } from './appWiring/useAppPlaybackActions';
import type { AppWallAndHome } from './appWiring/useAppWallAndHome';
import type { AppPlayerPanel } from './appWiring/useAppPlayerPanel';
import type { AppOverlayModels } from './appWiring/useAppOverlayModels';
import { FoliumStageLayerSlot } from '../../mods/folium/registries/stageLayers';
import { type AutomixDeckId } from '../../services/automix/useAutomixDecks';
import { consumeProgrammaticPause, playbackFade } from '../../services/playbackFade';
import { hasLoopedToStart } from '../../services/playedTrackCache';
import { currentTime, lyricCurrentTime } from '../../stores/motionSignals';
import { endLoadingToPlay } from '../../stores/usePlaybackStore';
import { PlayerState } from '../../types';
import { isLocalPlaybackSong, isNavidromePlaybackSong, isStagePlaybackSong } from '../../utils/appPlaybackGuards';
import { noteAudioEvent } from '../../utils/mediaDiagnostics';
import CommandPalette from '../command-palette/CommandPalette';
import { PlayerBottomBarLayoutContext } from '../floating-player/PlayerBottomBarLayoutContext';
import LoginHost from '../login/LoginHost';
import SignInSpotlight from '../login/SignInSpotlight';
import AnalysisModelsPrompt from '../modal/AnalysisModelsPrompt';
import AppUpdatePromptDialog from '../modal/AppUpdatePromptDialog';
import FreeSoftwareNoticeModal from '../modal/FreeSoftwareNoticeModal';
import LegacyModelsPrompt from '../modal/LegacyModelsPrompt';
import { LatticeFmNotice } from '../modal/playback-entry-view/LatticeFmNotice';
import { PlaybackEntryViewPrompt } from '../modal/playback-entry-view/PlaybackEntryViewPrompt';
import ReleaseNotesDialog from '../modal/ReleaseNotesDialog';
import { UserGuideModal } from '../modal/UserGuideModal';
import ThemeQuickEditorHost from '../panelTab/ThemeQuickEditor';
import PonderHost from '../ponder/PonderHost';
import VisualizerRenderer from '../visualizer/VisualizerRenderer';
import WallToolsDockHost from '../wall/WallToolsDock';
import AddToPlaylistHost from './AddToPlaylistHost';
import AppShell from './AppShell';
import AppDialogs from './dialogs/AppDialogs';
import ExternalAudioImportHost from './ExternalAudioImportHost';
import Home from './Home';
import { createOnlineGridViewCollection } from './home/gridViewCollectionAdapters';
import { wallExitCompleted, WALL_LAYER } from './lattice/wallLayer';
import MediaCacheMigrationNotice from './MediaCacheMigrationNotice';
import TestBuildNotice from './notices/TestBuildNotice';
import AppOverlays from './overlays/AppOverlays';
import { handleOnlineMediaFailure } from './playback/handleOnlineMediaFailure';
import { notePreviewPlaying } from './playback/source/previewNotice';
import PlayerPanel from './PlayerPanel';
import { visualizerBackdropStyle } from './presentation/playerVisualizerBackdrop';
import StageSessionEmptyState from './stage/StageSessionEmptyState';
import { AnimatePresence, motion } from 'framer-motion';
import { lazy, Suspense } from 'react';

// src/components/app/AppSurface.tsx
// App 的舞台：音频元素与首页、墙、覆盖层的挂载顺序（原 App.tsx 里渲染的那一段）。

const LOCAL_TAIL_DECODE_ERROR_TOLERANCE_SEC = 3;
// Lazy so animejs (~38KB gz) stays out of the bootstrap chunk: this overlay only ever draws when the
// animation switch is on AND the mode is automix, both off by default, so it is mounted only then.
const AutomixTransitionAnimation = lazy(() => import('./overlays/AutomixTransitionAnimation'));
export const loadLattice = () => import('./lattice/Lattice');
const Lattice = lazy(loadLattice);

export type AppModel = AppFoundation & AppAudioOutput & AppThemeAndNavigation & AppAccountsAndStage & AppLibraryControllers & AppPlaybackQueue & AppPlaybackBridges & AppChromeAndGestures & AppPublishers & AppCommandPalette & AppPlaybackActions & AppWallAndHome & AppPlayerPanel & AppOverlayModels;

const AppSurface = ({ model }: { model: AppModel }) => {
    const {
        accountController, activeProviderId, addCurrentSongToLocalPlaylist, addCurrentSongToNavidromePlaylist,
        addCurrentSongToOnlinePlaylist, alwaysShowMainWindowTitlebar, appDialogsModel, appOverlaysModel, appStyle,
        audioSrc, automix, backgroundLyricHeld, blursVisualizerBackdrop, cacheSongAssets, canToggleCurrentPlayback,
        commandPalette, commandPaletteContext, createCurrentLocalPlaylist, createCurrentNavidromePlaylist,
        createCurrentOnlinePlaylist, currentSong, currentView, displayDuration, displayPlayerState, displaySong,
        duration, effectiveLoopMode, handleNextTrack, handleSwipePointerCancel, handleSwipePointerDown,
        handleSwipePointerMove, handleSwipePointerUp, handleTranscodeFallback, handleVisualSurfaceClick,
        hideFullscreenButton, holdsHomeForFlight, homeModel, idleCursorHidden, isClickThroughToggleHotspotActive,
        isDaylight, isElectronWindow, isHomeFullyHidden, isHomeSurfaceRevealed, isLyricMatchOpen,
        isMainWindowClickThroughEnabled, isNowPlayingControlDisabled, isNowPlayingStageActive, isPlayerSwipeEnabled,
        isPlayerView, isShowingTail, isTitlebarRevealed, lastAudioRecoverySourceRef, localPlaylists, loopPositionRef,
        nativeTakes, navigateBackFromLattice, navigateToHome, navigateToPlayer, nowPlayingConnectionStatus,
        onlinePlaylists, openHomeCollection, pendingResumeTimeRef, playQueue, playSong, playbackAutoSkipCountRef,
        playerCapConnectionStatus, playerPanelModel, playerState, recoverOnlinePlaybackSource, reduceLatticeMotion,
        saveCustomDualTheme, saveEditedAiDualTheme, seekMainAudio, setDuration, setIsClickThroughToggleHotspotActive,
        setPlayerState, setupAudioAnalyzer, shouldAutoPlay, shouldHidePlayerCursor, shouldMountVisualizer,
        shouldShowHomeSurface, showTransparentWindowBorder, signOutDialog, skipAfterPlaybackFailure,
        stageActiveEntryKind, stageSource, startupExperience, t, theme, togglePlay, transitionAnimation,
        transitionMode, transparentPlayerBackground, updatePrompt, usesCustomWindowChrome, visualizerAroundWall,
        visualizerRendererModel, wallHandoff, wallToolsHost, wallpaperMode
    } = model;
    // The two automix decks are identical and interchangeable. Every handler below ignores the
    // deck that is not currently active, so a track fading out in the background can never drive
    // the progress bar, the duration, the queue, or the player state.
    const renderAudioDeck = (deck: AutomixDeckId, register: (element: HTMLAudioElement | null) => void) => (
        <audio
            key={deck}
            ref={register}
            // 原生接管的这一首，元素必须空着：它有 src 就会自己播一份，两处同时出声。
            src={nativeTakes ? '' : automix.deckSrc(deck)}
            preload="auto"
            crossOrigin="anonymous"
            loop={effectiveLoopMode === 'one' && automix.activeDeck === deck}
            onLoadStart={(e) => {
                // Silent unless the invariant breaks. A deck is only ever handed the source the
                // app is currently on, so the active deck loading anything else means the ref and
                // audioSrc have drifted apart - the state that once had a deck "start playing"
                // before it had a source, and then sit fully buffered in silence because the
                // autoplay intent had already been spent on it.
                // Never during a transition. There the active deck is *meant* to be rendering the
                // warmed source while audioSrc still names the track the other deck is finishing -
                // see resolveDeckSrc, where that fallthrough is what keeps the handover seamless.
                // Ordinarily the warm load happens seconds before the deck roles move and this is
                // never reached; entering the last few seconds abruptly, by seeking, collapses the
                // two into one pass and made this cry wolf.
                // Nor with no current source to contradict: between songs audioSrc is briefly null
                // while a deck is already loading the next one, and "differs from nothing" is not
                // a drift. The state this watches for is the opposite one - a source we are on
                // that some deck never picked up.
                if (automix.isTransitionAudible() || !audioSrc) return;
                if (automix.isActiveDeck(e.currentTarget) && e.currentTarget.getAttribute('src') !== audioSrc) {
                    console.error('[Audio] the active deck is loading something other than the current source', {
                        deck,
                        loading: e.currentTarget.getAttribute('src')?.slice(-40) ?? null,
                        audioSrc: audioSrc?.slice(-40) ?? null,
                    });
                }
            }}
            onPlay={(e) => {
                if (!automix.isActiveDeck(e.currentTarget)) return;
                shouldAutoPlay.current = false;
                // The same split onTimeUpdate, onSeeked and onLoadedMetadata all make, and the two
                // handlers that were missing it: while the picture is held this deck is the track
                // ARRIVING, so its position belongs to a song whose title nobody can see yet.
                if (!isShowingTail) currentTime.set(e.currentTarget.currentTime);
                setPlayerState(PlayerState.PLAYING);
            }}
            onWaiting={(e) => noteAudioEvent('waiting', e.currentTarget)}
            onStalled={(e) => noteAudioEvent('stalled', e.currentTarget)}
            onSeeking={(e) => noteAudioEvent('seeking', e.currentTarget)}
            onRateChange={(e) => noteAudioEvent('ratechange', e.currentTarget)}
            onCanPlay={(e) => noteAudioEvent('canplay', e.currentTarget)}
            onPlaying={(e) => {
                noteAudioEvent('playing', e.currentTarget);
                if (!automix.isActiveDeck(e.currentTarget)) return;
                shouldAutoPlay.current = false;
                if (!isShowingTail) currentTime.set(e.currentTarget.currentTime);
                setupAudioAnalyzer();
                playbackAutoSkipCountRef.current = 0;
                // The source plays, so a later TTL refresh of the same media is legitimate again.
                lastAudioRecoverySourceRef.current = null;
                setPlayerState(PlayerState.PLAYING);
                // A preview clip is told of as it is heard, once per start of the song.
                notePreviewPlaying(e.currentTarget.currentSrc, t);
                // Last chance to refuse the blend, now that we know when this deck really started.
                automix.handleActiveDeckPlaying();
            }}
            onPause={(e) => {
                // A pause that flushing a fade-out made, while a new song is already being set up:
                // the transport state and play intent belong to that song now.
                if (consumeProgrammaticPause(e.currentTarget)) return;
                if (!automix.isActiveDeck(e.currentTarget)) return;
                // A deck whose source failed fires `pause` immediately AFTER `error` - Chromium
                // clears the play state as part of failing the load - and that is not the listener
                // pausing. Read as one, it dropped the transport to PAUSED and spent the autoplay
                // intent, and the transcode fallback then read that PAUSED back as "the listener
                // paused during recovery" and cancelled the resume: the track was transcoded, the
                // source re-pointed, and the deck left silent until play was pressed by hand.
                // What happens to a failed source belongs to the error path below.
                if (e.currentTarget.error) return;
                shouldAutoPlay.current = false;
                if (!e.currentTarget.ended) {
                    setPlayerState(PlayerState.PAUSED);
                }
            }}
            onTimeUpdate={(e) => {
                const audioElement = e.currentTarget;
                const isActive = automix.isActiveDeck(audioElement);
                // The clock and the transport are driven by different decks during a transition.
                // The picture still belongs to the track that is finishing, so the progress bar has
                // to be driven by ITS deck - the active one is seconds into a song nobody can see
                // the title of yet, and left on it the bar jumps to zero the moment a blend arms.
                // Only two decks exist and both render this handler, so "not active" is the tail.
                if (isShowingTail ? !isActive : isActive) {
                    if (!audioElement.paused && !audioElement.ended) currentTime.set(audioElement.currentTime);
                }
                // Everything below stays on the active deck whatever the picture is doing: player
                // state describes what the app is playing, and the transition check has to read
                // the position of the deck the NEXT blend will be planned from.
                if (!isActive) return;
                // Single loop: a wrap from the end back to the start is this track played in full,
                // cached as `onEnded` caches one (which a looping element never fires). Only on the
                // same source, so skipping to the next song near the end of this one is not a wrap.
                if (audioElement.loop) {
                    const previous = loopPositionRef.current;
                    const src = audioElement.currentSrc;
                    loopPositionRef.current = { src, time: audioElement.currentTime };
                    if (
                        previous?.src === src
                        && hasLoopedToStart(previous.time, audioElement.currentTime, audioElement.duration)
                        && audioSrc && !audioSrc.startsWith('blob:') && currentSong && !isStagePlaybackSong(currentSong)
                    ) {
                        cacheSongAssets();
                    }
                } else if (loopPositionRef.current) {
                    loopPositionRef.current = null;
                }
                // A track that is not moving is not approaching anything. `pause()` fires one last
                // timeupdate of its own, and a mid-blend pause cancels onto THIS deck before pausing
                // it - so that stray tick arrives with the deck already active and the track sitting
                // past its handover point, and arms the blend the listener just stopped, advancing
                // the queue behind it. Visible in the log as a cancel and a `playSong` in the same
                // second, or as a lone `plain cut` line when the track was too near its end to fade.
                if (audioElement.paused) return;
                // A pause that is still fading out has not reached the element yet, so this deck
                // reads as playing. Letting it through would flip the transport back to PLAYING for
                // the length of the fade and could arm a blend the listener just stopped.
                if (playbackFade.isFadingOut()) return;
                if (!audioElement.ended) setPlayerState(PlayerState.PLAYING);
                automix.checkTransitionPoint(audioElement.currentTime);
            }}
            onSeeked={(e) => {
                noteAudioEvent('seeked', e.currentTarget);
                // Same split as onTimeUpdate: whichever deck the bar is showing is the one a seek
                // on it has to be reflected from.
                const isActive = automix.isActiveDeck(e.currentTarget);
                if (isShowingTail ? !isActive : isActive) currentTime.set(e.currentTarget.currentTime);
            }}
            // Buffer progress debug helper. Uncomment to inspect how much of
            // the current source the browser has actually buffered.
            // onProgress={(e) => {
            //     const audioElement = e.currentTarget;
            //     const buffered = audioElement.buffered;
            //     const source = audioElement.currentSrc || audioSrc;
            //     if (!source || buffered.length === 0 || !Number.isFinite(audioElement.duration) || audioElement.duration <= 0) {
            //         return;
            //     }
            //
            //     const bufferedEnd = buffered.end(buffered.length - 1);
            //     const bufferedPercent = Math.max(
            //         0,
            //         Math.min(100, Math.round((bufferedEnd / audioElement.duration) * 100))
            //     );
            //     if (lastBufferedPercentLogRef.current !== bufferedPercent) {
            //         lastBufferedPercentLogRef.current = bufferedPercent;
            //         console.log('[Audio] buffered percent', {
            //             src: source,
            //             currentTime: audioElement.currentTime,
            //             bufferedEnd,
            //             duration: audioElement.duration,
            //             bufferedPercent,
            //         });
            //     }
            // }}
            onEnded={(e) => {
                // A track finishing in the background has already handed the queue over.
                if (!automix.isActiveDeck(e.currentTarget)) {
                    automix.handleTailEnded();
                    return;
                }

                // Cache if playing fully
                if (audioSrc && !audioSrc.startsWith('blob:') && currentSong && !isStagePlaybackSong(currentSong)) {
                    cacheSongAssets();
                }

                // The track ran out while a pause was still fading: finish that pause instead of
                // advancing, or the next song starts under a player the listener just paused.
                if (playbackFade.isFadingOut()) {
                    playbackFade.flush();
                    return;
                }

                // If single loop is active, native loop handles it.
                // If not, we handle queue logic.
                if (effectiveLoopMode !== 'one') {
                    void handleNextTrack({ allowStopOnMissing: true, shouldNavigateToPlayer: false });
                }
            }}
            onLoadedMetadata={(e) => {
                const audioElement = e.currentTarget;
                if (!automix.isActiveDeck(audioElement)) return;
                setDuration(audioElement.duration);
                // While the picture is held, this deck is the track ARRIVING: its length and its
                // position belong to a song the listener cannot see yet, and writing either here
                // would snap the bar to zero mid-blend. `duration` above is still set because the
                // transition planner needs it; only the visible clock is left alone.
                if (isShowingTail) return;

                const pendingResumeTime = pendingResumeTimeRef.current;
                if (pendingResumeTime !== null) {
                    const safeDuration = Number.isFinite(audioElement.duration) && audioElement.duration > 0
                        ? Math.max(audioElement.duration - 0.25, 0)
                        : pendingResumeTime;
                    const nextTime = Math.min(pendingResumeTime, safeDuration);
                    audioElement.currentTime = nextTime;
                    currentTime.set(nextTime);
                    pendingResumeTimeRef.current = null;
                    return;
                }

                currentTime.set(0); // Ensure currentTime is reset when new audio loads
            }}
            onError={(e) => {
                noteAudioEvent('error', e.currentTarget);
                const audioElement = e.currentTarget;
                const isActiveDeck = automix.isActiveDeck(audioElement);
                const reportedDuration = Number.isFinite(audioElement.duration) && audioElement.duration > 0
                    ? audioElement.duration
                    : duration;
                const isLocalTailDecodeError = Boolean(
                    isActiveDeck &&
                    audioElement.error?.code === MediaError.MEDIA_ERR_DECODE &&
                    isLocalPlaybackSong(currentSong) &&
                    Number.isFinite(reportedDuration) &&
                    reportedDuration > 0 &&
                    audioElement.currentTime > 0 &&
                    reportedDuration - audioElement.currentTime <= LOCAL_TAIL_DECODE_ERROR_TOLERANCE_SEC
                );

                if (isLocalTailDecodeError) {
                    currentTime.set(Math.max(audioElement.currentTime, reportedDuration));
                    setPlayerState(PlayerState.IDLE);

                    if (effectiveLoopMode === 'one') {
                        audioElement.currentTime = 0;
                        audioElement.load();
                        const replayPromise = audioElement.play();
                        if (replayPromise !== undefined) {
                            replayPromise.catch(() => {
                                setPlayerState(PlayerState.PAUSED);
                            });
                        }
                        return;
                    }

                    void handleNextTrack({ allowStopOnMissing: true, shouldNavigateToPlayer: false });
                    return;
                }

                // A song that was loading to play has failed: it stops showing as playing while the
                // fallback, the address refresh or the skip below decide what comes next.
                if (isActiveDeck) endLoadingToPlay();

                if (handleTranscodeFallback(audioElement)) return;

                if (!isActiveDeck) {
                    automix.handleTailEnded();
                    return;
                }

                if (!audioSrc) {
                    return;
                }

                const failedSrc = audioElement.currentSrc || audioSrc;
                // Online sources (cached blobs included) refresh once and report a structured reason.
                if (currentSong && failedSrc && !isLocalPlaybackSong(currentSong) && !isNavidromePlaybackSong(currentSong) && !isStagePlaybackSong(currentSong)) {
                    void handleOnlineMediaFailure({
                        audioElement, failedSrc, song: currentSong, recoverOnlinePlaybackSource, skipAfterPlaybackFailure,
                        autoplay: (!audioElement.paused && !audioElement.ended) || playerState === PlayerState.PLAYING || shouldAutoPlay.current,
                    });
                    return;
                }

                skipAfterPlaybackFailure();
            }}
        />
    );
    return (
        <AppShell
            appStyle={appStyle}
            isElectronWindow={isElectronWindow}
            hideFullscreenButton={hideFullscreenButton}
            usesCustomWindowChrome={usesCustomWindowChrome}
            useCustomWindowRadius={isElectronWindow && transparentPlayerBackground && !wallpaperMode}
            showTransparentWindowBorder={showTransparentWindowBorder}
            isPlayerView={isPlayerView}
            isTitlebarRevealed={isTitlebarRevealed}
            alwaysShowMainWindowTitlebar={alwaysShowMainWindowTitlebar}
            isMainWindowClickThroughEnabled={isMainWindowClickThroughEnabled}
            showMainWindowClickThroughToggle={isMainWindowClickThroughEnabled ? isClickThroughToggleHotspotActive : isTitlebarRevealed}
            isDaylight={isDaylight}
            theme={theme}
            onToggleMainWindowClickThrough={() => {
                const nextEnabled = !isMainWindowClickThroughEnabled;
                if (!nextEnabled) {
                    setIsClickThroughToggleHotspotActive(false);
                }
                void window.electron?.setMainWindowClickThroughEnabled?.(nextEnabled);
                if (!nextEnabled) {
                    void window.electron?.setMainWindowClickThroughUnlockHover?.(false);
                }
            }}
            audioElement={<>
                {renderAudioDeck('A', automix.registerDeckA)}
                {renderAudioDeck('B', automix.registerDeckB)}
            </>}
        >

            {/* 首页层、Lattice 与两面墙共用的右下角工具按钮（WallToolsDock：交接时按钮节点不重建）。 */}
            <WallToolsDockHost host={wallToolsHost}>
            {/* Home Mount Point */}
            <div
                className="absolute inset-0 z-10"
                data-wall-handoff-layer="home"
                style={{
                    pointerEvents: shouldShowHomeSurface && !wallHandoff.active ? 'auto' : 'none',
                    visibility: isHomeSurfaceRevealed ? 'visible' : 'hidden',
                    transition: isHomeSurfaceRevealed
                        ? 'visibility 0s linear 0s'
                        : 'visibility 0s linear 0.25s',
                    display: isHomeFullyHidden && !wallHandoff.keepsHome ? 'none' : 'block',
                }}
            >
                <motion.div
                    className="absolute inset-0"
                    initial={false}
                    animate={{ opacity: isHomeSurfaceRevealed ? 1 : 0 }}
                    // 交接期间不跑整层淡入淡出：进 Lattice 时首页墙保持完全显示，回来时下面的墙要立刻是实的。
                    // Come up from the wall (it has not left the screen yet), Home is shown at
                    // once too: the wall is over it, and is what fades. A fade of both at a time
                    // lets what is under them through.
                    transition={{ duration: wallHandoff.active || !visualizerAroundWall.hasWallLeft ? 0 : 0.25, ease: 'easeInOut' }}
                >
                    {currentView === 'home' || currentView === 'player' || wallHandoff.keepsHome || holdsHomeForFlight ? (
                        <Home
                            model={homeModel}
                            isHomeFullyHidden={isHomeFullyHidden && !wallHandoff.keepsHome}
                            isInteractive={shouldShowHomeSurface}
                        />
                    ) : null}
                </motion.div>
            </div>

            <AnimatePresence
                initial={false}
                onExitComplete={wallExitCompleted}
            >
                {(currentView === 'lattice' || wallHandoff.keepsLattice) && (
                    <motion.div
                        key="lattice"
                        className={`absolute inset-0 z-10 ${wallHandoff.active ? 'pointer-events-none' : 'pointer-events-auto'}`}
                        data-wall-handoff-layer="lattice"
                        initial={wallHandoff.latticeOpacity && wallHandoff.latticeOpacity.initial !== false
                            ? { opacity: wallHandoff.latticeOpacity.initial }
                            : false}
                        animate={{ opacity: wallHandoff.latticeOpacity?.animate ?? 1 }}
                        // 交接期间：淡入淡出交叉用它自己的时长；翻牌交接时 Lattice 在翻完那一刻卸载，不再淡出。
                        // Otherwise how long the layer takes to leave depends on what the wall is left
                        // for, which is known when it leaves and not before (wallLayer.ts).
                        variants={WALL_LAYER}
                        custom={reduceLatticeMotion}
                        exit={wallHandoff.active ? { opacity: 0 } : 'gone'}
                        transition={{
                            duration: wallHandoff.latticeOpacity
                                ? wallHandoff.fadeSeconds
                                : wallHandoff.active || reduceLatticeMotion ? 0 : 0.62,
                            ease: wallHandoff.latticeOpacity ? 'easeInOut' : 'easeIn',
                        }}
                    >
                        <Suspense fallback={wallHandoff.active ? null : <div className="absolute inset-0 bg-[#070707]" />}>
                            <Lattice
                                controls={{ playback: commandPaletteContext.playback, loopMode: effectiveLoopMode,
                                    invokeCommandById: commandPalette.invokeCommandById, canInvokeCommandById: commandPalette.canInvokeCommandById,
                                    isStageActive: isNowPlayingStageActive, disabled: isNowPlayingControlDisabled }}
                                lyrics={commandPaletteContext.shared.lyrics}
                                lyricSource={visualizerRendererModel}
                                currentSong={displaySong}
                                playerState={displayPlayerState}
                                currentTime={currentTime}
                                lyricCurrentTime={lyricCurrentTime}
                                playbackDuration={displayDuration}
                                canTogglePlayback={canToggleCurrentPlayback}
                                queue={playQueue}
                                isDaylight={isDaylight}
                                onBack={navigateBackFromLattice}
                                onGoHome={navigateToHome}
                                onOpenPlayer={navigateToPlayer}
                                onPlaySong={(song, queue) => {
                                    void playSong(song, queue, false, { shouldNavigateToPlayer: false });
                                }}
                                onTogglePlayback={togglePlay}
                                onSeek={seekMainAudio}
                                // For a wall opened from the explore tab: the page that tab shows, named as
                                // Grid3D names it, and a card's page opened as the tab opens it.
                                exploreProviderId={activeProviderId}
                                exploreAccountId={String(homeModel.surfaceProps.user?.id ?? '')}
                                onOpenCollection={collection => openHomeCollection(
                                    createOnlineGridViewCollection(collection, activeProviderId),
                                )}
                            />
                        </Suspense>
                    </motion.div>
                )}
            </AnimatePresence>
            </WallToolsDockHost>

            {/* --- VISUALIZER (Background Layer & Main Click Target) --- */}
            {/* 指针隐藏跟着控制栏的空闲时钟走，不另起一套计时：控件收起时页面上已经没有可点的东西，
                所以指针一起消失；任何鼠标移动都会同时唤回两者。class 只挂在这个视觉层容器上，
                弹窗、命令面板、浮动控件和标题栏按钮都是它的兄弟节点，不在作用域内。 */}
            {/* The visualizer is away while the wall covers it. When it is taken down and put
                back, and when it comes up in a fade of this layer, is wallLayer.ts's. */}
            <div
                className={`absolute inset-0 z-0${(shouldHidePlayerCursor || idleCursorHidden) ? ' cursor-auto-hidden' : ''}${visualizerAroundWall.fadesIn ? ' visualizer-comes-up' : ''}`}
                data-testid="player-visual-surface"
                // 歌词扁平化开关的作用域：CSS 只在这一层里关发光与渐变，弹窗、命令面板这些
                // 兄弟节点不受影响（见 index.css 的 [data-lyric-flat] 段）。
                data-folia-lyric-surface="1"
                data-library-backdrop-blur={blursVisualizerBackdrop || undefined}
                style={{
                    ...visualizerBackdropStyle(blursVisualizerBackdrop),
                    // 横向留给切歌手势：不让浏览器拿去平移或划选歌词，纵向照旧。
                    ...(isPlayerSwipeEnabled ? { touchAction: 'pan-y' } : {}),
                }}
                onClick={handleVisualSurfaceClick}
                onPointerDown={handleSwipePointerDown}
                onPointerMove={handleSwipePointerMove}
                onPointerUp={handleSwipePointerUp}
                onPointerCancel={handleSwipePointerCancel}
            >
                <PlayerBottomBarLayoutContext.Provider value={currentView === 'player'}>
                    {shouldMountVisualizer && <VisualizerRenderer {...visualizerRendererModel} animateStyleSwitch />}
                </PlayerBottomBarLayoutContext.Provider>
            </div>

            <StageSessionEmptyState
                stageSource={stageSource}
                stageActiveEntryKind={stageActiveEntryKind}
                nowPlayingConnectionStatus={nowPlayingConnectionStatus}
                playerCapConnectionStatus={playerCapConnectionStatus}
            />

            <AppOverlays model={appOverlaysModel} />

            {/* Folium `app.overlay` stage layers: above the whole app, inert unless a layer opts in. */}
            <FoliumStageLayerSlot
                slot="app.overlay"
                theme={theme}
                isDaylight={isDaylight}
                paused={displayPlayerState !== PlayerState.PLAYING || backgroundLyricHeld}
                className="fixed inset-0 pointer-events-none z-[1000]"
            />

            {/* Not in the overlays model: it takes no state from this file and no click from anyone.
                Mounted whenever its own switch is on, so the lazy animejs chunk loads only when it is
                wanted; the fallback is empty because it draws nothing until a cue arrives anyway.

                Its own switch, not shared with the card's border. It used to hide itself wherever the
                card was up, which on the lyrics page - the one people watch - meant the ring was never
                seen again after the card shipped. Two pictures of one blend is now something the
                listener asks for rather than something this file rules out. */}
            {transitionAnimation && transitionMode === 'automix' && (
                <Suspense fallback={null}>
                    <AutomixTransitionAnimation theme={theme} isDaylight={isDaylight} />
                </Suspense>
            )}

            {/* 旧版 automix 模型留在用户自选目录里时，问一次要不要删；没有就什么都不画。 */}
            <LegacyModelsPrompt isDaylight={isDaylight} />

            {/* 分析模型不随包：启动后问一次要不要从 CDN 取。桌面版随包带着的那份还在时不会问。 */}
            <AnalysisModelsPrompt isDaylight={isDaylight} />

            {/* 思索教程。常驻的只有悬停探测和提示胶囊；教程层自己走 React.lazy，
                animejs 不进 bootstrap chunk。 */}
            <PonderHost theme={theme} isDaylight={isDaylight} />

            {currentView === 'player' && !(isLyricMatchOpen && isLocalPlaybackSong(currentSong)) && (
                <PlayerPanel model={playerPanelModel} />
            )}

            <ThemeQuickEditorHost onSaveAiTheme={saveEditedAiDualTheme} onSaveCustomTheme={saveCustomDualTheme} />

            {/* Mounted here rather than inside the panel that used to own it: the picker answers a
                question about the current song, and a shortcut has to reach it with the panel shut. */}
            <AddToPlaylistHost
                isDaylight={isDaylight}
                localPlaylists={localPlaylists}
                onlinePlaylists={onlinePlaylists}
                onAddCurrentSongToLocalPlaylist={addCurrentSongToLocalPlaylist}
                onCreateCurrentLocalPlaylist={createCurrentLocalPlaylist}
                onAddCurrentSongToOnlinePlaylist={addCurrentSongToOnlinePlaylist}
                onCreateCurrentOnlinePlaylist={createCurrentOnlinePlaylist}
                onAddCurrentSongToNavidromePlaylist={addCurrentSongToNavidromePlaylist}
                onCreateCurrentNavidromePlaylist={createCurrentNavidromePlaylist}
            />

            {/* 从别的应用「用 Folia 打开」音频：问「是否导入 / 导入到哪个歌单」。
                非安卓或没有这个插件时它自己渲染成 null，桌面端与 Web 不受影响。 */}
            <ExternalAudioImportHost isDaylight={isDaylight} />

            <CommandPalette
                activeIndex={commandPalette.activeIndex}
                activePreview={commandPalette.activePreview}
                activeCommand={commandPalette.activeCommand}
                availableCommands={commandPalette.availableCommands}
                context={commandPaletteContext}
                isDaylight={isDaylight}
                isComposing={commandPalette.isComposing}
                isExecuting={commandPalette.isExecuting}
                isOpen={commandPalette.isOpen}
                matches={commandPalette.matches}
                pinnedCommands={commandPalette.pinnedCommands}
                query={commandPalette.query}
                theme={theme}
                onActiveCommandChange={commandPalette.setActiveCommand}
                onActiveIndexChange={commandPalette.setActiveIndex}
                onClose={commandPalette.close}
                onCompositionEnd={(value) => {
                    commandPalette.setIsComposing(false);
                    commandPalette.commitQuery(value);
                }}
                onCompositionStart={() => commandPalette.setIsComposing(true)}
                onExecuteActive={commandPalette.executeActive}
                onExecuteMatch={commandPalette.executeMatch}
                onExecutePinnedCommand={commandPalette.executePinnedCommand}
                onQueryChange={commandPalette.setQuery}
                onQueryCommit={commandPalette.commitQuery}
            />

            <AppDialogs model={appDialogsModel} />
            {/* 测试版提醒：不是 main / release/* 构建的包，启动时说一句它是什么来路。 */}
            <TestBuildNotice />
            {/* 启动那一次：把上一版的媒体缓存搬进私有目录，搬的时候给一条提示。 */}
            <MediaCacheMigrationNotice />
            <FreeSoftwareNoticeModal
                isOpen={startupExperience.isFreeSoftwareNoticeOpen}
                isDaylight={isDaylight}
                onClose={startupExperience.closeFreeSoftwareNotice}
            />
            {/*
                首启最后一步：把首页那个登录按钮送到脸上来。
                App.tsx 拆成一层层装配之后这一处挂了漏 —— 状态和动作用 useStartupExperienceGate
                早就备好了，只有 JSX 没接上，于是这一层对用户等于不存在。
                放在登录窗口之前：它点下去正是 openLoginWindow，窗口要能盖在它上面。
            */}
            <SignInSpotlight
                isOpen={startupExperience.isSignInSpotlightOpen}
                account={accountController}
                onPressed={startupExperience.pressSignInSpotlight}
            />
            {/* 登录窗口挂在最外层：每个资料库界面（网格、Bravais、文本）都用 openLoginWindow 打开同一个窗口。 */}
            <LoginHost account={accountController} />
            {signOutDialog}
            <ReleaseNotesDialog
                isOpen={startupExperience.isReleaseNotesOpen}
                isDaylight={isDaylight}
                onClose={startupExperience.closeReleaseNotes}
            />
            <UserGuideModal theme={theme} />
            <AppUpdatePromptDialog
                isOpen={updatePrompt.isPromptOpen}
                isDaylight={isDaylight}
                onClose={updatePrompt.closePrompt}
                onIgnoreVersion={updatePrompt.ignoreVersion}
            />
            <PlaybackEntryViewPrompt theme={theme} />
            <LatticeFmNotice />
        </AppShell>
    );
};

export default AppSurface;
