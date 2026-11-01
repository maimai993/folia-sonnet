import { useAppPreferences } from '../../../hooks/useAppPreferences';
import { useBackgroundRenderPause } from '../../../hooks/useBackgroundRenderPause';
import { useCapacitorSystemBars } from '../../../hooks/useCapacitorSystemBars';
import { useElectronDisplaySleepBlocker } from '../../../hooks/useElectronDisplaySleepBlocker';
import { useLocalLibraryAutoScan } from '../../../hooks/useLocalLibraryAutoScan';
import { useLyricAnimationDirector } from '../../../hooks/useLyricAnimationDirector';
import { useMacWallpaperHitRegions } from '../../../hooks/useMacWallpaperHitRegions';
import { useNativeBackButton } from '../../../hooks/useNativeBackButton';
import { useOnlineSongMetadataHydration } from '../../../hooks/useOnlineSongMetadataHydration';
import { usePlayerChromeAutoHide } from '../../../hooks/usePlayerChromeAutoHide';
import { useRandomVisualizerMode } from '../../../hooks/useRandomVisualizerMode';
import { useStartupExperienceGate } from '../../../hooks/useStartupExperienceGate';
import { useStartupUpdatePrompt } from '../../../hooks/useStartupUpdatePrompt';
import { transitionCapabilities } from '../../../services/automix/stems';
import { initializeSyncCoordinator } from '../../../services/sync/syncCoordinator';
import { currentTime } from '../../../stores/motionSignals';
import { useAppChromeStore } from '../../../stores/useAppChromeStore';
import { useAppViewStore } from '../../../stores/useAppViewStore';
import { selectAudioSettingsSnapshot, useAudioSettingsStore } from '../../../stores/useAudioSettingsStore';
import { writeNativeLoopMode } from '../../../services/nativeQueueBridge';
import { writeNativeSettings } from '../../../services/nativeSettingsBridge';
import { useNativeAiConfigSync } from '../../../hooks/useNativeAiConfigSync';
import { useAutomixSettingsStore } from '../../../stores/useAutomixSettingsStore';
import { selectDesktopSettingsSnapshot, useDesktopSettingsStore } from '../../../stores/useDesktopSettingsStore';
import { useLibraryStore } from '../../../stores/useLibraryStore';
import { selectLyricSettingsSnapshot, useLyricSettingsStore } from '../../../stores/useLyricSettingsStore';
import { usePlaybackStore } from '../../../stores/usePlaybackStore';
import { selectPlayerChromeSettingsSnapshot, usePlayerChromeSettingsStore } from '../../../stores/usePlayerChromeSettingsStore';
import { useSearchNavigationStore } from '../../../stores/useSearchNavigationStore';
import { useSettingsModalStore } from '../../../stores/useSettingsModalStore';
import { selectSleepTimerSnapshot, useSleepTimerStore } from '../../../stores/useSleepTimerStore';
import { selectStageSettingsSnapshot, useStageSettingsStore } from '../../../stores/useStageSettingsStore';
import { setStatusMessage as setStatusMsg, useStatusMessage } from '../../../stores/useStatusMessageStore';
import { selectThemeSettingsSnapshot, useThemeSettingsStore } from '../../../stores/useThemeSettingsStore';
import { selectTypographySettingsSnapshot, useTypographySettingsStore } from '../../../stores/useTypographySettingsStore';
import { selectVisualizerSettingsSnapshot, useVisualizerSettingsStore } from '../../../stores/useVisualizerSettingsStore';
import { PlayerState, SongResult } from '../../../types';
import { PlayerChromeVisibilityMode } from '../../../types/remoteControl';
import { useVisualizerTunings } from '../../visualizer/useVisualizerTunings';
import { useBackgroundLyricHoldStore } from '../backgroundThrottling/backgroundLyricHoldStore';
import { useBackgroundLyricHold } from '../backgroundThrottling/useBackgroundLyricHold';
import { usePlaybackRuntimeRefs } from '../playback/usePlaybackRuntimeRefs';
import { useProviderNotices } from '../useProviderNotices';
import { useAndroidPlaybackOrientation } from '../../../hooks/useAndroidPlaybackOrientation';
import { useNativeLyricsSubscription } from '../../../hooks/useNativeLyricsSubscription';
import { getPlaybackSongKey } from '../../../utils/appPlaybackGuards';
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

// src/components/app/appWiring/useAppFoundation.ts
// App 的基础状态：各设置 store 的读取、播放器状态、音频运行期 refs、窗口外观与播放页控件的显隐。

