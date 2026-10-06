import React from 'react';
import { isCapacitorAndroid } from '../platform/runtime';
import { publishLyricsWallpaper } from '../platform/foliaWallpaper';
import type { Line } from '../types';

// src/hooks/useLyricsWallpaperFeed.ts
// 把「当前行 + 行内进度」喂给原生歌词壁纸。
//
// 动态壁纸是另一个组件，读不到 React 状态，只能由这里主动推过去。
// 进度每 100ms 推一次（再快也看不出差别，只会白耗 bridge）；歌词只在窗口变化时才重发，
// 因为整段歌词可能上百行，没必要每 100ms 序列化一遍。

/** 以当前行为中心，向上下各取几行。壁纸只会画出其中距离当前行 3 行以内的。 */
const WINDOW_RADIUS = 4;
const TICK_MS = 100;
const DEFAULT_ACCENT = '#7c5cff';
const COVER_EDGE = 256;

type UseLyricsWallpaperFeedOptions = {
    lyrics: { lines: Line[] } | null;
    currentLineIndex: number;
    /** 读当前播放时间。传 get 方法而不是值，避免每 100ms 重建定时器。 */
    getCurrentTime: () => number;
    title: string | null;
    artist: string | null;
    coverUrl: string | null;
    playerState: string;
};

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

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
    currentLineIndex,
    getCurrentTime,
    title,
    artist,
    coverUrl,
    playerState,
}: UseLyricsWallpaperFeedOptions): void => {
    const enabled = isCapacitorAndroid();

    // 定时器里读 ref，避免因闭包拿到过期值。
    const latest = React.useRef({ lines: [] as Line[], index: -1, playing: false, time: 0 });
    latest.current.lines = lyrics?.lines ?? [];
    latest.current.index = currentLineIndex;
    latest.current.playing = playerState === 'PLAYING';

    const coverRef = React.useRef<string | null>(null);
    const windowKeyRef = React.useRef('');

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

    React.useEffect(() => {
        if (!enabled) return;

        const tick = (): void => {
            const { lines, index, playing } = latest.current;
            const time = getCurrentTime();
            latest.current.time = time;

            if (lines.length === 0 || index < 0) {
                // 没有歌词时也要把歌名推过去，壁纸至少能显示封面和标题。
                const emptyKey = `${title ?? ''}|empty`;
                const changed = emptyKey !== windowKeyRef.current;
                windowKeyRef.current = emptyKey;
                void publishLyricsWallpaper({
                    title: title ?? '',
                    artist: artist ?? '',
                    lines: changed ? [] : null,
                    index: 0,
                    progress: 0,
                    playing,
                    accent: DEFAULT_ACCENT,
                    cover: changed ? coverRef.current : null,
                    slowChanged: changed,
                });
                return;
            }

            const from = Math.max(0, index - WINDOW_RADIUS);
            const to = Math.min(lines.length, index + WINDOW_RADIUS + 1);
            const key = `${title ?? ''}|${from}|${to}`;
            const changed = key !== windowKeyRef.current;
            windowKeyRef.current = key;

            const current = lines[index];
            const span = current ? Math.max(1, current.endTime - current.startTime) : 1;
            const progress = current ? clamp01((time - current.startTime) / span) : 0;

            void publishLyricsWallpaper({
                title: title ?? '',
                artist: artist ?? '',
                lines: changed ? lines.slice(from, to).map((line) => line.fullText) : null,
                index: index - from,
                progress,
                playing,
                accent: DEFAULT_ACCENT,
                cover: changed ? coverRef.current : null,
                slowChanged: changed,
            });
        };

        tick();
        const timer = window.setInterval(tick, TICK_MS);
        return () => window.clearInterval(timer);
    }, [enabled, getCurrentTime, title, artist]);
};
