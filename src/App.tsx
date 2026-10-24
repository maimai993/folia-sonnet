import { useState, useRef, useEffect, useCallback, useMemo, lazy, Suspense } from 'react';
import { AnimatePresence, motion, useMotionValueEvent } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { ChevronLeft } from 'lucide-react';
import { loadCachedOrFetchCover } from './services/coverCache';
import VisualizerRenderer from './components/visualizer/VisualizerRenderer';
import CommandPalette from './components/command-palette/CommandPalette';
import AddToPlaylistHost from './components/app/AddToPlaylistHost';
import ExternalAudioImportHost from './components/app/ExternalAudioImportHost';
import { useCommandPalette } from './components/command-palette/useCommandPalette';
import { useCommandPaletteContext } from './hooks/useCommandPaletteContext';
import { useReducedMotionFor } from './hooks/useReducedMotionFor';
import AppShell from './components/app/AppShell';
import Home from './components/app/Home';
import PlayerPanel from './components/app/PlayerPanel';
import ThemeQuickEditorHost from './components/panelTab/ThemeQuickEditor';
import AppDialogs from './components/app/dialogs/AppDialogs';
import MediaCacheMigrationNotice from './components/app/MediaCacheMigrationNotice';
import { useProviderSignOut } from './components/app/dialogs/useProviderSignOut';
import LoginHost from './components/login/LoginHost';
import { useSettingsDialogModel } from './components/app/dialogs/useSettingsDialogModel';
import AppOverlays from './components/app/overlays/AppOverlays';
import PonderHost from './components/ponder/PonderHost';
// Lazy so animejs (~38KB gz) stays out of the bootstrap chunk: this overlay only ever draws when the
// animation switch is on AND the mode is automix, both off by default, so it is mounted only then.
const AutomixTransitionAnimation = lazy(() => import('./components/app/overlays/AutomixTransitionAnimation'));
const loadLattice = () => import('./components/app/lattice/Lattice');
const Lattice = lazy(loadLattice);
import { useVisualizerAroundWall, wallExitCompleted, WALL_LAYER } from './components/app/lattice/wallLayer';
import { useMorphKeepsHost } from './components/collectionFlight';
import { UserGuideModal } from './components/modal/UserGuideModal';
import ReleaseNotesDialog from './components/modal/ReleaseNotesDialog';
import FreeSoftwareNoticeModal from './components/modal/FreeSoftwareNoticeModal';
import LegacyModelsPrompt from './components/modal/LegacyModelsPrompt';
import AnalysisModelsPrompt from './components/modal/AnalysisModelsPrompt';
import { PlaybackEntryViewPrompt } from './components/modal/playback-entry-view/PlaybackEntryViewPrompt';
import { LatticeFmNotice } from './components/modal/playback-entry-view/LatticeFmNotice';
import AppUpdatePromptDialog from './components/modal/AppUpdatePromptDialog';
import { useStartupExperienceGate } from './hooks/useStartupExperienceGate';
import { useStartupUpdatePrompt } from './hooks/useStartupUpdatePrompt';
import { useAppDialogsModel } from './components/app/dialogs/useAppDialogsModel';
import { useHomeModel } from './components/app/home/useHomeModel';
import { createLyricFilterPatternSaver } from './components/app/home/createLyricFilterPatternSaver';
import { nextLyricStaffAbsorbMode, nextLyricStaffPolicy } from './utils/lyrics/staffCreditsPolicy';
import { createPanelNavigation } from './components/app/navigation/createPanelNavigation';
import { usePlayingSongLocatorStore } from './stores/usePlayingSongLocatorStore';
import { createOnlineGridViewCollection, type GridViewCollectionDescriptor } from './components/app/home/gridViewCollectionAdapters';
import { buildAppStyle } from './components/app/presentation/buildAppStyle';
import { buildDebugSnapshot } from './components/app/presentation/buildDebugSnapshot';
import { buildHomeSurfacePresentation } from './components/app/presentation/buildHomeSurfacePresentation';
import { shouldMountPlayerVisualizer } from './components/app/presentation/playerVisualizerMount';
import { resolveWallHandoffPresentation } from './components/app/presentation/wallHandoffPresentation';
import { useWallHandoffDirector } from './components/app/presentation/wallHandoffDirector';
import WallToolsDockHost from './components/wall/WallToolsDock';
import { buildPlayerViewFlags } from './components/app/presentation/buildPlayerViewFlags';
import { buildVisualizerTheme } from './components/app/presentation/buildVisualizerTheme';
import { createCoverUrlResolver } from './utils/coverUrlResolver';
import { createLyricsSetter } from './components/app/playback/createLyricsSetter';
import { createLyricSegmentationActions } from './components/app/playback/createLyricSegmentationActions';
import { useLyricWordSegmentation } from './hooks/useLyricWordSegmentation';
import { useIcuFoliaSegmentation } from './hooks/useIcuFoliaSegmentation';
import { handleOnlineMediaFailure } from './components/app/playback/handleOnlineMediaFailure';
import { createOnlineRecoveryController } from './components/app/playback/restore/createOnlineRecoveryController';
import { notePreviewPlaying } from './components/app/playback/source/previewNotice';
import { persistPlaybackCache } from './components/app/playback/persistPlaybackCache';
import { useAppOverlaysModel } from './components/app/overlays/useAppOverlaysModel';
import { resolveNextUpTrack } from './components/app/overlays/now-playing-toast/resolveNextUpTrack';
import { shouldShowNowPlayingToast } from './components/app/overlays/now-playing-toast/nowPlayingToastVisibility';
import { isWallLibrarySuite, useActiveLibrarySuiteId } from './library/app/librarySuiteChoice';
import {
    createSearchAlbumCollection,
    createSearchArtistCollection,
} from './components/app/search/searchCollectionAdapters';
import { usePlayerPanelModel } from './components/app/player-panel/usePlayerPanelModel';
import { createQueueMutations } from './components/app/player-panel/createQueueMutations';
import { Album, Artist, LyricData, Theme, PlayerState, SongResult, ReplayGainMode, StatusMessage, PlaybackContext, StageLoopMode, UnifiedSong } from './types';
import type { LocalSong } from './types';
import { getLocalSongArrayBuffer } from './services/localMusicService';
import { registerLocalTrackFileReader } from './services/analysis/trackAudio';
import type { MediaId, OnlineProviderId, ProviderCollection } from './types/onlineMusic';
import { resolveSongCatalogRef } from './services/onlineMusic/catalogRefs';
import { omni } from './services/onlineMusic/omni';
import { consumeProgrammaticPause, playbackFade } from './services/playbackFade';
import { getSongArtistLabel, getSongCoverUrl } from './services/onlineMusic/songMetadata';
import { isNavidromeEnabled } from './services/navidromeService';
import { useAppNavigation } from './hooks/useAppNavigation';
import { useNeteaseLibrary } from './hooks/useNeteaseLibrary';

