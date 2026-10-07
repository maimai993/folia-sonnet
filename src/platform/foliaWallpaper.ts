import { registerPlugin } from '@capacitor/core';

// src/platform/foliaWallpaper.ts
// 歌词动态壁纸的 Web 侧入口。原生实现见 android/.../wallpaper/LyricsWallpaperService。

export interface FoliaWallpaperTimelineEntry {
    /** 歌词文本。 */
    text: string;
    /** 起始毫秒。 */
    start: number;
    /** 结束毫秒。 */
    end: number;
}

export type FoliaWallpaperBackgroundMode = 'cover' | 'color';

export interface FoliaWallpaperPublishOptions {
    /** 整条时间轴。只在换歌时发一次；之后原生自己按墙钟推进。 */
    timeline?: FoliaWallpaperTimelineEntry[];
    /** 当前播放位置（毫秒）。与 timeline 一起发时作为时间锚点。 */
    positionMs?: number;
    playing?: boolean;
    title?: string;
    artist?: string;
    /** 主题色，形如 #7c5cff。 */
    accent?: string;
    /** App 当前主题的底色，形如 #09090b。 */
    backgroundColor?: string;
    /** 动效强度倍数：calm 0.6 / normal 1.0 / chaotic 1.5。 */
    motion?: number;
    /** 封面 base64。体积大，只在换歌时发。 */
    cover?: string | null;
    /** 背景模式：cover = 模糊封面，color = 只用主题色渐变。 */
    background?: FoliaWallpaperBackgroundMode;
}

interface FoliaWallpaperPlugin {
    publish(options: FoliaWallpaperPublishOptions): Promise<void>;
    setBackground(options: { mode: FoliaWallpaperBackgroundMode }): Promise<void>;
    getBackground(): Promise<{ mode: FoliaWallpaperBackgroundMode }>;
    clear(): Promise<void>;
    isActive(): Promise<{ active: boolean }>;
    openPicker(): Promise<{ opened: boolean }>;
}

const FoliaWallpaper = registerPlugin<FoliaWallpaperPlugin>('FoliaWallpaper');

export const publishLyricsWallpaper = async (
    options: FoliaWallpaperPublishOptions,
): Promise<void> => {
    try {
        await FoliaWallpaper.publish(options);
    } catch {
        // 壁纸没启用或插件不可用时静默失败：它不该影响播放本身。
    }
};

export const setWallpaperBackground = async (
    mode: FoliaWallpaperBackgroundMode,
): Promise<void> => {
    try {
        await FoliaWallpaper.setBackground({ mode });
    } catch {
        // 同上。
    }
};

export const clearLyricsWallpaper = async (): Promise<void> => {
    try {
        await FoliaWallpaper.clear();
    } catch {
        // 同上。
    }
};

/** 打开系统动态壁纸选择器，并直接定位到 Folia 的歌词壁纸。 */
export const openLyricsWallpaperPicker = async (): Promise<void> => {
    try {
        await FoliaWallpaper.openPicker();
    } catch {
        // 少数 ROM 没有这个入口，忽略即可。
    }
};

export const isLyricsWallpaperActive = async (): Promise<boolean> => {
    try {
        const result = await FoliaWallpaper.isActive();
        return Boolean(result?.active);
    } catch {
        return false;
    }
};
