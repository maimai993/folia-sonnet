import type { AppFoundation } from './useAppFoundation';
import { useAudioOutputDevice } from '../../../hooks/useAudioOutputDevice';
import { NATIVE_PLAYBACK_ENABLED, nativePlaybackEngine } from '../../../services/playbackEngine/nativePlaybackEngine';
import { isNativePlayerAvailable } from '../../../services/playbackEngine/nativePlayerPlugin';
import { useAudioSettingsStore } from '../../../stores/useAudioSettingsStore';
import { LyricData, StageLoopMode } from '../../../types';
import { clampMediaVolume } from '../../../utils/appPlaybackHelpers';
import { createCoverUrlResolver } from '../../../utils/coverUrlResolver';
import { writeLyricOffset } from '../../../utils/lyrics/lyricOffsetMemory';
import { createLyricsSetter } from '../playback/createLyricsSetter';
import { persistPlaybackCache } from '../playback/persistPlaybackCache';
import { createOnlineRecoveryController } from '../playback/restore/createOnlineRecoveryController';
import { useRef, useEffect, useCallback, useMemo } from 'react';

// src/components/app/appWiring/useAppAudioOutput.ts
// App 的音频输出：音量与输出设备、预览音量、在线音源恢复、封面地址。

const ONLINE_AUDIO_URL_TTL_MS = 1200 * 1000;
const ONLINE_AUDIO_URL_REFRESH_BUFFER_MS = 60 * 1000;

type Input = AppFoundation;

export const useAppAudioOutput = (model: Input) => {
    const {
        audioContextRef, audioQuality, audioRef, audioSrc, blobUrlRef, cachedCoverUrl,
        currentOnlineAudioUrlFetchedAtRef, currentSong, currentSongFullRef, gainNodeRef, globalLyricTimelineOffsetMs,
        isMuted, lastAudioRecoverySourceRef, loopMode, lyricFilterEnabled, lyricFilterPattern, lyricStaffAbsorbMode,
        lyricStaffMinDwellSeconds, lyricStaffPattern, lyricStaffPolicy, lyricTimelineOffsetMs,
        onlinePlaybackRecoveryRef, pendingResumeTimeRef, pendingVolumePreviewRef, setAudioSrc, setCurrentSong,
        setLyricTimelineOffsetMs, setLyricsState, setPlayQueue, shouldAutoPlay, volume, volumePreviewFrameRef
    } = model;
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
    /** 原生解析失败过的歌（会话级黑名单）：这些歌不再分流，直接走 Web 全流程。 */
    const nativeFailedKeysRef = useRef<Set<string>>(new Set());

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

    return {
        ...model,
        coverUrl, effectiveLoopMode, effectiveLyricTimelineOffsetMs, getCoverUrl, getTargetPlaybackVolume,
        handleAudioOutputDeviceChange, handleLyricTimelineOffsetChange, handlePreviewVolume, nativeActive,
        nativeTakes, nativeTakesRef, nativeFailedKeysRef, persistLastPlaybackCache, recoverOnlinePlaybackSource, setLyrics,
        setLyricsStable, shouldRefreshCurrentOnlineAudioSource, syncOutputGain
    };
};

export type AppAudioOutput = ReturnType<typeof useAppAudioOutput>;