export const useAppFoundation = () => {
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

    // 「进入可视化自动横屏」：Web 只上报「在不在播放页」，转不转由原生按设置判。
    useAndroidPlaybackOrientation();

    // 循环模式的启动同步：Web 这边从 localStorage 恢复了模式，但原生设置里还没有 ——
    // 不发一次的话，放完往哪走（原生的队列状态机）会一直按默认顺序，直到用户再动一次
    // 循环开关。放这里只做一次，后续变化由 handleSetLoopMode 自己下发。
    useEffect(() => {
        const mode = useAudioSettingsStore.getState().loopMode;
        void writeNativeLoopMode(
            mode === 'shuffle' ? 'all' : mode,
            mode === 'shuffle',
        );
    }, []);

    // AI 配置的启动同步与变化跟随：凭据只存原生，真正发请求的是原生。
    useNativeAiConfigSync();

    /*
     * 「无法播放时自动跳过」的启动同步，理由同上面的循环模式：这一项原生也读
     * （FoliaPlaybackService.onEntryUnplayable），而 Web 这边只写在 localStorage 里。
     * 不推一次的话，原生永远按默认的 true 走 —— Web 侧默认是 false，两边相反：
     * 用户明明关着，WebView 一冻结，原生兜底照样一首首跳过去。
     */
    useEffect(() => {
        let cancelled = false;
        let attempts = 0;
        const push = async () => {
            const merged = await writeNativeSettings({
                autoSkipUnplayable: useAudioSettingsStore.getState().autoSkipUnplayable,
                backgroundSilentSkip: useAudioSettingsStore.getState().backgroundSilentSkip,
                // 「播放淡入淡出」也归原生执行（音量斜坡在播放器里），启动时对一次表。
                playbackFade: useAudioSettingsStore.getState().playbackFadeEnabled,
                // 交叉淡化也是原生执行：开关与时长（秒 → 毫秒）在启动时对一次表。
                crossfadeEnabled: useAutomixSettingsStore.getState().automixEnabled,
                crossfadeMs: Math.round(useAutomixSettingsStore.getState().crossfadeMaxSec * 1000),
            });
            if (merged || cancelled || attempts >= 20) return;
            attempts += 1;
            setTimeout(() => {
                void push();
            }, 500);
        };
        void push();
        return () => {
            cancelled = true;
        };
    }, []);

    // 歌词由原生拉、原生推：这里只按 songKey 认领并渲染。
    // 自己拉会挂在 currentSong 的 effect 上，而原生派发的点歌绕过它 ——
    // 「切了歌单歌词不换」就是这么来的。
    useNativeLyricsSubscription(currentSong ? getPlaybackSongKey(currentSong) : null);

    const loadNavidromeFavorites = useCallback(async () => {
        if (!navidromeEnabled) {
            setStarredNavidromeSongIds(new Set());
            return;
        }

        const { getNavidromeConfig, navidromeApi } = await import('../../../services/navidromeService');
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

    return {
        activePlaybackContext, alwaysShowMainWindowTitlebar, analyserRef, animationFrameRef, audioContextRef,
        audioQuality, audioRef, audioSrc, autoHideCursorWithPlayerChrome, automixEnabled, automixRef,
        backgroundLyricHeld, blobUrlRef, cachedCoverUrl, canUseTransitionPerformance,
        currentOnlineAudioUrlFetchedAtRef, currentSong, currentSongFullRef, currentSongRef,
        cyclePlayerChromeVisibilityMode, devDebugCurrentLineIndex, disableHomeDynamicBackground, duration,
        enablePlayerPageNativeBlur, gainNodeRef, globalLyricTimelineOffsetMs, handleSetLyricFilterEnabled,
        handleSetLyricFilterPattern, handleSetLyricStaffAbsorbMode, handleSetLyricStaffMinDwellSeconds,
        handleSetLyricStaffPattern, handleSetLyricStaffPolicy, handleToggleLoopMode, handleToggleNavidromeEnabled,
        handleToggleTransparentPlayerBackground, hideCursorWhenIdle, hideFullscreenButton, hidePlayerChromeOnTap,
        hidePlayerProgressBar, hidePlayerRightPanelButton, hidePlayerTranslationSubtitle,
        isClickThroughToggleHotspotActive, isDaylight, isDev, isDevDebugOverlayVisible, isElectronWindow, isFmMode,
        isHomeFullyHidden, isLyricsLoading, isMainWindowClickThroughEnabled, isMuted, isNowPlayingControlDisabledRef,
        isPanelOpen, isPlayerChromeHidden, isProviderSyncing, isTitlebarRevealed, lastAudioRecoverySourceRef,
        loopMode, lyricFilterEnabled, lyricFilterPattern, lyricStaffAbsorbMode, lyricStaffMinDwellSeconds,
        lyricStaffPattern, lyricStaffPolicy, lyricTimelineOffsetMs, lyrics, lyricsCustomFontFamily,
        lyricsFontFallbackFamilies, lyricsFontStyle, lyricsFontWeight, lyricsLoadingWritesRef,
        onlinePlaybackRecoveryRef, pendingResumeTimeRef, pendingVolumePreviewRef, playQueue,
        playbackAutoSkipCountRef, playerBottomBarOffset, playerChromeVisibilityMode, playerState, queueAddBehavior,
        queueScrollRef, setAudioSrc, setCachedCoverUrl, setCurrentSong, setDaylightPreference, setDuration,
        setIsClickThroughToggleHotspotActive, setIsHomeFullyHidden, setIsLyricsLoading, setIsPanelOpen,
        setIsPlayerChromeHidden, setIsPlayerPanelGuideHotspotActive, setIsProviderSyncing, setLyricTimelineOffsetMs,
        setLyricsState, setPanelTab, setPlayQueue, setPlayerChromeVisibilityModeTo, setPlayerState,
        settingsModalState, shouldAutoPlay, showTransparentWindowBorder, sleepTimerClockHour, sleepTimerClockMinute,
        sleepTimerEnabled, sleepTimerEndAction, sleepTimerHours, sleepTimerMinutes, sleepTimerMode,
        stageTrackPillMode, stageTrackPillOnHome, starredNavidromeSongIds, startupExperience, statusMsg,
        subtitleFontFallbackFamilies, subtitleFontFamily, subtitleFontInheritsLyrics, subtitleFontStyle,
        subtitleFontWeight, t, transitionAnimation, transitionMode, transitionSettings, transparentPlayerBackground,
        updatePrompt, visualizerMode, volume, volumePreviewFrameRef, wallpaperMode
    };
};

export type AppFoundation = ReturnType<typeof useAppFoundation>;