import { useLibraryAccountController } from './library/app/useLibraryAccountController';
import { createLibraryAccountSwitchCleanupPort } from './library/app/createLibraryAccountPort';
import { useAppWallToolsHost } from './components/app/wall-tools/useAppWallToolsHost';
import { useLibraryAccountProviders } from './library/core/account/useLibraryAccount';
import { resolveActiveProviderSummary } from './library/core/account/accountRules';
import { useAppPreferences } from './hooks/useAppPreferences';
import { useElectronPlaybackBridge } from './components/app/playback/bridges/useElectronPlaybackBridge';
import { useElectronDisplaySleepBlocker } from './hooks/useElectronDisplaySleepBlocker';
import { useBackgroundLyricHold } from './components/app/backgroundThrottling/useBackgroundLyricHold';
import { readLiveLyricTime, useBackgroundLyricHoldStore } from './components/app/backgroundThrottling/backgroundLyricHoldStore';
import { useSleepTimer } from './hooks/useSleepTimer';
import { useProviderNotices } from './components/app/useProviderNotices';
import { useLocalLibraryAutoScan } from './hooks/useLocalLibraryAutoScan';
import { useElectronVideoExportController } from './hooks/useElectronVideoExportController';
import { useElectronWindowPlaybackHandoff } from './components/app/playback/restore/useElectronWindowPlaybackHandoff';
import { useMediaSessionBridge } from './hooks/useMediaSessionBridge';
import { useCapacitorSystemBars } from './hooks/useCapacitorSystemBars';
import { useCapacitorPlaybackBridge } from './hooks/useCapacitorPlaybackBridge';
import { useNativeBackButton } from './hooks/useNativeBackButton';
import { useAndroidPlaybackAutoOrientation } from './hooks/useAndroidPlaybackAutoOrientation';
import { useBackgroundRenderPause } from './hooks/useBackgroundRenderPause';
import { noteAudioEvent, resetMediaDiagnostics } from './utils/mediaDiagnostics';
import { useLyricsWallpaperFeed } from './hooks/useLyricsWallpaperFeed';
import { useLyriconFeed } from './hooks/useLyriconFeed';
import { useColorOsLyricFeed } from './hooks/useColorOsLyricFeed';
import { useImmersiveLyricsBars } from './hooks/useImmersiveLyricsBars';
import { useScreenAwake } from './hooks/useScreenAwake';
import { usePlayerChromeAutoHide } from './hooks/usePlayerChromeAutoHide';
import { useHdrExitConfirm, useHdrProjectionActive } from './hooks/useHdrProjection';
import { disableHdrProjection } from './services/hdrProjection';
import { useMacWallpaperHitRegions } from './hooks/useMacWallpaperHitRegions';
import { useIdleCursorHide } from './hooks/useIdleCursorHide';
import { usePlaybackAudioBridge } from './components/app/playback/bridges/usePlaybackAudioBridge';
import { usePlayerSwipeGesture } from './hooks/usePlayerSwipeGesture';
import { useTranscodeFallback } from './hooks/useTranscodeFallback';
import { useAutomixDecks, type AutomixDeckId } from './services/automix/useAutomixDecks';
import { NATIVE_PLAYBACK_ENABLED, nativePlaybackEngine } from './services/playbackEngine/nativePlaybackEngine';
import { isNativePlayerAvailable } from './services/playbackEngine/nativePlayerPlugin';
import { useNativePlaybackRuntime } from './services/playbackEngine/useNativePlaybackRuntime';
import { usePlaybackInteractionBridge } from './components/app/playback/bridges/usePlaybackInteractionBridge';
import { usePersonalFmModeController } from './hooks/usePersonalFmModeController';
import { PERSONAL_FM_MODE_COMMAND_ID } from './components/command-palette/commands/fmModeCommand';
import { usePlaybackUiEffects } from './components/app/playback/bridges/usePlaybackUiEffects';
import { useLibraryPlaybackController } from './components/app/playback/start/useLibraryPlaybackController';
import { useLocalCoverQueueSync } from './hooks/useLocalCoverQueueSync';
import { useNavidromeScrobbleReporter } from './hooks/useNavidromeScrobbleReporter';
import { usePlaybackReporter } from './components/app/playback/bridges/usePlaybackReporter';
import { useRecentPlaysRecorder } from './components/app/home/explore/useRecentPlaysRecorder';
import { usePlaybackQueueController } from './components/app/playback/start/usePlaybackQueueController';
import { usePlaybackTransportController } from './components/app/playback/bridges/usePlaybackTransportController';
import { useLocalLibraryCatalog } from './hooks/useLocalLibraryCatalog';
import { usePlaybackVisualizerBridge } from './components/app/playback/bridges/usePlaybackVisualizerBridge';
import { useLyricReadHead } from './components/app/playback/bridges/useLyricReadHead';
import { useRandomVisualizerMode } from './hooks/useRandomVisualizerMode';
import { useLyricAnimationDirector } from './hooks/useLyricAnimationDirector';
import { useObsBrowserSourcePublisher } from './hooks/useObsBrowserSourcePublisher';
import { useLyricApiPublisher } from './hooks/useLyricApiPublisher';
import { useSessionRestoreController } from './components/app/playback/restore/useSessionRestoreController';
import { useStagePlaybackController } from './components/app/playback/useStagePlaybackController';
import { useSongThemeAutoGeneration } from './hooks/useSongThemeAutoGeneration';
import { useThemeController } from './hooks/useThemeController';
import { registerAiThemeApplier, registerAiThemeProvider } from './services/aiThemeApplyBridge';
import { useOnlineSongMetadataHydration } from './hooks/useOnlineSongMetadataHydration';
import { resolveCommandPaletteSearchSource, resolveSearchSource, useSearchNavigationStore } from './stores/useSearchNavigationStore';
import { useOnlineProviderAccountStore } from './stores/useOnlineProviderAccountStore';
import { useShallow } from 'zustand/react/shallow';
import { clampMediaVolume, toSafeRemoteUrl } from './utils/appPlaybackHelpers';
import { hasLoopedToStart } from './services/playedTrackCache';
import { getOnlineProviderIdForSong, isLocalPlaybackSong, isNavidromePlaybackSong, isStagePlaybackSong } from './utils/appPlaybackGuards';
import { writeLyricOffset } from './utils/lyrics/lyricOffsetMemory';
import { FALLBACK_AI_DUAL_THEME } from './services/themeSanitizer';
import { BASE_DUAL_THEME, DAYLIGHT_THEME, DEFAULT_THEME } from './services/baseThemes';
import { initializeSyncCoordinator } from './services/sync/syncCoordinator';
import { applyLocalLibraryEntityDisplay } from './services/playbackAdapters';
import { transitionCapabilities } from './services/automix/stems';
import { buildLocalLibraryIndex } from './utils/localLibraryIndex';
import type { PlayerChromeVisibilityMode } from './types/remoteControl';
import { setStatusMessage as setStatusMsg, useStatusMessage } from './stores/useStatusMessageStore';
import { selectVisualizerSettingsSnapshot, useVisualizerSettingsStore } from './stores/useVisualizerSettingsStore';
import { selectLyricSettingsSnapshot, useLyricSettingsStore } from './stores/useLyricSettingsStore';
import { selectTypographySettingsSnapshot, useTypographySettingsStore } from './stores/useTypographySettingsStore';
import { selectPlayerChromeSettingsSnapshot, usePlayerChromeSettingsStore } from './stores/usePlayerChromeSettingsStore';
import { selectThemeSettingsSnapshot, useThemeSettingsStore } from './stores/useThemeSettingsStore';
import { useAutomixSettingsStore } from './stores/useAutomixSettingsStore';
import { selectDesktopSettingsSnapshot, useDesktopSettingsStore } from './stores/useDesktopSettingsStore';
import { selectSleepTimerSnapshot, useSleepTimerStore } from './stores/useSleepTimerStore';
import { selectStageSettingsSnapshot, useStageSettingsStore } from './stores/useStageSettingsStore';
import { selectAudioSettingsSnapshot, useAudioSettingsStore } from './stores/useAudioSettingsStore';
import { useSettingsModalStore } from './stores/useSettingsModalStore';
import { audioBands, audioPower, bass, currentTime, lowMid, lyricCurrentTime, mid, spectrum, treble, vocal } from './stores/motionSignals';
import { useAppChromeStore } from './stores/useAppChromeStore';
import { useAppViewStore } from './stores/useAppViewStore';
import { endLoadingToPlay, selectDisplayCoverUrl, selectDisplayDuration, selectDisplayLyrics, selectDisplayPlayerState, selectDisplaySong, selectIsShowingTail, usePlaybackStore } from './stores/usePlaybackStore';
import { askForSong, showSong } from './components/app/playback/currentSong';
import { useLibraryStore } from './stores/useLibraryStore';
import { selectLibraryOccludesPlayer, selectLibraryPlayerBackdrop, useLibraryPlayerOcclusionStore } from './stores/useLibraryPlayerOcclusionStore';
import { resolveVisualizerBackdropBlur, visualizerBackdropStyle } from './components/app/presentation/playerVisualizerBackdrop';
import { useLibraryOcclusionSettled } from './hooks/useLibraryOcclusionSettled';
import { useWallHandoffStore } from './stores/useWallHandoffStore';
import { countRender } from './dev/renderCount';
import { resolveSongLiked } from './utils/resolveSongLiked';
import { resolveLikeAvailability } from './utils/playerLikeAvailability';
import StageSessionEmptyState from './components/app/stage/StageSessionEmptyState';
import { useVisualizerRendererModel } from './components/visualizer/useVisualizerRendererModel';
import { useVisualizerTunings } from './components/visualizer/useVisualizerTunings';
import { usePlaybackRuntimeRefs } from './components/app/playback/usePlaybackRuntimeRefs';
import { useElectronWindowChrome } from './hooks/useElectronWindowChrome';
import { useTransportCommandRefs } from './components/app/playback/bridges/useTransportCommandRefs';
import { useAccountReads } from './hooks/useAccountReads';
import { useAudioOutputDevice } from './hooks/useAudioOutputDevice';
import { useThemeQuickEditorContext } from './hooks/useThemeQuickEditorContext';
import { usePlayerBottomBarOffset } from './hooks/usePlayerBottomBarOffset';
import { usePlayerBottomBarPositioningEntry } from './hooks/usePlayerBottomBarPositioningEntry';
import { PlayerBottomBarLayoutContext } from './components/floating-player/PlayerBottomBarLayoutContext';
import { useFoliumHostBridge } from './mods/runtime/hostBridge';
import { useFoliumHostActions } from './mods/runtime/hostActions';
import { refreshPrefetchAfterQueueEdit } from './services/prefetchService';
import { FoliumStageLayerSlot } from './mods/folium/registries/stageLayers';
import { errorFields } from './utils/errorText';
import { runsOnWindows } from './utils/platform';

const LOCAL_MUSIC_UPDATED_EVENT = 'folia-local-music-updated';
const DEV_DEBUG_SHORTCUT_LABEL = 'Alt+Shift+D';
const ONLINE_AUDIO_URL_TTL_MS = 1200 * 1000;
const ONLINE_AUDIO_URL_REFRESH_BUFFER_MS = 60 * 1000;
const LOCAL_TAIL_DECODE_ERROR_TOLERANCE_SEC = 3;
/** How many seconds before a track ends the now playing card previews the queue's next track. */
const NEXT_UP_LEAD_SEC = 5;

