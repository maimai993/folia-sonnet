import type { AppFoundation } from './useAppFoundation';
import type { AppAudioOutput } from './useAppAudioOutput';
import { useAppNavigation } from '../../../hooks/useAppNavigation';
import { usePlayerBottomBarOffset } from '../../../hooks/usePlayerBottomBarOffset';
import { usePlayerBottomBarPositioningEntry } from '../../../hooks/usePlayerBottomBarPositioningEntry';
import { useReducedMotionFor } from '../../../hooks/useReducedMotionFor';
import { useThemeController } from '../../../hooks/useThemeController';
import { useThemeQuickEditorContext } from '../../../hooks/useThemeQuickEditorContext';
import { useFoliumHostBridge } from '../../../mods/runtime/hostBridge';
import { useFoliumAnimationIntensity } from '../../../mods/runtime/visualizer/hostAnimationIntensity';
import { registerAiThemeApplier, registerAiThemeProvider } from '../../../services/aiThemeApplyBridge';
import { DAYLIGHT_THEME, DEFAULT_THEME } from '../../../services/baseThemes';
import { useVisualizerAroundWall } from '../lattice/wallLayer';
import { useEffect } from 'react';

// src/components/app/appWiring/useAppThemeAndNavigation.ts
// 主题控制器、Folium 主题桥、视图导航与底栏定位。

type Input = AppFoundation & AppAudioOutput;

export const useAppThemeAndNavigation = (model: Input) => {
    const {
        coverUrl, isDaylight, isPanelOpen, playerBottomBarOffset, setDaylightPreference, setIsPanelOpen,
        setIsPlayerPanelGuideHotspotActive, t
    } = model;
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
        songThemePair,
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
    // Folium: let a mod drive the animation intensity of the playing theme.
    useFoliumAnimationIntensity(theme, setTheme);

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

    return {
        ...model,
        aiTheme, backCollection, bgMode, closeSearchView, currentView, customTheme, focusedPlaylistIndex,
        generateAITheme, getThemeParkSeedTheme, handleBgModeChange, handleResetTheme,
        handleThemeGenerationSourceChange, handleToggleDaylight, hasCustomTheme, isGeneratingTheme, localMusicState,
        navidromeFocusedAlbumIndex, navigateBackFromLattice, navigateBackFromPlayer, navigateDirectHome,
        navigateFromPlayerCapsule, navigateToCollection, navigateToHome, navigateToLattice, navigateToPlaybackView,
        navigateToPlayer, navigateToSearch, popCollectionTo, pushCollection, reduceLatticeMotion,
        restoreCachedThemeForSong, saveCustomDualTheme, saveEditedAiDualTheme, setFocusedPlaylistIndex,
        setLocalMusicState, setNavidromeFocusedAlbumIndex, setTheme, songThemeAutoGenerateEnabled,
        songThemeAutoSwitchEnabled, songThemePair, theme, themeController, themeGenerationSource, themeSettling,
        themeSourceModel,
        visualizerAroundWall
    };
};

export type AppThemeAndNavigation = ReturnType<typeof useAppThemeAndNavigation>;
