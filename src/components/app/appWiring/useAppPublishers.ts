import type { AppFoundation } from './useAppFoundation';
import type { AppAudioOutput } from './useAppAudioOutput';
import type { AppThemeAndNavigation } from './useAppThemeAndNavigation';
import type { AppAccountsAndStage } from './useAppAccountsAndStage';
import type { AppLibraryControllers } from './useAppLibraryControllers';
import type { AppPlaybackQueue } from './useAppPlaybackQueue';
import type { AppPlaybackBridges } from './useAppPlaybackBridges';
import type { AppChromeAndGestures } from './useAppChromeAndGestures';
import { useBilibiliMvStore } from '../../../stores/useBilibiliMvStore';
import { songKeyOf } from '../../bilibili/BilibiliMvLayer';
import { getSongArtistLabel } from '../../../services/onlineMusic/songMetadata';
import { usePlaybackStore } from '../../../stores/usePlaybackStore';
import { nativePlaybackEngine } from '../../../services/playbackEngine/nativePlaybackEngine';
import { useLyricApiPublisher } from '../../../hooks/useLyricApiPublisher';
import { useObsBrowserSourcePublisher } from '../../../hooks/useObsBrowserSourcePublisher';
import { useSleepTimer } from '../../../hooks/useSleepTimer';
import { resolveCommandPaletteSearchSource } from '../../../stores/useSearchNavigationStore';
import { setStatusMessage as setStatusMsg } from '../../../stores/useStatusMessageStore';
import { createLyricSegmentationActions } from '../playback/createLyricSegmentationActions';
import { useCallback, useMemo } from 'react';

// src/components/app/appWiring/useAppPublishers.ts
// 对外发布与开关：OBS 浏览器源、歌词 API、主题与全屏命令、睡眠定时、歌词分段动作。

type Input =
    & AppFoundation
    & AppAudioOutput
    & AppThemeAndNavigation
    & AppAccountsAndStage
    & AppLibraryControllers
    & AppPlaybackQueue
    & AppPlaybackBridges
    & AppChromeAndGestures;

export const useAppPublishers = (model: Input) => {
    const {
        activeProviderId, audioRef, audioSrc, automix, currentSong, currentSongFullRef, displayCoverUrl,
        effectiveLyricTimelineOffsetMs, generateAITheme, handleToggleDaylight, isDaylight, isElectronWindow,
        loadCurrentSongLyricPreview, lyrics, pausePlayback, searchSourceTab, setLyricsStable, settingsModalState,
        shouldHidePlayerTranslationSubtitle, sleepTimerClockHour, sleepTimerClockMinute, sleepTimerEnabled,
        sleepTimerEndAction, sleepTimerHours, sleepTimerMinutes, sleepTimerMode, stageSource, t,
        visualizerGeometrySeed, visualizerSubtitleTheme, visualizerTheme
    } = model;
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
    /*
     * 「匹配 MV」：对正在放这首歌重新搜一条 B 站投稿（强制清缓存），拿到新画面后
     * 从头放。isRematchingMv 跟着这首歌的 inflight 走 —— 匹配中按钮转圈禁点。
     */
    const mvSongKey = songKeyOf(currentSong?.name, getSongArtistLabel(currentSong as never));
    const isRematchingMv = useBilibiliMvStore(state => Boolean(mvSongKey && state.inflight[mvSongKey]));
    const rematchCurrentSongMv = useCallback(() => {
        if (!currentSong) return;
        const title = currentSong.name ?? '';
        if (!title.trim()) return;
        const artist = getSongArtistLabel(currentSong as never) || '';
        const key = songKeyOf(title, artist);
        const duration = usePlaybackStore.getState().duration ?? 0;
        void useBilibiliMvStore.getState().resolveForSong(
            key,
            title,
            artist,
            Number.isFinite(duration) ? duration : 0,
            true,
        ).then(() => {
            // 匹配完从头放：画面 / 声音都换成新选中的那条（store 那边会写回），进度归零。
            void nativePlaybackEngine.seek(0);
        });
    }, [currentSong]);
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

    return {
        ...model,
        canGenerateAITheme, currentSearchSourceTabInPalette, generateCurrentSongTheme, isRematchingMv,
        isObsBrowserSourceRendering,
        isSettingsModalOpen, lyricApiStatus, lyricSegmentationActions, obsBrowserSourceStatus,
        refreshObsBrowserSourceStatus, rematchCurrentSongMv, setLyricApiEnabled, toggleBrowserFullscreen, toggleDaylightMode,
        toggleMainWindowAlwaysOnTop, toggleRemoteControlWindow
    };
};

export type AppPublishers = ReturnType<typeof useAppPublishers>;
