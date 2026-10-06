import { registerPlugin } from '@capacitor/core';

// src/platform/foliaWallpaper.ts
// 歌词动态壁纸的 Web 侧入口。原生实现见 android/.../wallpaper/LyricsWallpaperService。

export interface FoliaWallpaperPublishOptions {
    title?: string;
    artist?: string;
    /** 歌词行窗口。传 null 表示沿用上一次的（进度推送时没必要重发整段歌词）。 */
    lines?: string[] | null;
    /** 当前行在 lines 里的下标。 */
    index?: number;
    /** 当前行内的进度 0..1，用于逐字高亮。 */
    progress?: number;
    playing?: boolean;
    /** 主题色，形如 #7c5cff。 */
    accent?: string;
    /** 封面 base64。体积大，只在换歌时发。 */
    cover?: string | null;
    /** 慢字段（歌名/歌词行）是否变了，变了才落盘。 */
    slowChanged?: boolean;
}

interface FoliaWallpaperPlugin {
    publish(options: FoliaWallpaperPublishOptions): Promise<void>;
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
