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
import type { AppPlayerPanel } from './useAppPlayerPanel';
import { useLibraryOcclusionSettled } from '../../../hooks/useLibraryOcclusionSettled';
import { selectLibraryOccludesPlayer, selectLibraryPlayerBackdrop, useLibraryPlayerOcclusionStore } from '../../../stores/useLibraryPlayerOcclusionStore';
import { useWallHandoffStore } from '../../../stores/useWallHandoffStore';
import { useMorphKeepsHost } from '../../collectionFlight';
import { useAppDialogsModel } from '../dialogs/useAppDialogsModel';
import { useSettingsDialogModel } from '../dialogs/useSettingsDialogModel';
import { useAppOverlaysModel } from '../overlays/useAppOverlaysModel';
import { buildHomeSurfacePresentation } from '../presentation/buildHomeSurfacePresentation';
import { resolveVisualizerBackdropBlur } from '../presentation/playerVisualizerBackdrop';
import { shouldMountPlayerVisualizer } from '../presentation/playerVisualizerMount';
import { useWallHandoffDirector } from '../presentation/wallHandoffDirector';
import { resolveWallHandoffPresentation } from '../presentation/wallHandoffPresentation';
import { useEffect } from 'react';
import { loadLattice } from '../AppSurface';

// src/components/app/appWiring/useAppOverlayModels.ts
// 覆盖层与设置对话框模型，以及首页层、visualizer 的显隐。

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
    & AppWallAndHome
    & AppPlayerPanel;