export default function App() {
    countRender('App');
    const { t } = useTranslation();
    const {
        navidromeEnabled, setNavidromeEnabledState,
        starredNavidromeSongIds, setStarredNavidromeSongIds,
        isProviderSyncing, setIsProviderSyncing,
    } = useLibraryStore(useShallow(state => ({
        navidromeEnabled: state.navidromeEnabled,
        setNavidromeEnabledState: state.setNavidromeEnabledState,
        starredNavidromeSongIds: state.starredNavidromeSongIds,
        setStarredNavidromeSongIds: state.setStarredNavidromeSongIds,
        isProviderSyncing: state.isProviderSyncing,
        setIsProviderSyncing: state.setIsProviderSyncing,
    })));
    const {
        currentSong, setCurrentSong,
        audioSrc, setAudioSrc,
        lyrics, setLyricsState,
        cachedCoverUrl, setCachedCoverUrl,
        duration, setDuration,
        playerState, setPlayerState,
        playQueue, setPlayQueue,
        activePlaybackContext,
        isFmMode,
        setReplayGainMode,
        lyricTimelineOffsetMs, setLyricTimelineOffsetMs,
    } = usePlaybackStore(useShallow(state => ({
        currentSong: state.currentSong, setCurrentSong: state.setCurrentSong,
        audioSrc: state.audioSrc, setAudioSrc: state.setAudioSrc,
        lyrics: state.lyrics, setLyricsState: state.setLyricsState,
        cachedCoverUrl: state.cachedCoverUrl, setCachedCoverUrl: state.setCachedCoverUrl,
        duration: state.duration, setDuration: state.setDuration,
        playerState: state.playerState, setPlayerState: state.setPlayerState,
        setCurrentLineIndex: state.setCurrentLineIndex,
        playQueue: state.playQueue, setPlayQueue: state.setPlayQueue,
        activePlaybackContext: state.activePlaybackContext, setActivePlaybackContext: state.setActivePlaybackContext,
        isFmMode: state.isFmMode,
        replayGainMode: state.replayGainMode, setReplayGainMode: state.setReplayGainMode,
        lyricTimelineOffsetMs: state.lyricTimelineOffsetMs, setLyricTimelineOffsetMs: state.setLyricTimelineOffsetMs,
    })));
    const {
        isPanelOpen, setIsPanelOpen,
        setPanelTab,
        isHomeFullyHidden, setIsHomeFullyHidden,
    } = useAppViewStore(useShallow(state => ({
        isPanelOpen: state.isPanelOpen,
        setIsPanelOpen: state.setIsPanelOpen,
        setPanelTab: state.setPanelTab,
        isHomeFullyHidden: state.isHomeFullyHidden,
        setIsHomeFullyHidden: state.setIsHomeFullyHidden,
    })));
    const {
        isTitlebarRevealed,
        showTransparentWindowBorder,
        isMainWindowClickThroughEnabled,
        isClickThroughToggleHotspotActive, setIsClickThroughToggleHotspotActive,
        setIsPlayerPanelGuideHotspotActive,
        isPlayerChromeHidden, setIsPlayerChromeHidden,
        isDevDebugOverlayVisible,
    } = useAppChromeStore(useShallow(state => ({
        isTitlebarRevealed: state.isTitlebarRevealed,
        showTransparentWindowBorder: state.showTransparentWindowBorder,
        isMainWindowClickThroughEnabled: state.isMainWindowClickThroughEnabled,
        isClickThroughToggleHotspotActive: state.isClickThroughToggleHotspotActive,
        setIsClickThroughToggleHotspotActive: state.setIsClickThroughToggleHotspotActive,
        setIsPlayerPanelGuideHotspotActive: state.setIsPlayerPanelGuideHotspotActive,
        isPlayerChromeHidden: state.isPlayerChromeHidden,
        setIsPlayerChromeHidden: state.setIsPlayerChromeHidden,
        isDevDebugOverlayVisible: state.isDevDebugOverlayVisible,
    })));
    const isDev = import.meta.env.DEV;
    const isElectronWindow = Boolean((window as typeof window & { electron?: unknown; }).electron);

    // Subscribed only while the debug snapshot is actually being built: a plain subscription
    // re-rendered the whole App on every lyric-line change for a debug-only value.
    const devDebugCurrentLineIndex = usePlaybackStore(state => (
        isDev || isDevDebugOverlayVisible ? state.currentLineIndex : -1
    ));

    // Player Data
    useOnlineSongMetadataHydration(currentSong, setCurrentSong);

    // Queue

    // UI State
    const statusMsg = useStatusMessage();
    useProviderNotices(t);
    // Watches the imported local folders and rescans them when their contents change.
    useLocalLibraryAutoScan();

    // Auto-close the player panel when leaving the player view
    // (Effect moved to after useAppNavigation where currentView is defined)
    const { settingsModalState } = useSettingsModalStore(useShallow(state => ({
        settingsModalState: state.settingsModalState,
    })));
    const automixEnabled = useAutomixSettingsStore(state => state.automixEnabled);
    const transitionMode = useAutomixSettingsStore(state => state.transitionMode);
    const crossfadeMaxSec = useAutomixSettingsStore(state => state.crossfadeMaxSec);
    const transitionPerformance = useAutomixSettingsStore(state => state.transitionPerformance);
    const transitionAnimation = useAutomixSettingsStore(state => state.transitionAnimation);
    /**
     * The same test the settings panel disables its performance switch by, for the command palette.
     *
     * Asked in one place rather than two: the panel greys the switch out when there is no stem model
     * to run, and the palette command used to check only that this was the desktop build - so the
     * command could turn on a mode the panel would not let anyone turn on, and the preference stayed
     * set for whenever a model did arrive. Left as a getter for the palette to call; see the note on
     * `canUseTransitionPerformance` in the palette's context type.
     */
    const canUseTransitionPerformance = useCallback(() => transitionCapabilities().stems, []);
    // Memoised because it is a dependency of the planning callback: a fresh object every render
    // would rebuild that callback on every frame of playback.
    const transitionSettings = useMemo(
        () => ({ mode: transitionMode, crossfadeMaxSec, performance: transitionPerformance }),
        [transitionMode, crossfadeMaxSec, transitionPerformance],
    );
    // The analysis worker keeps htdemucs loaded while automix can ask for it, and releases it the
    // moment it cannot - the switch off, or the crossfade mode, which reads no model. Sent on mount
    // too: the main process starts out assuming off. See electron/analysis/host.cjs.
    // (From the PR #750 re-review, 2026-10-19: it no longer keeps htdemucs while automix can ask - it
    // releases it a minute after each run - but the moment automix cannot still releases it at once.)
    useEffect(() => {
        window.electron?.setAutomixEnabled?.(automixEnabled && transitionMode === 'automix');
    }, [automixEnabled, transitionMode]);

    const startupExperience = useStartupExperienceGate();
    // 启动后自动查一次新版本，有新版本就弹提示（安卓才有；桌面端走 electron-updater）。
    const updatePrompt = useStartupUpdatePrompt();

    useEffect(() => initializeSyncCoordinator(), []);

    const loadNavidromeFavorites = useCallback(async () => {
        if (!navidromeEnabled) {
            setStarredNavidromeSongIds(new Set());
            return;
        }

        const { getNavidromeConfig, navidromeApi } = await import('./services/navidromeService');
        const config = getNavidromeConfig();
        if (!config) return;

        try {
            const songs = await navidromeApi.getStarred2(config) ?? [];
            setStarredNavidromeSongIds(new Set(songs.map(song => song.id)));
        } catch (error) {
            console.warn('[App] Failed to load Navidrome favorites:', error);
        }
    }, [navidromeEnabled]);

    useEffect(() => {
        void loadNavidromeFavorites();
    }, [loadNavidromeFavorites]);

    const prevSettingsOpenRef = useRef(false);
    useEffect(() => {
        const isOpen = settingsModalState.isOpen;
        if (!isOpen && prevSettingsOpenRef.current && navidromeEnabled) {
            void loadNavidromeFavorites();
        }
        prevSettingsOpenRef.current = isOpen;
    }, [settingsModalState.isOpen, navidromeEnabled, loadNavidromeFavorites]);

    // Player State
    useEffect(() => {
        (window as any).__folia_current_time = currentTime;
    }, []);

    // Progress Bar State
    // Removed isDragging and sliderValue as they are handled by ProgressBar component

    // Audio Analysis State

    // Refs
    // The mutable substrate the playback controllers coordinate through; see the hook for why it
    // has to be held here rather than by any one of them.
    const {
        audioRef,
        audioContextRef,
        analyserRef,
        gainNodeRef,
        blobUrlRef,
        animationFrameRef,
        shouldAutoPlay,
        currentSongRef,
        currentSongFullRef,
        playbackAutoSkipCountRef,
        volumePreviewFrameRef,
        pendingVolumePreviewRef,
        pendingResumeTimeRef,
        onlinePlaybackRecoveryRef,
        lastAudioRecoverySourceRef,
        currentOnlineAudioUrlFetchedAtRef,
    } = usePlaybackRuntimeRefs();
    // The automix decks are set up much further down, but a few reset paths declared above here
    // need to be able to stop a transition, and queue navigation needs the track being SHOWN. A ref
    // keeps both reachable without reordering them; it is reassigned on every render, so the
    // picture read through it is the committed one.
    const automixRef = useRef<{
        abortTransition: () => void;
        transitionDisplay: { song: SongResult | null } | null;
    } | null>(null);
    const queueScrollRef = useRef<HTMLDivElement>(null);
    // Buffer progress debug helper. Uncomment this ref, the reset effect below,
    // and the audio `onProgress` handler to log buffered percent again.
    // const lastBufferedPercentLogRef = useRef<number | null>(null);
    const [isLyricsLoading, setIsLyricsLoadingState] = useState(false);
    // Every write of the loading mark is counted, so a play that gives up late can tell whether the
    // mark is still the one it set (onPlayNavidromeSong).
    const lyricsLoadingWritesRef = useRef(0);
    const setIsLyricsLoading = useCallback<typeof setIsLyricsLoadingState>(next => {
        lyricsLoadingWritesRef.current += 1;
        setIsLyricsLoadingState(next);
    }, []);
    const isNowPlayingControlDisabledRef = useRef(false);


    // Navigation persistence state shared by the Grid home surfaces.
    const homeViewTab = useSearchNavigationStore(state => state.homeViewTab);
    const setHomeViewTab = useSearchNavigationStore(state => state.setHomeViewTab);
    const handleToggleNavidromeEnabled = useCallback((enabled: boolean) => {
        setNavidromeEnabledState(enabled);
        if (!enabled && homeViewTab === 'navidrome') {
            setHomeViewTab('local');
        }
    }, [homeViewTab, setHomeViewTab]);

    // Preferences and Theme
    // Manages user preferences for audio quality, theme settings, 
    // and related actions like toggling cover color backgrounds and static mode,
    // as well as setting daylight mode preference
    useAppPreferences();
    const {
        audioQuality,
        queueAddBehavior,
        loopMode,
        volume,
        isMuted,
        handleToggleLoopMode,
    } = useAudioSettingsStore(useShallow(selectAudioSettingsSnapshot));
    const {
        preventDisplaySleepDuringPlayback,
        wallpaperMode,
    } = useDesktopSettingsStore(useShallow(selectDesktopSettingsSnapshot));
    // macOS wallpaper mode: click catchers over the controls, so Stage Manager ignores those clicks.
    useMacWallpaperHitRegions(wallpaperMode);
    const {
        stageTrackPillMode,
        stageTrackPillOnHome,
    } = useStageSettingsStore(useShallow(selectStageSettingsSnapshot));
    const {
        sleepTimerEnabled,
        sleepTimerHours,
        sleepTimerMinutes,
        sleepTimerMode,
        sleepTimerClockHour,
        sleepTimerClockMinute,
        sleepTimerEndAction,
    } = useSleepTimerStore(useShallow(selectSleepTimerSnapshot));
    const {
        disableHomeDynamicBackground,
        isDaylight,
        setDaylightPreference,
    } = useThemeSettingsStore(useShallow(selectThemeSettingsSnapshot));
    const {
        hidePlayerProgressBar,
        playerBottomBarOffset,
        hidePlayerRightPanelButton,
        transparentPlayerBackground,
        enablePlayerPageNativeBlur,
        autoHidePlayerChrome,
        handleToggleAutoHidePlayerChrome,
        autoHideCursorWithPlayerChrome,
        hidePlayerChromeOnTap,
        hideCursorWhenIdle,
        alwaysShowMainWindowTitlebar,
        hideFullscreenButton,
        handleToggleTransparentPlayerBackground,
    } = usePlayerChromeSettingsStore(useShallow(selectPlayerChromeSettingsSnapshot));
    const {
        hidePlayerTranslationSubtitle,
        lyricsFontStyle,
        lyricsFontWeight,
        lyricsFontFallbackFamilies,
        subtitleFontInheritsLyrics,
        subtitleFontStyle,
        subtitleFontWeight,
        subtitleFontFamily,
        subtitleFontFallbackFamilies,
        lyricsCustomFontFamily,
    } = useTypographySettingsStore(useShallow(selectTypographySettingsSnapshot));
    useCapacitorSystemBars(isDaylight);
    // Android 返回键：先当 Escape 交给弹层，没人接管才退出（原生侧已把事件转过来）。
    useNativeBackButton();
    // Android「进入可视化自动横屏」：进播放页锁横屏，离开转回竖屏（开关默认关，组件内部判端）。
    useAndroidPlaybackAutoOrientation();
    // 退后台就停渲染：把 CPU 让给音频解码，后台播放才不会跟画面抢时间片。
    useBackgroundRenderPause();
    const {
        globalLyricTimelineOffsetMs,
        lyricFilterPattern,
        lyricFilterEnabled,
        lyricStaffPolicy,
        lyricStaffMinDwellSeconds,
        lyricStaffAbsorbMode,
        lyricStaffPattern,
        handleSetLyricFilterPattern,
        handleSetLyricFilterEnabled,
        handleSetLyricStaffPolicy,
        handleSetLyricStaffMinDwellSeconds,
        handleSetLyricStaffAbsorbMode,
        handleSetLyricStaffPattern,
    } = useLyricSettingsStore(useShallow(selectLyricSettingsSnapshot));
    const {
        visualizerMode,
        randomVisualizerModePerSong,
        randomVisualizerModes,
        handleSetVisualizerMode,
    } = useVisualizerSettingsStore(useShallow(selectVisualizerSettingsSnapshot));

    useElectronDisplaySleepBlocker(
        preventDisplaySleepDuringPlayback,
        playerState === PlayerState.PLAYING,
    );
    useBackgroundLyricHold();
    // The app.overlay mod layers read the same lyric clock and line the hold keeps still: paused with it.
    const backgroundLyricHeld = useBackgroundLyricHoldStore(state => state.held);

    const visualizerTunings = useVisualizerTunings();

    const showPlayerChromeVisibilityModeStatus = useCallback((mode: PlayerChromeVisibilityMode) => {
        setStatusMsg({
            type: 'info',
            text: t(`status.playerChrome${mode === 'always-hidden' ? 'AlwaysHidden' : mode === 'always-visible' ? 'AlwaysVisible' : 'AutoHide'}`),
            nonce: Date.now(),
        });
    }, [t]);

    const {
        playerChromeVisibilityMode,
        cyclePlayerChromeVisibilityMode,
        setPlayerChromeVisibilityModeTo,
    } = usePlayerChromeAutoHide({
        autoHidePlayerChrome,
        initialPlayerChromeHidden: isPlayerChromeHidden,
        suppressPointerReveal: isMainWindowClickThroughEnabled,
        setIsPlayerChromeHidden,
        setAutoHidePlayerChromePreference: handleToggleAutoHidePlayerChrome,
        onModeChange: showPlayerChromeVisibilityModeStatus,
    });

    useRandomVisualizerMode({
        currentSong,
        enabled: randomVisualizerModePerSong,
        modes: randomVisualizerModes,
        visualizerMode,
        setVisualizerMode: handleSetVisualizerMode,
    });

    // AI 歌词动画导演：原来是模组，而安卓包根本加载不了模组，所以搬进了本体。
    // 换歌与歌词就绪都在这里接上，面板和命令走的是同一个服务。
    useLyricAnimationDirector();

    const setLyrics = useMemo(
        () => createLyricsSetter(setLyricsState, lyricFilterEnabled ? lyricFilterPattern : '', currentSongFullRef, {
            policy: lyricStaffPolicy,
            minDwellSeconds: lyricStaffMinDwellSeconds,
            absorbMode: lyricStaffAbsorbMode,
            pattern: lyricStaffPattern,
        }),
        [lyricFilterEnabled, lyricFilterPattern, lyricStaffPolicy, lyricStaffMinDwellSeconds, lyricStaffAbsorbMode, lyricStaffPattern],
    );
    // 保存过滤设置后要用新设置重新铺一遍当前歌词，而此时闭包里的 setLyrics 还是旧的。
    const setLyricsRef = useRef(setLyrics);
    setLyricsRef.current = setLyrics;
    const setLyricsStable = useCallback((nextLyrics: LyricData | null) => setLyricsRef.current(nextLyrics), []);

    const handleLyricTimelineOffsetChange = useCallback((offsetMs: number) => {
        setLyricTimelineOffsetMs(offsetMs);
        writeLyricOffset(currentSongFullRef.current?.id, offsetMs);
    }, []);

    // What every lyric consumer (visualizers, OBS source, Stage/Remote mirrors, lyric API) actually
    // uses: the per-song manual correction plus the device-wide audio latency compensation. The panel
    // control below keeps editing the per-song value alone.
    const effectiveLyricTimelineOffsetMs = lyricTimelineOffsetMs + globalLyricTimelineOffsetMs;

    const effectiveLoopMode: StageLoopMode = loopMode;

    const getTargetPlaybackVolume = useCallback(() => (isMuted ? 0 : volume), [isMuted, volume]);

    const persistLastPlaybackCache = useCallback(persistPlaybackCache, []);

    /*
     * 原生播放（P1）。
     *
     * ⛔ **已停用**：`NATIVE_PLAYBACK_ENABLED` 是总闸（见 nativePlaybackEngine.ts）。
     * 下面三个层次都保留着，闸一关它们自然全为 false，所以不用逐个去改分支。
     *
     *  · `nativePlaybackEnabled` —— 用户开关（设置里那一项，已随停用一起撤掉）；
     *  · `nativeActive`          —— 总闸 ∧ 开关 ∧ 原生插件真的在（不能靠 `typeof
     *                               plugin.method === 'function'` 判，registerPlugin 给的是代理）；
     *  · `nativeTakes`           —— 这一首真的交给原生：地址还得是原生吃得下的
     *                               （blob 是 WebView 自己的对象 URL，本地导入的歌就是这种，
     *                                 那首整首回落 `<audio>`；媒体缓存走本机回环地址，原生能读）。
     *
     * `nativeTakesRef` 给那些「用户按下时才跑」的回调（音量、seek、transport）用：
     * 它们不该因为换了一首歌就换身份。
     */
    const nativePlaybackEnabled = useAudioSettingsStore(state => state.nativePlaybackEnabled);
    const nativeActive = NATIVE_PLAYBACK_ENABLED && nativePlaybackEnabled && isNativePlayerAvailable();
    const nativeTakes = nativeActive && nativePlaybackEngine.supports(audioSrc);
    const nativeTakesRef = useRef(false);
    useEffect(() => {
        nativeTakesRef.current = nativeTakes;
    }, [nativeTakes]);

    const syncOutputGain = useCallback((targetVolume: number, smoothing = 0.015) => {
        const clampedVolume = clampMediaVolume(targetVolume);

        // 原生播放（P1）：音频不在 Web 音频图上，音量只能交给 ExoPlayer。
        // 图上的 gain 节点这时候是空跑的，写它等于什么都没做。
        if (nativeTakesRef.current) {
            nativePlaybackEngine.setVolume(clampedVolume);
            return;
        }

        if (gainNodeRef.current && audioContextRef.current) {
            // Volume only. ReplayGain lives on each deck now, because during a blend the two
            // tracks need their own compensation and this node is shared by both.
            if (smoothing <= 0) {
                gainNodeRef.current.gain.setValueAtTime(
                    clampedVolume,
                    audioContextRef.current.currentTime
                );
            } else {
                gainNodeRef.current.gain.setTargetAtTime(
                    clampedVolume,
                    audioContextRef.current.currentTime,
                    smoothing
                );
            }

            if (audioRef.current) {
                audioRef.current.volume = 1;
                audioRef.current.muted = false;
            }
            return;
        }

        if (audioRef.current) {
            audioRef.current.volume = clampedVolume;
            audioRef.current.muted = isMuted;
        }
    }, [isMuted]);

    const { handleAudioOutputDeviceChange } = useAudioOutputDevice({
        audioRef,
        audioContextRef,
        gainNodeRef,
    });

    const handlePreviewVolume = useCallback((val: number) => {
        pendingVolumePreviewRef.current = val;

        if (volumePreviewFrameRef.current !== null) {
            return;
        }

        volumePreviewFrameRef.current = requestAnimationFrame(() => {
            volumePreviewFrameRef.current = null;
            const nextVolume = pendingVolumePreviewRef.current;
            if (nextVolume !== null) {
                syncOutputGain(nextVolume, 0.015);
            }
        });
    }, [syncOutputGain]);

    const {
        shouldRefreshCurrentOnlineAudioSource,
        recoverOnlinePlaybackSource,
    } = useMemo(() => createOnlineRecoveryController({
        audioQuality,
        currentSong,
        audioSrc,
        audioRef,
        blobUrlRef,
        shouldAutoPlayRef: shouldAutoPlay,
        pendingResumeTimeRef,
        onlinePlaybackRecoveryRef,
        lastAudioRecoverySourceRef,
        currentOnlineAudioUrlFetchedAtRef,
        persistLastPlaybackCache,
        onlineAudioUrlTtlMs: ONLINE_AUDIO_URL_TTL_MS,
        onlineAudioUrlRefreshBufferMs: ONLINE_AUDIO_URL_REFRESH_BUFFER_MS,
    }), [audioQuality, audioSrc, audioRef, blobUrlRef, currentOnlineAudioUrlFetchedAtRef, currentSong, lastAudioRecoverySourceRef, onlinePlaybackRecoveryRef, pendingResumeTimeRef, persistLastPlaybackCache, setAudioSrc, setCurrentSong, setPlayQueue, shouldAutoPlay]);

    const getCoverUrl = useMemo(
        () => createCoverUrlResolver(cachedCoverUrl, currentSong),
        [cachedCoverUrl, currentSong],
    );

    const coverUrl = getCoverUrl();

    // Theme Controller
    // manages current theme, daylight mode, and related actions like generating AI themes 
    // and restoring cached themes for songs
    const themeController = useThemeController({
        defaultTheme: DEFAULT_THEME,
        daylightTheme: DAYLIGHT_THEME,
        isDaylight,
        setDaylightPreference,
        coverUrl,
        t,
    });
    const {
        theme,
        setTheme,
        aiTheme,
        customTheme,
        hasCustomTheme,
        themeSourceModel,
        isCustomThemePreferred,
        songThemeAutoSwitchEnabled,
        songThemeAutoGenerateEnabled,
        themeGenerationSource,
        bgMode,
        isGeneratingTheme,
        // 「这首歌的 AI 主题还没落定」：正在翻本机改过的那版 / 拉云端 / 问模型。
        // 壁纸与叠层拿它决定「这一推要不要再等等」（见 useLyricsWallpaperFeed）。
        themeSettling,
        handleToggleDaylight,
        handleBgModeChange,
        handleResetTheme,
        applyDefaultTheme,
        restoreCachedThemeForSong,
        generateAITheme,
        getThemeParkSeedTheme,
        saveCustomDualTheme,
        saveEditedAiDualTheme,
        applyDualTheme,
        applyCustomTheme,
        handleCustomThemePreferenceChange,
        handleSongThemeAutoSwitchChange,
        handleSongThemeAutoGenerateChange,
        handleThemeGenerationSourceChange,
    } = themeController;
    // Folium: publish what is on screen to the main process (runtime snapshot
    // for main-side mods and the export service).
    useFoliumHostBridge(theme, isDaylight);

    useThemeQuickEditorContext({
        aiTheme,
        customTheme,
        bgMode,
        coverUrl,
        restoreCachedThemeForSong,
    });

    /*
     * 面板上那颗 AI 主题云同步按钮要两样东西：把一份主题**应用上去**，以及拿到当前
     * 生效的那**整份**（浅 + 深）。这两样只有这里的主题控制器有，而面板那条链路是
     * 一层层传 props 的，为这一颗按钮再开一路要动五个文件 —— 改成由这里登记，
     * 按钮那侧取走用（见 services/aiThemeApplyBridge.ts）。
     */
    useEffect(() => {
        registerAiThemeApplier(dualTheme => applyDualTheme(dualTheme, { respectCustomPreference: false }));
        registerAiThemeProvider(() => aiTheme);
        return () => {
            registerAiThemeApplier(null);
            registerAiThemeProvider(null);
        };
    }, [aiTheme, applyDualTheme]);

    // Navigation and Library Hooks
    // manages current view, selected items, and navigation functions across the app
    const {
        currentView,
        focusedPlaylistIndex,
        setFocusedPlaylistIndex,
        navidromeFocusedAlbumIndex,
        setNavidromeFocusedAlbumIndex,
        localMusicState,
        setLocalMusicState,
        navigateToPlayer,
        navigateToPlaybackView,
        navigateFromPlayerCapsule,
        navigateToHome,
        navigateToLattice,
        navigateBackFromLattice,
        navigateBackFromPlayer,
        navigateDirectHome,
        navigateToSearch,
        closeSearchView,
        navigateToCollection,
        pushCollection,
        popCollectionTo,
        backCollection,
    } = useAppNavigation();
    const reduceLatticeMotion = useReducedMotionFor('lattice');
    const visualizerAroundWall = useVisualizerAroundWall();

    usePlayerBottomBarOffset(playerBottomBarOffset);
    usePlayerBottomBarPositioningEntry(navigateToPlayer);

    // Auto-close the player panel when leaving the player view
    useEffect(() => {
        if (currentView !== 'player' && isPanelOpen) {
            setIsPanelOpen(false);
        }
    }, [currentView, isPanelOpen]);

    useEffect(() => {
        if (isPanelOpen) {
            setIsPlayerPanelGuideHotspotActive(previous => previous ? false : previous);
        }
    }, [isPanelOpen]);

    const {
        isSearchOpen,
        searchSourceTab,
        submitSearch,
        loadMoreSearchResults,
    } = useSearchNavigationStore(useShallow(state => ({
        isSearchOpen: state.isSearchOpen,
        searchSourceTab: state.searchSourceTab,
        submitSearch: state.submitSearch,
        loadMoreSearchResults: state.loadMoreSearchResults,
    })));

    // Netease Library Hook
    // the NetEase account as the account store holds it
    const {
        user,
        playlists,
        cloudPlaylist,
    } = useNeteaseLibrary();

    // Every platform's account is read and signed out of through omni (services/onlineMusic/account/),
    // NetEase like the others. One entry per platform registered at start; a mod's source has none.
    const onlineProviderRefreshers = useMemo<Partial<Record<OnlineProviderId, () => Promise<unknown>>>>(() => Object.fromEntries(
        omni.getProviderSummaries().map(({ providerId }) => [providerId, async () => await omni.readAccount(providerId, 'sync') === 'read']),
    ), []);
    // 在线账户 controller（Library v2 · A4）：登录、选平台、切换确认与登出都在 core，App 只交出退出与退出前的那一问
    // （useProviderSignOut），以及换平台时清空播放器的端口。端口读的句柄都是稳定引用，建一次。
    const { confirmLogout, signOut, dialog: signOutDialog } = useProviderSignOut();
    const [providerSwitchCleanup] = useState(() => createLibraryAccountSwitchCleanupPort(() => ({
        audioRef,
        automixRef,
        shouldAutoPlay,
        setLyrics: setLyricsStable,
        setIsLyricsLoading,
    })));
    const accountController = useLibraryAccountController({
        logout: signOut,
        confirmLogout,
        switchCleanup: providerSwitchCleanup,
    });
    const { providers: onlineProviders, activeProviderId } = useLibraryAccountProviders(accountController);
    const activeProvider = useMemo(
        () => resolveActiveProviderSummary(onlineProviders, activeProviderId),
        [activeProviderId, onlineProviders],
    );
    // 保留 App 对整张账户表的订阅（原先 useOnlineProviderPlatform 订阅它）：底栏与命令面板的收藏心形
    // （resolveSongLiked → omni.isSongLiked）经 getState 读各平台的 likedSongIds，账户摘要里没有它，
    // 只订阅 controller 快照的话收藏之后心形不会当场更新。取值没有用处。
    useOnlineProviderAccountStore(state => state.accounts);
    // 当前平台的已喜欢列表：resolveSongLiked 判在线歌的「已收藏」只认这个集合。
    const likedOnlineSongIds = useOnlineProviderAccountStore(
        state => state.accounts[state.activeProviderId]?.likedSongIds,
    );
    const likedSongIds = useMemo(
        () => new Set<string | number>(likedOnlineSongIds ?? []),
        [likedOnlineSongIds],
    );
    const handleActiveProviderSyncData = useCallback(async () => {
        const providerId = activeProviderId;
        setIsProviderSyncing(true);
        try {
            const synced = await onlineProviderRefreshers[providerId]?.();
            const refreshedAccount = useOnlineProviderAccountStore.getState().accounts[providerId];
            const authExpired = synced === false && refreshedAccount?.error === 'auth-required';
            setStatusMsg({
                type: synced === false ? 'error' : 'success',
                text: synced === false
                    ? t(authExpired ? 'status.loginExpired' : 'status.syncFailed')
                    : t('status.dataSynced'),
            });
        } catch (error) {
            console.warn('[OmniSync] Provider data sync failed', { providerId, ...errorFields(error) });
            setStatusMsg({ type: 'error', text: t('status.syncFailed') });
        } finally {
            setIsProviderSyncing(false);
        }
    }, [activeProviderId, onlineProviderRefreshers, setStatusMsg, t]);
    const refreshActiveProviderPlaylists = useCallback(
        () => omni.refreshProviderPlaylists(activeProviderId),
        [activeProviderId],
    );
    useAccountReads();
    const {
        stageStatus,
        setStageStatus,
        stageSource,
        stageActiveEntryKind,
        stageLyricsSession,
        stageMediaSession,
        nowPlayingConnectionStatus,
        nowPlayingTrack,
        nowPlayingLyricPayload,
        nowPlayingProgressMs,
        nowPlayingProgressQuality,
        nowPlayingPaused,
        nowPlayingDebugInfo,
        isNowPlayingStageActive,
        isPlayerCapStageActive,
        getPlayerCapDisplayTime,
        playerCapConnectionStatus,
        playerCapPlayers,
        mainPlaybackSnapshotRef,
        stageLyricsClockRef,
        syncStageLyricsClock,
        getSyntheticStageLyricsTime,
        syncNowPlayingClock,
        getNowPlayingDisplayTime,
        loadStageSessionIntoPlayback,
        restoreStagePlaybackHandoff,
        clearPersistedStagePlaybackCache,
        openStagePlayer,
        leaveStagePlayback,
        interruptStagePlaybackForMainTransition,
        clearStagePlaybackSession,
    } = useStagePlaybackController({
        isDev,
        isElectronWindow,
        audioRef,
        shouldAutoPlayRef: shouldAutoPlay,
        pendingResumeTimeRef,
        lastAudioRecoverySourceRef,
        currentOnlineAudioUrlFetchedAtRef,
        setLyrics,
        setIsLyricsLoading,
        navigateToPlayer,
    });

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

    const { setupAudioAnalyzer, cacheSongAssets, cacheSongAssetsFor, adoptActiveDeckSource } = usePlaybackAudioBridge({
        audioRef,
        localSongs,
        isLyricsLoading,
        shouldAutoPlayRef: shouldAutoPlay,
        audioContextRef,
        analyserRef,
        gainNodeRef,
        connectDecks: automix.connectDecks,
        getActiveChain: automix.getActiveChain,
        suppressAutoplayRef: automix.suppressAutoplayRef,
        isAutoplayHeld: automix.autoplayHeld,
        syncOutputGain,
        getTargetPlaybackVolume,
        getCoverUrl,
        isTransitionAudible: automix.isTransitionAudible,
    });

    const handleTranscodeFallback = useTranscodeFallback({
        audioSrc,
        localSongs,
        currentTime,
        pendingResumeTimeRef,
        shouldAutoPlayRef: shouldAutoPlay,
        getRecoveryTarget: automix.getRecoveryTarget,
        replaceRecoverySource: automix.replaceRecoverySource,
        clearFailedWarmSource: automix.clearFailedWarmSource,
        abortTransition: automix.abortTransition,
        handleTailEnded: automix.handleTailEnded,
        skipAfterPlaybackFailure,
    });

    // Now the writer exists, point the automix settle path at it. A track that blends out never fires
    // `ended`, so this is the only place its assets get cached; the cover is derived from the exit
    // song's own metadata inside `cacheSongAssetsFor` rather than from the now-arriving track's view.
    cachePlayedOutRef.current = (song, src) => { void cacheSongAssetsFor(song, src); };

    /**
     * The two controls that mean something different while a blend is in flight, held as refs.
     *
     * Both are implemented far below, once automix and playSong exist, and both are needed above
     * that point - the transport controller here, the remote bridge a little further down. A ref
     * plus a stable wrapper is what lets those be wired now and written later without either one
     * re-subscribing every render.
     */
    const seekDuringTransitionRef = useRef<(time: number) => boolean>(() => false);
    const pauseDuringTransitionRef = useRef<() => boolean>(() => false);
    /** Shared by every entry point that can seek while a blend is in flight. */
    const seekDuringTransition = useCallback((time: number) => seekDuringTransitionRef.current(time), []);
    const handlePauseDuringTransition = useCallback(() => pauseDuringTransitionRef.current(), []);

    const { resumePlayback, pausePlayback } = usePlaybackTransportController({
        stageActiveEntryKind,
        isNowPlayingStageActive,
        audioRef,
        audioContextRef,
        stageLyricsClockRef,
        setupAudioAnalyzer,
        syncOutputGain,
        getTargetPlaybackVolume,
        shouldRefreshCurrentOnlineAudioSource,
        recoverOnlinePlaybackSource,
        getSyntheticStageLyricsTime,
        syncStageLyricsClock,
        pauseDuringTransition: handlePauseDuringTransition,
        isTransitionAudible: automix.isTransitionAudible,
        nativeTakesRef,
    });
    useNavidromeScrobbleReporter({
        audioRef,
        currentSong,
        activeDeck: automix.activeDeck,
    });
    usePlaybackReporter({
        audioRef,
        currentSong,
        activeDeck: automix.activeDeck,
    });
    useRecentPlaysRecorder({
        audioRef,
        currentSong,
        activeDeck: automix.activeDeck,
    });

    const {
        mediaSessionPlayRef,
        mediaSessionPauseRef,
        mediaSessionPrevRef,
        mediaSessionNextRef,
        taskbarHasTrackRef,
        taskbarPlayerStateRef,
    } = useTransportCommandRefs({ resumePlayback, pausePlayback, handlePrevTrack, handleNextTrack });

    useMediaSessionBridge({
        audioRef,
        // All three describe the DISPLAYED track, and that is the whole of the fix: the metadata,
        // the clock the position is read off, and the source the readiness guard compares against.
        // Pairing the displayed song with the ACTIVE deck put the outgoing track's title over the
        // incoming track's duration and progress for the length of every blend - the system panel
        // named one song and counted another. `audioSrc` moves with the element or the guard fails
        // for the whole blend and the panel stops updating instead.
        getDisplayAudioElement: automix.getDisplayElement,
        audioSrc: automix.tailSrc ?? audioSrc,
        currentSong: displaySong,
        cachedCoverUrl: displayCoverUrl ?? cachedCoverUrl,
        playerState: displayPlayerState,
        isNowPlayingStageActive,
        unknownArtistLabel: t('ui.unknownArtist'),
        mediaSessionPlayRef,
        mediaSessionPauseRef,
        mediaSessionPrevRef,
        mediaSessionNextRef,
        isNowPlayingControlDisabledRef,
    });

    // Capacitor Android 专有：把播放状态接到原生前台服务，换通知栏媒体控制，
    // 并让进程拿到前台优先级 —— 否则应用切到后台时 WebView 的 fetch 会被节流挂住，
    // 自动切下一首就拿不到歌曲地址。非 Android 平台直接空转。
    //
    // seekMainAudio 定义在下面（它依赖这批 transport 回调），而通知栏的拖动事件
    // 是异步来的，所以用 ref 接过声明顺序，不把它提前。
    const seekMainAudioRef = useRef<(time: number) => void>(() => { });
    // 通知栏那颗心要的两个值：这首歌现在喜不喜欢、这个动作现在能不能用。
    //
    // 「能不能用」必须和侧边面板同一份判定（resolveLikeAvailability）—— 各平台支不支持
    // 收藏、正由外部 Stage 播放时归谁管，都在那一份里。分头判的话会出现面板置灰、
    // 通知栏却能点，点下去只得到一个「收藏失败」。
    // 「混音过渡中 / 无音源」那一档传 false：它是面板里的一瞬间，通知栏感知不到，
    // 而且它会随下一次元数据推送自己纠正回来。
    const nativeSongLiked = resolveSongLiked(displaySong, { isLocalSongLiked, starredNavidromeSongIds, likedSongIds });
    const nativeCanLikeSong = !resolveLikeAvailability(displaySong, false, isNowPlayingStageActive).disabled;
    useCapacitorPlaybackBridge({
        currentSong: displaySong,
        cachedCoverUrl: displayCoverUrl ?? cachedCoverUrl,
        playerState: displayPlayerState,
        mediaSessionPlayRef,
        mediaSessionPauseRef,
        mediaSessionPrevRef,
        mediaSessionNextRef,
        // 通知栏那条进度条的位置来源。原生播放时必须直接问引擎：后台里 rAF 被停掉，
        // `currentTime` 那个 motion signal 会停在最后一次前台读数上 —— 于是通知栏
        // 显示 00、拖动改完又被下一拍推回 00。
        getCurrentTime: () => (nativeTakesRef.current ? nativePlaybackEngine.getPositionSec() : currentTime.get()),
        onSeek: (seconds) => seekMainAudioRef.current(seconds),
        isLiked: nativeSongLiked,
        canLike: nativeCanLikeSong,
        // 与面板里的喜爱按钮同一个动作：能不能用、状态怎么存都归它，原生不自己记账。
        onToggleLike: handleLike,
    });

    // Capacitor Android 专有：把当前行与行内进度喂给原生歌词动态壁纸。
    // 壁纸是另一个组件，读不到 React 状态，只能由这里主动推过去。
    useLyricsWallpaperFeed({
        lyrics,
        // 原生播放时位置只在播放器手里：`currentTime` 那个 motion signal 由 rAF 写，
        // 后台一藏就被 Chromium 停掉，锚点会冻在最后一次前台读数上。桌面歌词（壁纸 /
        // 悬浮）靠的正是这个锚点，所以取数要原生优先。
        getCurrentTime: () => (nativeTakesRef.current ? nativePlaybackEngine.getPositionSec() : currentTime.get()),
        title: displaySong?.name ?? null,
        artist: displaySong ? getSongArtistLabel(displaySong) : null,
        coverUrl: displayCoverUrl ?? cachedCoverUrl,
        playerState: displayPlayerState,
        duration,
        // 让壁纸沿用 App 当前的主题色、底色与动效强度，避免两套色调各画各的。
        accentColor: theme?.accentColor ?? null,
        backgroundColor: theme?.backgroundColor ?? null,
        // 叠层是另一个 WebView，拿不到 App 的主题对象：主文本色 / 次色也得一并推过去，
        // 否则它只能用内置主题打底，AI 主题换上去颜色一点没变。
        primaryColor: theme?.primaryColor ?? null,
        secondaryColor: theme?.secondaryColor ?? null,
        // 整份主题：AI 主题的 wordColors / lyricsIcons 这类字段一个都传不过去的话，
        // 叠层画出来就只有配色变了，「AI 主题的效果」一点都没有。
        theme,
        // 叠层 / 壁纸那一推要等它落定再发：分两次推（先旧主题、再 AI 主题）就是切歌闪两下。
        themePending: themeSettling,
        animationIntensity: theme?.animationIntensity ?? null,
    });

    // Android 专有：把屏幕钉住不熄。两个开关（界面设置的常驻常亮、播放设置的播放时常亮）
    // 在这里取或后过桥，都默认关。
    useScreenAwake();

    // Android 专有：把当前歌曲与歌词推给状态栏歌词（Lyricon）。
    useLyriconFeed({
        lyrics,
        getCurrentTime: () => (nativeTakesRef.current ? nativePlaybackEngine.getPositionSec() : currentTime.get()),
        title: displaySong?.name ?? null,
        artist: displaySong ? getSongArtistLabel(displaySong) : null,
        // id 在部分音源上是数字，Lyricon 只用它判断换没换歌，统一成字符串即可。
        songId: displaySong?.id == null ? null : String(displaySong.id),
        duration,
        playerState: displayPlayerState,
    });

    // Android 专有：系统栏默认显示，只有可视化歌词页面才隐藏（判定在这里，原生只执行）。
    useImmersiveLyricsBars(currentView);

    // Android 专有 + ColorOS 16+ 专有：把歌词写进 MediaMetadata["lyricInfo"]，
    // 交给系统锁屏 / AOD 歌词页原生渲染。不是那台机器时整条通道不启动（判定在原生侧）。
    useColorOsLyricFeed({
        lyrics,
        song: displaySong,
        duration,
    });

    const {
        exportState,
        handleExportCommand,
    } = useElectronVideoExportController({
        isElectronWindow,
        audioRef,
        navigateToPlayer,
        pausePlayback,
        resumePlayback,
    });

    const {
        publishStagePlayerPlaybackUpdate,
    } = useElectronPlaybackBridge({
        isElectronWindow,
        playerChromeVisibilityMode,
        onRemotePlayerChromeVisibilityModeCycle: cyclePlayerChromeVisibilityMode,
        onRemotePlayerChromeVisibilityModeSet: setPlayerChromeVisibilityModeTo,
        isStagePlayerSnapshotEnabled: stageStatus?.enabled === true,
        isNowPlayingControlDisabledRef,
        audioRef,
        // The deck the held picture belongs to. Its song, lyrics, cover, duration and transport are
        // read from the display selectors inside the bridge; this is the element that goes with them.
        getDisplayAudioElement: automix.getDisplayElement,
        effectiveLoopMode,
        isNowPlayingStageActive,
        mediaSessionPlayRef,
        mediaSessionPauseRef,
        mediaSessionPrevRef,
        mediaSessionNextRef,
        getSyntheticStageLyricsTime,
        syncStageLyricsClock,
        taskbarHasTrackRef,
        taskbarPlayerStateRef,
        exportState,
        lyricTimelineOffsetMs: effectiveLyricTimelineOffsetMs,
        onRemoteExportCommand: handleExportCommand,
        onExternalPlayRequest: handleStageExternalPlayRequest,
        onRemoteCycleLoopMode: handleToggleLoopMode,
        onRemoteTransitionSeek: seekDuringTransition,
        publishTrackTransition: automixEnabled,
        isTrackTransitionAudible: automix.isTransitionAudible,
        // Keyed on the displayed track, so the like state matches the song the remote is showing
        // while a blend is held rather than the one arriving underneath it.
        isLiked: resolveSongLiked(displaySong, { isLocalSongLiked, starredNavidromeSongIds, likedSongIds }),
        onLike: handleLike,
    });

    usePlaybackVisualizerBridge({
        audioRef,
        analyserRef,
        isTransitionAudible: automix.isTransitionAudible,
        // The loop below is what actually drives the progress bar and the lyric read-head, sixty
        // times a second off whichever deck it is pointed at. Both have to be the held picture's,
        // or the bar and the lyrics run on the incoming track under the outgoing one's title.
        getDisplayElement: automix.getDisplayElement,
        animationFrameRef,
        effectiveLoopMode,
        isNowPlayingStageActive,
        isPlayerCapStageActive,
        stageActiveEntryKind,
        stageLyricsSession,
        stageLyricsClockRef,
        getSyntheticStageLyricsTime,
        syncStageLyricsClock,
        getNowPlayingDisplayTime,
        getPlayerCapDisplayTime,
        syncNowPlayingClock,
        lyricTimelineOffsetMs: effectiveLyricTimelineOffsetMs,
        incomingLyricTimelineOffsetMs,
    });

    /*
     * 原生播放（P1）的接线。
     *
     * 这里只接「事件 → 状态机」那一半（时长、播完、播不出来）。进度条与歌词的时钟不在这里写：
     * 它们在 usePlaybackVisualizerBridge 的 rAF 里统一从 `nativePlaybackEngine` 读，
     * 两个写手抢同一个 motion signal 只会互相抹掉。
     */
    useNativePlaybackRuntime({
        enabled: nativeActive,
        audioSrc,
        shouldAutoPlayRef: shouldAutoPlay,
        isLyricsLoading,
        getTargetPlaybackVolume,
        repeatOne: effectiveLoopMode === 'one',
        onEnded: () => {
            cacheSongAssets();
            void handleNextTrack({ allowStopOnMissing: true, shouldNavigateToPlayer: false });
        },
        onError: () => {
            setStatusMsg(prev => (prev?.persistent ? prev : { type: 'error', text: t('status.playbackError') }));
            setPlayerState(PlayerState.IDLE);
        },
    });

    const {
        togglePlay,
        toggleLoop,
        handleChangeReplayGainMode,
        handleContainerClick,
        handleFmTrash,
    } = usePlaybackInteractionBridge({
        stageActiveEntryKind,
        isNowPlayingStageActive,
        audioRef,
        // Play-vs-pause cannot be decided off the active deck mid-blend: that is the arriving track,
        // and it is silent for the whole lead.
        isTransitionAudible: automix.isTransitionAudible,
        nativeTakesRef,
        // The arrow keys check for a blend first, the way the bar and the remote do, rather than
        // writing to the active deck - which mid-blend is not the deck the listener is watching.
        seekDuringTransition,
        stageLyricsClockRef,
        cyclePlayerChromeVisibilityMode,
        handleNextTrack,
        handlePrevTrack,
        navigateBackFromPlayer,
        pausePlayback,
        resumePlayback,
        syncStageLyricsClock,
    });

    /*
     * 歌词页左右滑动切歌：左滑下一首，右滑上一首。
     *
     * 手势挂在最底下那层可视化背景上（z-0 那层）。播放条、按钮、歌词轨都是它的兄弟
     * 节点或自带手势，所以拖进度条、滚歌词不会误触；反过来在歌词区域上划，事件会
     * 冒泡上来，一样算数。判定（阈值 / 横纵比）在 utils/playerSwipeGesture。
     *
     * 只在播放页生效：同一层在首页和 Lattice 底下也铺着当背景，在那里划一下就切歌
     * 是既看不见也猜不到的。
     */
    const handlePlayerSwipeNext = useCallback(() => {
        void handleNextTrack();
    }, [handleNextTrack]);

    const handlePlayerSwipePrev = useCallback(() => {
        handlePrevTrack();
    }, [handlePrevTrack]);

    const isPlayerSwipeEnabled = currentView === 'player' && !isPanelOpen;

    const {
        onPointerDown: handleSwipePointerDown,
        onPointerMove: handleSwipePointerMove,
        onPointerUp: handleSwipePointerUp,
        onPointerCancel: handleSwipePointerCancel,
        consumeSuppressedClick: consumeSwipeSuppressedClick,
    } = usePlayerSwipeGesture({
        enabled: isPlayerSwipeEnabled,
        onNext: handlePlayerSwipeNext,
        onPrev: handlePlayerSwipePrev,
    });

    /*
     * HDR 投影的二次确认：投到挡风玻璃上时屏幕是反着看的，误触概率比平时高得多，
     * 而界面一收反射里就只剩一块黑。所以那档里「点空白收起界面」要连点两次。
     * 开关状态从服务那边订阅 —— 这颗开关在控制面板里，App 拿不到它的 props。
     */
    const hdrProjectionActive = useHdrProjectionActive();
    const confirmHdrExit = useHdrExitConfirm({
        enabled: hdrProjectionActive,
        hint: t('ui.hdrProjectionExitHint', '再点一次退出'),
    });

    /*
     * HDR 投影下界面**整个收掉**：投到玻璃上时进度条、按钮、标题栏全是多余的，
     * 反射里多一块控件就多一块晃眼的东西。
     *
     * 走「常驻隐藏」那一档而不是直接把 isPlayerChromeHidden 按下去 —— 后者在
     * auto-hide 那一档里指针一有动静就被唤回来，而这里要的是一直藏到关掉为止。
     * 关掉时把进 HDR 之前那一档还回去（原来是自动隐藏就还是自动隐藏），
     * 不替用户改掉他的设置。
     *
     * ⭐ 光收控件不够 —— 控件那一档只管**播放页**那一层（buildAppOverlaysModel 里
     * isHidden 还带着 `currentView === 'player'`），首页 / 资料库的头部、页签、侧栏、
     * 底部播放条都在别的层上，一个都收不掉。而「投到玻璃上」要的是**整屏只剩可视化
     * 与歌词**：所以进 HDR 时把人带到播放页（本来就在那儿的不动），并把还开着的面板
     * 收掉（HDR 那颗开关就在控制面板里 —— 不收的话屏上盖着一块面板，看上去就是
     * 「开了 HDR 什么都没发生」）。
     */
    const chromeModeBeforeHdrRef = useRef<PlayerChromeVisibilityMode | null>(null);
    /** 进 HDR 那一刻人是不是**本来就在**播放页：不是的话播放页是我们带过去的，关掉时要还回去。 */
    const enteredHdrOnPlayerRef = useRef(true);
    useEffect(() => {
        if (hdrProjectionActive) {
            if (chromeModeBeforeHdrRef.current === null) {
                chromeModeBeforeHdrRef.current = playerChromeVisibilityMode;
                enteredHdrOnPlayerRef.current = currentView === 'player';
            }
            setPlayerChromeVisibilityModeTo('always-hidden', { silent: true });
            if (isPanelOpen) setIsPanelOpen(false);
            if (currentView !== 'player') navigateToPlayer();
            return;
        }
        if (chromeModeBeforeHdrRef.current === null) return;
        setPlayerChromeVisibilityModeTo(chromeModeBeforeHdrRef.current, { silent: true });
        chromeModeBeforeHdrRef.current = null;
        // 进来时不在播放页（是我们自己把人带过去的）：关掉的时候走播放页自己那条返回。
        // 本来就在播放页的不动 —— 那是他自己待的地方，替他退出去反而莫名。
        if (!enteredHdrOnPlayerRef.current && currentView === 'player') navigateBackFromPlayer();
    }, [currentView, hdrProjectionActive, isPanelOpen, navigateBackFromPlayer, navigateToPlayer,
        playerChromeVisibilityMode, setIsPanelOpen, setPlayerChromeVisibilityModeTo]);

    /*
     * 开起来弹一条。这一档下界面是整屏收掉的，屏幕上只剩可视化与提示条 —— 没有这句，
     * 用户看着一块屏幕无从判断它到底生效没有（「黑屏」「点击没反应」就是这么来的）。
     */
    useEffect(() => {
        if (!hdrProjectionActive) return;
        setStatusMsg({
            type: 'info',
            text: t('ui.hdrProjectionOnHint', 'HDR 投影已开启 · 点两次空白退出'),
            nonce: Date.now(),
        });
    }, [hdrProjectionActive, setStatusMsg, t]);

    /*
     * 点击歌词页的空白：控件显隐翻一下，「再点一下恢复」就是翻回来。
     *
     * 面板开着的时候这一次点击的意思是「关掉它」——顺手把整页控件也藏起来等于连着两个动作，
     * 所以先只收面板。（面板由 handleContainerClick 管，它在别处也挂着这个语义。）
     *
     * 这一层只铺着可视化渲染：播放条、按钮、标题栏都是它的兄弟节点，点控件不会冒泡到这里，
     * 所以「空白」不用再自己判断点到了哪儿。
     *
     * 只有歌词页算数：这一层在首页和 Lattice 底下也铺着（当背景），在那里翻出来的是
     * 「下次进歌词页控件是藏着的」，而点的人当时什么也没看见。
     *
     * auto-hide 模式下不动手：那边 pointerdown / pointerup 会在每次点击时先把控件显出来
     * （见 usePlayerChromeAutoHide），因此这里的 toggle 永远读到「显」、只会一路藏下去，
     * 「再点一下恢复」当场失效。那一档的显隐本来归空闲时钟管，点一下让它显出来正是它的语义。
     *
     * HDR 投影下多一道确认（useHdrProjectionExit）：投到挡风玻璃上时屏幕是反着看的，
     * 误触概率高得多，而界面一收反射里只剩一块黑 —— 连该点哪儿叫回来都看不出来。
     * 所以那档里第一次点只弹一句提示，再点一次才收。**不铺遮罩**，滑动切歌照旧。
     */
    const handleVisualSurfaceClick = useCallback(() => {
        // 滑动切完歌浏览器照旧补一个 click，那不是「点了一下空白」，别翻控件显隐。
        if (consumeSwipeSuppressedClick()) return;
        if (isPanelOpen) {
            handleContainerClick();
            return;
        }
        if (hidePlayerChromeOnTap && currentView === 'player' && playerChromeVisibilityMode !== 'auto-hide') {
            /*
             * HDR 下「点空白退出」退的是**投影本身**（横屏 / 镜像 / 亮度一起还原），
             * 不是把收起来的界面再翻出来 —— 界面本来就是整屏收着的，翻出来翻回去看着
             * 跟没反应一样，而用户要的是退出这个模式。
             */
            confirmHdrExit(hdrProjectionActive
                ? disableHdrProjection
                : () => setIsPlayerChromeHidden(prev => !prev));
        }
    }, [confirmHdrExit, consumeSwipeSuppressedClick, currentView, handleContainerClick, hidePlayerChromeOnTap, hdrProjectionActive, isPanelOpen, playerChromeVisibilityMode, setIsPlayerChromeHidden]);

    const { personalFmSelection, personalFmSelectionLabel, isPersonalFmModeSupported, setPersonalFmSelection } = usePersonalFmModeController({
        isFmMode,
        currentSong,
        playSong,
        t: (key: string, fallback?: string) => t(key, fallback ?? ''),
    });

    // Wallpaper mode removes normal window semantics (no minimize/maximize/close, no dragging, and
    // click-through is managed by the main process), so the whole custom titlebar strip stays off.
    const usesCustomWindowChrome = isElectronWindow && !wallpaperMode;
    const isPlayerPageTransparent = transparentPlayerBackground || enablePlayerPageNativeBlur;
    const shouldUseTransparentAppBackground = isPlayerPageTransparent;
    const appStyle = useMemo(() => buildAppStyle({
        bgMode,
        isDaylight,
        theme,
        daylightTheme: DAYLIGHT_THEME,
        defaultTheme: DEFAULT_THEME,
        transparentBackground: shouldUseTransparentAppBackground,
    }), [bgMode, isDaylight, shouldUseTransparentAppBackground, theme]);
    /*
     * 主题变量原本只挂在 App 根节点的 inline style 上，而弹层、面板这些 portal 到 body 的
     * 节点读不到它 —— 关掉毛玻璃时它们要靠 --bg-color 撑出不透明底色，拿不到就会掉回
     * 深色兜底，在浅色主题下变成一块黑板。这里往 <html> 同步一份。
     */
    useEffect(() => {
        const backgroundColor = (appStyle as Record<string, string>)['--bg-color'];
        if (backgroundColor) {
            document.documentElement.style.setProperty('--bg-color', backgroundColor);
        }
    }, [appStyle]);
    const { visualizerTheme, visualizerSubtitleTheme, visualizerGeometrySeed } = useMemo(() => buildVisualizerTheme({
        appStyle,
        theme,
        lyricsFontStyle,
        lyricsFontWeight,
        lyricsCustomFontFamily,
        lyricsFontFallbackFamilies,
        subtitleFontInheritsLyrics,
        subtitleFontStyle,
        subtitleFontWeight,
        subtitleFontFamily,
        subtitleFontFallbackFamilies,
        // The displayed song, not the playing one. This id is the visualizer's geometry seed, and a
        // visualizer with no "song changed" event of its own infers one from the seed changing - the
        // diorama flies its camera to a whole new corridor on it. Fed the live id, that flight starts
        // the moment a blend arms, builds the new scene out of the lyrics still on screen, and lands
        // back on the same song: a full song-change animation that changes nothing, followed by the
        // real one when the hold releases.
        currentSongId: displaySong?.id,
        visualizerMode,
    }), [
        appStyle,
        displaySong?.id,
        lyricsCustomFontFamily,
        lyricsFontFallbackFamilies,
        lyricsFontStyle,
        lyricsFontWeight,
        subtitleFontFallbackFamilies,
        subtitleFontFamily,
        subtitleFontInheritsLyrics,
        subtitleFontStyle,
        subtitleFontWeight,
        theme,
        visualizerMode,
    ]);
    const isNowPlayingControlDisabled = isNowPlayingStageActive;

    useElectronWindowChrome();
    const {
        isPlayerView,
        shouldPauseVisualizerBackground,
        shouldHidePlayerProgressBar,
        shouldHidePlayerTranslationSubtitle,
        shouldHidePlayerRightPanelButton,
        canToggleCurrentPlayback,
    } = useMemo(() => buildPlayerViewFlags({
        currentView,
        disableHomeDynamicBackground,
        hidePlayerProgressBar,
        hidePlayerTranslationSubtitle,
        hidePlayerRightPanelButton,
        isNowPlayingControlDisabled,
        activePlaybackContext,
        stageActiveEntryKind,
        audioSrc,
        duration,
    }), [
        activePlaybackContext,
        audioSrc,
        currentView,
        disableHomeDynamicBackground,
        duration,
        hidePlayerProgressBar,
        hidePlayerRightPanelButton,
        hidePlayerTranslationSubtitle,
        isNowPlayingControlDisabled,
        stageActiveEntryKind,
    ]);
    // 播放页空闲时连指针一起隐藏。复用控制栏的自动隐藏时钟（3 秒无鼠标移动），不新开计时器：
    // 只有「自动隐藏」模式下才成立，`always-hidden` 是常驻隐藏、没有唤回时机，不参与。
    // 点击穿透（桌面宠物）也排除：那种状态下控制栏被钉成隐藏、鼠标移动不再唤回，跟着它走会把
    // 指针永久藏掉；而真正穿透时画的是下层窗口的指针，隐藏本来也没有收益。
    const shouldHidePlayerCursor = isPlayerView
        && autoHideCursorWithPlayerChrome
        && playerChromeVisibilityMode === 'auto-hide'
        && !isMainWindowClickThroughEnabled
        && isPlayerChromeHidden;
    // 独立隐藏指针：空闲一段就自己藏起来，控制栏保持显示。与控制栏的自动隐藏互不依赖，谁满足谁藏。
    const idleCursorHidden = useIdleCursorHide(isPlayerView && hideCursorWhenIdle && !isMainWindowClickThroughEnabled);
    const isSettingsModalOpen = settingsModalState.isOpen;
    const {
        obsBrowserSourceStatus,
        isObsBrowserSourceRendering,
        refreshObsBrowserSourceStatus,
    } = useObsBrowserSourcePublisher({
        isElectronWindow,
        audioRef,
        getDisplayAudioElement: automix.getDisplayElement,
        stageSource,
        coverUrl: displayCoverUrl,
        offsetMs: effectiveLyricTimelineOffsetMs,
        theme: visualizerTheme,
        subtitleTheme: visualizerSubtitleTheme,
        hideTranslationSubtitle: shouldHidePlayerTranslationSubtitle,
        seed: visualizerGeometrySeed,
    });
    const {
        lyricApiStatus,
        setLyricApiEnabled,
    } = useLyricApiPublisher({
        isElectronWindow,
        lyrics,
        offset: effectiveLyricTimelineOffsetMs,
        audioSrc,
    });
    const canGenerateAITheme = Boolean((lyrics?.lines.length ?? 0) > 0 || currentSong?.isPureMusic);
    const generateCurrentSongTheme = useCallback(() => {
        void generateAITheme(lyrics, currentSong);
    }, [currentSong, generateAITheme, lyrics]);
    const toggleDaylightMode = useCallback(() => {
        handleToggleDaylight(!isDaylight);
    }, [handleToggleDaylight, isDaylight]);
    const currentSearchSourceTabInPalette = useMemo(() => resolveCommandPaletteSearchSource(
        currentSong,
        searchSourceTab,
        activeProviderId,
    ), [activeProviderId, currentSong, searchSourceTab]);
    const toggleBrowserFullscreen = useCallback(async () => {
        if (typeof window !== 'undefined' && window.electron?.toggleFullscreenWindow) {
            return window.electron.toggleFullscreenWindow();
        }

        if (typeof document === 'undefined') {
            return false;
        }

        try {
            if (document.fullscreenElement) {
                await document.exitFullscreen();
                return true;
            }

            await document.documentElement.requestFullscreen();
            return true;
        } catch (error) {
            console.warn('[CommandPalette] Failed to toggle browser fullscreen:', error);
            return false;
        }
    }, []);
    const toggleRemoteControlWindow = useCallback(async () => {
        if (!window.electron?.toggleRemoteControl) {
            return false;
        }

        return window.electron.toggleRemoteControl();
    }, []);
    const toggleMainWindowAlwaysOnTop = useCallback(async () => {
        if (!window.electron?.getMainWindowAlwaysOnTop || !window.electron?.setMainWindowAlwaysOnTop) {
            return false;
        }

        const enabled = await window.electron.getMainWindowAlwaysOnTop();
        await window.electron.setMainWindowAlwaysOnTop(!enabled);
        return true;
    }, []);
    const handleSleepTimerExpireFallback = useCallback(() => {
        pausePlayback();
        setStatusMsg({ type: 'info', text: t('notifications.sleepTimerPlaybackPaused') });
    }, [pausePlayback, setStatusMsg, t]);
    // 到点了要暂停就暂停，要退出就在停完之后退出应用 —— 「怎么结束」现在由那一栏自己选，
    // 这里只是把选择连同三种定时方式（分钟后 / 小时后 / 到几点）交给倒计时。
    useSleepTimer({
        enabled: sleepTimerEnabled,
        plan: {
            mode: sleepTimerMode,
            hours: sleepTimerHours,
            minutes: sleepTimerMinutes,
            clockHour: sleepTimerClockHour,
            clockMinute: sleepTimerClockMinute,
        },
        endAction: sleepTimerEndAction,
        onExpireFallback: handleSleepTimerExpireFallback,
    });
    // Saving or clearing a segmentation has to re-lay the current song's lyrics, so it needs the
    // same preview-then-setLyrics pair the lyric filter saver uses. currentSongFullRef rather than
    // currentSong so the actions stay stable across renders.
    const lyricSegmentationActions = useMemo(() => createLyricSegmentationActions({
        getCurrentSong: () => currentSongFullRef.current,
        loadCurrentSongLyricPreview,
        setLyrics: setLyricsStable,
    }), [loadCurrentSongLyricPreview, setLyricsStable]);
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
        isSongLiked: resolveSongLiked(displaySong, { isLocalSongLiked, starredNavidromeSongIds, likedSongIds }),

        navigateToHome,
        navigateToPlayer,
        navigateToLattice,
        toggleBrowserFullscreen,
        toggleRemoteControlWindow,
        toggleMainWindowAlwaysOnTop,


        toggleTransparentBackground: () => { void toggleTransparentModeWithHandoff(!transparentPlayerBackground); },
        toggleDaylightMode,
        cycleLyricStaffPolicy: () => handleSaveLyricFilterPattern({
            pattern: lyricFilterPattern,
            filterEnabled: lyricFilterEnabled,
            staffPolicy: nextLyricStaffPolicy(lyricStaffPolicy),
            staffMinDwellSeconds: lyricStaffMinDwellSeconds,
            staffAbsorbMode: lyricStaffAbsorbMode,
            staffPattern: lyricStaffPattern,
        }),
        cycleLyricStaffAbsorbMode: () => handleSaveLyricFilterPattern({
            pattern: lyricFilterPattern,
            filterEnabled: lyricFilterEnabled,
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

    // 两面墙（bravais 与 Lattice）右下角工具面板的宿主动作：命令面板的同一套命令与队列操作，host 身份稳定。
    const wallToolsHost = useAppWallToolsHost({
        invokeCommandById: commandPalette.invokeCommandById,
        canInvokeCommandById: commandPalette.canInvokeCommandById,
        isGeneratingTheme,
        previewVolume: handlePreviewVolume,
        navigateToPlayer,
        playQueue,
        playSong,
        moveQueueSongToNext,
        moveQueueSongToEnd,
        removeQueueSong,
        moveQueueSong,
        clearQueue,
        saveCurrentQueueAsLocalPlaylist,
    });
    const homeModel = useHomeModel({
        account: accountController,
        activeProvider,
        playSong,
        navigateToPlayer,
        navigateToLattice,
        togglePlayback: togglePlay,
        enterPlaybackView: navigateFromPlayerCapsule,
        refreshOnlineProviderPlaylists: refreshActiveProviderPlaylists,
        user,
        playlists,
        cloudPlaylist,
        focusedPlaylistIndex,
        setFocusedPlaylistIndex,
        navigateToSearch,
        localSongs,
        localLibraryCatalog,
        localPlaylists,
        onRefreshLocalSongs,
        onAddLocalSongToQueue: handleLocalQueueAdd,
        localMusicState,
        setLocalMusicState,
        onAddNavidromeSongsToQueue: addNavidromeSongsToQueue,
        navidromeFocusedAlbumIndex,
        setNavidromeFocusedAlbumIndex,
        stageSource,
        openStagePlayer,
        theme,
        playAll: playOnlineQueueFromStart,
        addAllToQueue: addOnlineSongsToQueue,
        addSongToQueue: addOnlineSongToQueue,
        onStatusMessage: setStatusMsg,
        onOpenCollection: openHomeCollection,
        onPushCollection: pushCollection,
        onPopCollectionTo: popCollectionTo,
        onBackCollection: backCollection,
    });
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
    const appOverlaysModel = useAppOverlaysModel({
        theme,
        closeSearchView,
        handleSearchOverlaySubmit,
        handleSearchLoadMore,
        handleSearchResultPlay,
        handleSearchResultAddToQueue,
        handleSearchResultArtistOpen,
        handleSearchResultAlbumOpen,
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
                                lyricKeywordColoringEnabled={visualizerRendererModel.visualizerTunings.monet.keywordColoringEnabled}
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
            {/* 启动那一次：把上一版的媒体缓存搬进私有目录，搬的时候给一条提示。 */}
            <MediaCacheMigrationNotice />
            <FreeSoftwareNoticeModal
                isOpen={startupExperience.isFreeSoftwareNoticeOpen}
                isDaylight={isDaylight}
                onClose={startupExperience.closeFreeSoftwareNotice}
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
}
