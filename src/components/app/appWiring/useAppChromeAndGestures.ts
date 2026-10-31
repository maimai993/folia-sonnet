import type { AppFoundation } from './useAppFoundation';
import type { AppAudioOutput } from './useAppAudioOutput';
import type { AppThemeAndNavigation } from './useAppThemeAndNavigation';
import type { AppAccountsAndStage } from './useAppAccountsAndStage';
import type { AppLibraryControllers } from './useAppLibraryControllers';
import type { AppPlaybackQueue } from './useAppPlaybackQueue';
import type { AppPlaybackBridges } from './useAppPlaybackBridges';
import { useElectronWindowChrome } from '../../../hooks/useElectronWindowChrome';
import { useHdrExitConfirm, useHdrProjectionActive } from '../../../hooks/useHdrProjection';
import { useIdleCursorHide } from '../../../hooks/useIdleCursorHide';
import { usePersonalFmModeController } from '../../../hooks/usePersonalFmModeController';
import { usePlayerSwipeGesture } from '../../../hooks/usePlayerSwipeGesture';
import { usePlayerTapGesture } from '../../../hooks/usePlayerTapGesture';
import { DAYLIGHT_THEME, DEFAULT_THEME } from '../../../services/baseThemes';
import { disableHdrProjection } from '../../../services/hdrProjection';
import { setStatusMessage as setStatusMsg } from '../../../stores/useStatusMessageStore';
import type { TapEvent } from '../../../utils/doubleTap';
import { PlayerChromeVisibilityMode } from '../../../types/remoteControl';
import { buildAppStyle } from '../presentation/buildAppStyle';
import { buildPlayerViewFlags } from '../presentation/buildPlayerViewFlags';
import { buildVisualizerTheme } from '../presentation/buildVisualizerTheme';
import { useRef, useEffect, useCallback, useMemo } from 'react';

// src/components/app/appWiring/useAppChromeAndGestures.ts
// 窗口外观与手势：切歌手势、HDR 投影、空白点击、窗口标题栏、播放页视觉层参数。

type Input =
    & AppFoundation
    & AppAudioOutput
    & AppThemeAndNavigation
    & AppAccountsAndStage
    & AppLibraryControllers
    & AppPlaybackQueue
    & AppPlaybackBridges;

/*
 * 画面自己在横向拖动上做事情的样式：横滑切歌会跟它抢同一次拖动，这些样式里只让画面接手势。
 * 町景的镜头就是靠横拖绕场景转的（陀螺仪适配开着时更是靠它）。
 */
const PLAYER_SWIPE_OWNED_VISUALIZERS = new Set<string>(['machi']);

