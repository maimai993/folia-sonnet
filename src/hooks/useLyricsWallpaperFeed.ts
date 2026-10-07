import React from 'react';
import { isCapacitorAndroid } from '../platform/runtime';
import { clearLyricsWallpaper, publishLyricsWallpaper, setWallpaperAppearance } from '../platform/foliaWallpaper';
import { useVisualizerSettingsStore } from '../stores/useVisualizerSettingsStore';
import type { Line } from '../types';

// src/hooks/useLyricsWallpaperFeed.ts
// 把歌词送到原生壁纸。
//
// 关键在于**不要指望这里的定时器**：应用退到后台后 WebView 的 JS 定时器会被系统挂起，
// 靠它推「当前行」的话，后台时歌词就永远停在一句上。所以换歌时把整条时间轴一次性交过去，
// 播放中只偶尔推一个时间锚点；之后由原生按墙钟自己往前推，JS 停了歌词也照样往下走。

const DEFAULT_ACCENT = '#7c5cff';
const COVER_EDGE = 256;
/** 心跳间隔。前台时用来校正锚点；后台被挂起也无所谓，原生自己会走。 */
const TICK_MS = 500;

type UseLyricsWallpaperFeedOptions = {
    lyrics: { lines: Line[] } | null;
    /** 读当前播放时间（秒）。传 get 方法而不是值，避免每次渲染重建定时器。 */
    getCurrentTime: () => number;
    title: string | null;
    artist: string | null;
    coverUrl: string | null;
    playerState: string;
    /** App 当前主题，用来让壁纸与 App 用同一套配色和动效强度。 */
    accentColor?: string | null;
    backgroundColor?: string | null;
    animationIntensity?: 'calm' | 'normal' | 'chaotic' | null;
};

const MOTION_BY_INTENSITY: Record<string, number> = {
    calm: 0.6,
    normal: 1,
    chaotic: 1.5,
};

/** 把封面压成小图 base64：壁纸只用作模糊底图，不需要原图。 */
const loadCoverAsBase64 = async (url: string): Promise<string | null> => {
    if (typeof document === 'undefined') return null;
    try {
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) return null;
        const blob = await response.blob();
        if (typeof createImageBitmap !== 'function') return null;
        const bitmap = await createImageBitmap(blob);
        const scale = Math.min(1, COVER_EDGE / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) return null;
        context.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();
        return canvas.toDataURL('image/jpeg', 0.7);
    } catch {
        return null;
    }
};

export const useLyricsWallpaperFeed = ({
    lyrics,
    getCurrentTime,
    title,
    artist,
    coverUrl,
    playerState,
    accentColor,
    backgroundColor,
    animationIntensity,
}: UseLyricsWallpaperFeedOptions): void => {
    const enabled = isCapacitorAndroid();
    const feedEnabled = useVisualizerSettingsStore(state => state.lyricsWallpaperFeed);
    const backgroundMode = useVisualizerSettingsStore(state => state.lyricsWallpaperBackground);
    const backgroundImage = useVisualizerSettingsStore(state => state.lyricsWallpaperImage);
    // 壁纸动画风格跟随 App 选中的可视化模式。
    const visualizerMode = useVisualizerSettingsStore(state => state.visualizerMode);
    const active = enabled && feedEnabled;

    const playing = playerState === 'PLAYING';
    const latest = React.useRef({ playing });
    latest.current.playing = playing;

    const coverRef = React.useRef<string | null>(null);

    // 关掉开关时清一次，别让壁纸停在过期的那一行上。
    React.useEffect(() => {
        if (enabled && !feedEnabled) {
            void clearLyricsWallpaper();
        }
    }, [enabled, feedEnabled]);

    // 封面只在换歌时抓一次。
    React.useEffect(() => {
        if (!enabled) return;
        coverRef.current = null;
        if (!coverUrl) return;
        let cancelled = false;
        void loadCoverAsBase64(coverUrl).then((value) => {
            if (!cancelled && value) {
                coverRef.current = value;
            }
        });
        return () => {
            cancelled = true;
        };
    }, [enabled, coverUrl]);

    // 外观（背景模式 / 自选图 / 可视化风格）单独下发，不牵动时间轴。
    React.useEffect(() => {
        if (!enabled) return;
        void setWallpaperAppearance({
            background: backgroundMode,
            image: backgroundImage,
            visualizer: visualizerMode,
        });
    }, [enabled, backgroundMode, backgroundImage, visualizerMode]);

    // 换歌（或歌词本身变了）时下发整条时间轴。
    React.useEffect(() => {
        if (!active) return;
        const lines = lyrics?.lines ?? [];
        void publishLyricsWallpaper({
            title: title ?? '',
            artist: artist ?? '',
            accent: accentColor || DEFAULT_ACCENT,
            backgroundColor: backgroundColor || '#09090b',
            motion: MOTION_BY_INTENSITY[animationIntensity ?? 'normal'] ?? 1,
            cover: coverRef.current,
            background: backgroundMode,
            image: backgroundImage,
            visualizer: visualizerMode,
            timeline: lines.map((line) => ({
                text: line.fullText,
                start: Math.round(line.startTime * 1000),
                end: Math.round(line.endTime * 1000),
            })),
            positionMs: Math.round(getCurrentTime() * 1000),
            playing,
        });
        // getCurrentTime 是稳定的取数函数，不参与依赖比较以外的重算。
    }, [active, lyrics, title, artist, backgroundMode, backgroundImage, visualizerMode,
        accentColor, backgroundColor, animationIntensity]);

    // 播放/暂停要立刻通知，否则暂停后原生还在按墙钟往前走。
    React.useEffect(() => {
        if (!active) return;
        void publishLyricsWallpaper({
            positionMs: Math.round(getCurrentTime() * 1000),
            playing,
        });
    }, [active, playing]);

    // 心跳：前台时校正锚点。后台被挂起也无所谓，原生自己推进。
    React.useEffect(() => {
        if (!active) return;
        const timer = window.setInterval(() => {
            void publishLyricsWallpaper({
                positionMs: Math.round(getCurrentTime() * 1000),
                playing: latest.current.playing,
            });
        }, TICK_MS);
        return () => window.clearInterval(timer);
    }, [active]);
};