export const useAppOverlayModels = (model: Input) => {
    const {
        canToggleCurrentPlayback, clearPersistedStagePlaybackCache, clearStagePlaybackSession, closeLyricMatch,
        closeSearchView, commandPalette, commandPaletteContext, currentView, devDebugSnapshot, effectiveLoopMode,
        handleAudioOutputDeviceChange, handleChangeReplayGainMode, handleLike, handleLyricMatchComplete,
        handleLyricMatchPureMusicMarkChanged, handleNaviLyricMatchComplete, handleNextTrack,
        handleOnlineLyricMatchComplete, handlePrevTrack, handleSaveLyricFilterPattern, handleSearchLoadMore,
        handleSearchOverlaySubmit, handleSearchResultAddToQueue, handleSearchResultAlbumOpen,
        handleSearchResultArtistOpen, handleSearchResultCollectionOpen, handleSearchResultPlay,
        handleToggleNavidromeEnabled,
        handleUnavailableReplacementConfirm, isLyricMatchOpen, isNowPlayingControlDisabled,
        isNowPlayingControlDisabledRef, isNowPlayingStageActive, isPanelOpen, isSettingsModalOpen,
        leaveStagePlayback, loadCurrentSongLyricPreview, loadStageSessionIntoPlayback, localSongs, lyricApiStatus,
        navigateFromPlayerCapsule, navigateToPlayer, nowPlayingConnectionStatus, obsBrowserSourceStatus,
        openSongCardPanel, pendingUnavailableReplacement, playerCapConnectionStatus, playerCapPlayers,
        publishStagePlayerPlaybackUpdate, refreshObsBrowserSourceStatus, resolveSearchResultDisplay, seekMainAudio,
        setIsHomeFullyHidden, setLyricApiEnabled, setPendingUnavailableReplacement, setStageStatus,
        shouldHidePlayerProgressBar, shuffleQueue, stageActiveEntryKind, stageIsNextUp, stageLyricsClockRef,
        stageNextUp, stageSource, stageStatus, stageTrackPillOnScreen, syncStageLyricsClock, theme, themeController,
        themeParkSeedTheme, toggleLoop, togglePlay, toggleTransparentModeWithHandoff, visualizerAroundWall
    } = model;
    const appOverlaysModel = useAppOverlaysModel({
        theme,
        closeSearchView,
        handleSearchOverlaySubmit,
        handleSearchLoadMore,
        handleSearchResultPlay,
        handleSearchResultAddToQueue,
        handleSearchResultArtistOpen,
        handleSearchResultAlbumOpen,
        handleSearchResultCollectionOpen,
        resolveSearchResultDisplay,
        devDebugSnapshot,
        effectiveLoopMode,
        canToggleCurrentPlayback,
        isNowPlayingControlDisabled,
        stageActiveEntryKind,
        syncStageLyricsClock,
        stageLyricsClockRef,
        togglePlay,
        toggleLoop,
        navigateToPlayer,
        navigateFromPlayerCapsule,
        shouldHidePlayerProgressBar,
        onSeekMainAudio: seekMainAudio,
        onStagePlayerSeek: publishStagePlayerPlaybackUpdate,
        isNowPlayingStageActive,
        handlePrevTrack,
        handleNextTrack,
        shuffleQueue,
        handleLike,
        isDisplaySongLiked: commandPaletteContext.playback.isSongLiked,
        invokeCommandById: commandPalette.invokeCommandById,
        canInvokeCommandById: commandPalette.canInvokeCommandById,
        stageNextUp,
        stageIsNextUp,
        stageTrackPillOnScreen,
        openSongCardPanel,
        hasLocalSongs: localSongs.length > 0,
    });
    const settingsDialog = useSettingsDialogModel({
        themeController,
        themeParkInitialTheme: themeParkSeedTheme,
        onToggleNavidrome: handleToggleNavidromeEnabled,
        loadLyricFilterPreview: loadCurrentSongLyricPreview,
        onSaveLyricFilterPattern: handleSaveLyricFilterPattern,
        stageStatus,
        stageSource,
        setStageStatus,
        leaveStagePlayback,
        clearStagePlaybackSession,
        clearPersistedStagePlaybackCache,
        loadStageSessionIntoPlayback,
        nowPlayingConnectionStatus,
        playerCapConnectionStatus,
        playerCapPlayers,
        obsBrowserSourceStatus,
        refreshObsBrowserSourceStatus,
        lyricApiStatus,
        setLyricApiEnabled,
        onAudioOutputDeviceChange: handleAudioOutputDeviceChange,
        onReplayGainModeChange: handleChangeReplayGainMode,
        onToggleTransparentPlayerBackground: toggleTransparentModeWithHandoff,
    });
    const appDialogsModel = useAppDialogsModel({
        isLyricMatchOpen,
        localSongs,
        closeLyricMatch,
        handleLyricMatchComplete,
        handleLyricMatchPureMusicMarkChanged,
        handleNaviLyricMatchComplete,
        handleOnlineLyricMatchComplete,
        pendingUnavailableReplacement,
        setPendingUnavailableReplacement,
        handleUnavailableReplacementConfirm,
        settingsDialog,
    });

    useEffect(() => {
        isNowPlayingControlDisabledRef.current = isNowPlayingControlDisabled;
    }, [isNowPlayingControlDisabled]);

    // Buffer progress debug helper reset. Keep commented out unless
    // buffered percent logging is explicitly needed during troubleshooting.
    // useEffect(() => {
    //     lastBufferedPercentLogRef.current = null;
    // }, [audioSrc]);

    // Optimize background layout cost: completely hide home surface when player is active.
    // Keep the mount state separate from opacity so transparent player mode never reveals Home during delayed unmount.
    // 翻牌交接（资料库墙 ↔ Lattice，设计稿 §7「进入队列」）：director 在视图切换的同一刻开会话，这里按会话决定首页层 /
    // Lattice 要不要留着、visualizer 要不要垫着。grid / TUI 没有会话，下面的一切照旧。
    useWallHandoffDirector();
    const wallHandoffSession = useWallHandoffStore(state => state.session);
    const wallHandoff = resolveWallHandoffPresentation(wallHandoffSession);
    // 首页墙能交接（bravais 的 stage 挂着）时空闲里先把 Lattice 的 chunk 取下来：第一次进 Lattice 也不用等它加载才开翻。
    const hasHomeWallPeer = useWallHandoffStore(state => state.homePeer !== null);
    useEffect(() => {
        if (!hasHomeWallPeer) return undefined;
        const timer = setTimeout(() => { void loadLattice(); }, 1500);
        return () => clearTimeout(timer);
    }, [hasHomeWallPeer]);
    const { shouldKeepHomeMounted, shouldShowHomeSurface, shouldRevealHomeSurface } = buildHomeSurfacePresentation({
        currentView,
        isSettingsModalOpen,
        isPanelOpen,
        keepsHomeForHandoff: wallHandoff.keepsHome,
    });
    // Home is taken down for the wall. A collection's page that was opened from the wall is left
    // with its cover flying back to the wall's tile (collectionOpenMorph): Home, which holds that
    // page and the flight's overlay, then stays under the wall until the flight is over: shown as
    // it was, for the wall fades in over it.
    const holdsHomeForFlight = useMorphKeepsHost(currentView === 'lattice');
    const isHomeSurfaceRevealed = shouldRevealHomeSurface || holdsHomeForFlight;
    useEffect(() => {
        if (shouldKeepHomeMounted || holdsHomeForFlight) {
            setIsHomeFullyHidden(false);
        } else {
            // Wait for the 300ms opacity transition to finish before applying display: none
            const timer = setTimeout(() => setIsHomeFullyHidden(true), 350);
            return () => clearTimeout(timer);
        }
    }, [shouldKeepHomeMounted, holdsHomeForFlight]);
    // 资料库 stage 完全遮挡播放页时（bravais 实色档，stage 自己报告）也卸载 visualizer：首页淡入结束后才卸载，
    // 首页一被面板盖住 / 离开就立即重挂；设置弹窗盖着时首页仍显示在遮罩下面，不重挂。App 只认报告，不认识 suite。
    const libraryOccludesPlayer = useLibraryPlayerOcclusionStore(selectLibraryOccludesPlayer);
    const hasLibraryOcclusionSettled = useLibraryOcclusionSettled(shouldRevealHomeSurface && libraryOccludesPlayer);
    const shouldMountVisualizer = shouldMountPlayerVisualizer({
        currentView,
        // Around a wall, the visualizer is taken down and put back by wallLayer.ts's rule.
        hasLatticeExited: visualizerAroundWall.isUp,
        shouldRevealHomeSurface,
        libraryOccludesPlayer,
        hasLibraryOcclusionSettled,
        handoffKeepsVisualizer: wallHandoff.keepsVisualizer,
    });
    // 首页墙透出来的 visualizer 加模糊（bravais「墙后的画面」，stage 报告；只在首页墙露着时）。
    const libraryBackdropBlur = useLibraryPlayerOcclusionStore(state => selectLibraryPlayerBackdrop(state).blur);
    const blursVisualizerBackdrop = resolveVisualizerBackdropBlur({ shouldRevealHomeSurface, backdropBlur: libraryBackdropBlur });

    return {
        ...model,
        appDialogsModel, appOverlaysModel, blursVisualizerBackdrop, holdsHomeForFlight, isHomeSurfaceRevealed,
        shouldMountVisualizer, shouldShowHomeSurface, wallHandoff
    };
};

export type AppOverlayModels = ReturnType<typeof useAppOverlayModels>;