export const useAppChromeAndGestures = (model: Input) => {
    const {
        activePlaybackContext, audioSrc, autoHideCursorWithPlayerChrome, bgMode, currentSong, currentView,
        disableHomeDynamicBackground, displaySong, duration, enablePlayerPageNativeBlur, handleContainerClick,
        handleNextTrack, handlePrevTrack, hideCursorWhenIdle, hidePlayerChromeOnTap, hidePlayerProgressBar,
        hidePlayerRightPanelButton, hidePlayerTranslationSubtitle, isDaylight, isElectronWindow, isFmMode,
        isMainWindowClickThroughEnabled, isNowPlayingStageActive, isPanelOpen, isPlayerChromeHidden,
        lyricsCustomFontFamily, lyricsFontFallbackFamilies, lyricsFontStyle, lyricsFontWeight,
        navigateBackFromPlayer, navigateToPlayer, playSong, playerChromeVisibilityMode, setIsPanelOpen,
        setIsPlayerChromeHidden, setPlayerChromeVisibilityModeTo, stageActiveEntryKind, subtitleFontFallbackFamilies,
        subtitleFontFamily, subtitleFontInheritsLyrics, subtitleFontStyle, subtitleFontWeight, t, theme,
        togglePlay, transparentPlayerBackground, visualizerMode, wallpaperMode
    } = model;
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

    const isPlayerSwipeEnabled = currentView === 'player' && !isPanelOpen;
    // 横滑切歌只管「换歌」这一件：画面自己吃横向拖动的样式（见 PLAYER_SWIPE_OWNED_VISUALIZERS）里不接。
    const isPlayerSwipeSwitchingEnabled = isPlayerSwipeEnabled && !PLAYER_SWIPE_OWNED_VISUALIZERS.has(visualizerMode);
    const isPlayerDoubleTapPauseEnabled = isPlayerSwipeEnabled && !hdrProjectionActive;

    /*
     * 单击歌词页的空白：控件显隐翻一下，「再点一下恢复」就是翻回来。
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
    const handleVisualSurfaceTap = useCallback(() => {
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
    }, [confirmHdrExit, currentView, handleContainerClick, hidePlayerChromeOnTap, hdrProjectionActive, isPanelOpen, playerChromeVisibilityMode, setIsPlayerChromeHidden]);

    /*
     * 双击歌词页的空白：暂停 / 继续。
     *
     * 单击要等一个双击窗口、确认没有第二下才执行（见 usePlayerTapGesture），所以这一层开着
     * 时单击控件显隐会晚一个双击窗口。HDR 与面板打开时不开：HDR 把连点两下用在退出投影上，
     * 面板把第一下用在关面板上，那两处保持原来一点就响。
     */
    const {
        onClick: handlePlayerTap,
        resetTapSequence: resetPlayerTapSequence,
    } = usePlayerTapGesture({
        enabled: isPlayerDoubleTapPauseEnabled,
        onTap: handleVisualSurfaceTap,
        onDoubleTap: togglePlay,
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
        // 滑动一旦成立，滑动前那一下点击就不是单击了，别再补翻控件显隐。
        resetPlayerTapSequence();
        void handleNextTrack();
    }, [handleNextTrack, resetPlayerTapSequence]);

    const handlePlayerSwipePrev = useCallback(() => {
        resetPlayerTapSequence();
        handlePrevTrack();
    }, [handlePrevTrack, resetPlayerTapSequence]);

    const {
        onPointerDown: handleSwipePointerDown,
        onPointerMove: handleSwipePointerMove,
        onPointerUp: handleSwipePointerUp,
        onPointerCancel: handleSwipePointerCancel,
        consumeSuppressedClick: consumeSwipeSuppressedClick,
    } = usePlayerSwipeGesture({
        enabled: isPlayerSwipeSwitchingEnabled,
        onNext: handlePlayerSwipeNext,
        onPrev: handlePlayerSwipePrev,
    });

    /*
     * 滑动切完歌浏览器照旧补一个 click，那不是「点了一下空白」，别让它进双击判定。
     */
    const handleVisualSurfaceClick = useCallback((event: TapEvent) => {
        if (consumeSwipeSuppressedClick()) return;
        handlePlayerTap(event);
    }, [consumeSwipeSuppressedClick, handlePlayerTap]);

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
            text: t('ui.hdrProjectionOnHint', 'HUD 投影已开启 · 点两次空白退出'),
            nonce: Date.now(),
        });
    }, [hdrProjectionActive, setStatusMsg, t]);

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

    return {
        ...model,
        appStyle, canToggleCurrentPlayback, handleSwipePointerCancel, handleSwipePointerDown, handleSwipePointerMove,
        handleSwipePointerUp, handleVisualSurfaceClick, idleCursorHidden, isNowPlayingControlDisabled,
        isPersonalFmModeSupported, isPlayerPageTransparent, isPlayerSwipeEnabled, isPlayerView,
        personalFmSelectionLabel, setPersonalFmSelection, shouldHidePlayerCursor, shouldHidePlayerProgressBar,
        shouldHidePlayerRightPanelButton, shouldHidePlayerTranslationSubtitle, shouldPauseVisualizerBackground,
        usesCustomWindowChrome, visualizerGeometrySeed, visualizerSubtitleTheme, visualizerTheme
    };
};

export type AppChromeAndGestures = ReturnType<typeof useAppChromeAndGestures>;
