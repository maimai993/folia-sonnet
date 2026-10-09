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
    /** 翻译行。没有就整个字段不传 —— 传空串会让原生分不清「没翻译」和「翻译是空的」。 */
    translation?: string;
}

export type FoliaWallpaperBackgroundMode = 'cover' | 'color' | 'image';

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
    /** 背景模式：cover = 模糊封面，color = 主题色渐变，image = 自选图片。 */
    background?: FoliaWallpaperBackgroundMode;
    /** 自选背景图的 base64，background=image 时生效。 */
    image?: string | null;
    /** App 当前可视化模式，决定壁纸动画风格。 */
    visualizer?: string;
    /** 背景模糊强度 0..1。0 = 完全清晰，1 = 糊到只剩色块。 */
    blur?: number;
    /** 是否在歌词上方显示整首歌的进度条。 */
    progress?: boolean;
    /** 是否在主行下面再画一行翻译。歌词本身没翻译时不会因此多出空行。 */
    translation?: boolean;
    /**
     * 歌词动画实验台里当前那个模式的配置，摊平成 { 字段名: number }。
     * 布尔开关是 0/1，字符串枚举已翻成序号。
     */
    tuning?: Record<string, number> | null;
    /** 整首歌时长（毫秒），画进度条用。传 0 / 不传就不画。 */
    durationMs?: number;
}

export interface FoliaWallpaperAppearance {
    background?: FoliaWallpaperBackgroundMode;
    image?: string | null;
    visualizer?: string;
    blur?: number;
    progress?: boolean;
    translation?: boolean;
    tuning?: Record<string, number> | null;
    durationMs?: number;
}

interface FoliaWallpaperPlugin {
    publish(options: FoliaWallpaperPublishOptions): Promise<void>;
    setAppearance(options: FoliaWallpaperAppearance): Promise<void>;
    clearImage(): Promise<void>;
    /** 打开系统文件选择器挑字体；原生自己拷贝，不走 base64。 */
    pickFont(): Promise<{ picked: boolean; rejected?: boolean }>;
    getFont(): Promise<{ font: boolean }>;
    /** font 传 null / 空串 = 清除，回落到系统字体。 */
    setFont(options: { font: string | null }): Promise<void>;
    getBackground(): Promise<{ mode: FoliaWallpaperBackgroundMode }>;
    clear(): Promise<void>;
    isActive(): Promise<{ active: boolean }>;
    openPicker(): Promise<{ opened: boolean }>;
    /** 壁纸的可视化叠层要 SYSTEM_ALERT_WINDOW，没授权时它是静默不工作的。 */
    hasOverlayPermission(): Promise<{ granted: boolean }>;
    openOverlaySettings(): Promise<void>;
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

export const setWallpaperAppearance = async (
    options: FoliaWallpaperAppearance,
): Promise<void> => {
    try {
        await FoliaWallpaper.setAppearance(options);
    } catch {
        // 同上。
    }
};

/** 清除壁纸的自选背景图（同时删掉原生那边的落盘副本）。 */
export const clearWallpaperBackgroundImage = async (): Promise<void> => {
    try {
        await FoliaWallpaper.clearImage();
    } catch {
        // 同上。
    }
};

export type WallpaperFontPickResult = 'applied' | 'rejected' | 'cancelled';

/**
 * 打开系统文件选择器给壁纸歌词挑一个 .ttf / .otf。
 *
 * 字体文件几 MB，不经过 JS：原生拿到 URI 自己拷进私有目录，这里只拿回结果。
 * rejected 表示用户确实选了文件，但那不是个能用的字体 —— 要跟「取消」区分开提示。
 */
export const pickWallpaperFont = async (): Promise<WallpaperFontPickResult> => {
    try {
        const result = await FoliaWallpaper.pickFont();
        if (result?.picked) return 'applied';
        return result?.rejected ? 'rejected' : 'cancelled';
    } catch {
        return 'cancelled';
    }
};

/** 壁纸歌词当前是否已经选过字体（重启后依然成立，因为字体是落在磁盘上的文件）。 */
export const hasWallpaperFont = async (): Promise<boolean> => {
    try {
        const result = await FoliaWallpaper.getFont();
        return Boolean(result?.font);
    } catch {
        return false;
    }
};

/** 清除壁纸歌词的自选字体，回落到系统 sans-serif。 */
export const clearWallpaperFont = async (): Promise<void> => {
    try {
        await FoliaWallpaper.setFont({ font: null });
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

/** 叠层可视化有没有拿到「显示在其他应用上层」权限。 */
export const hasWallpaperOverlayPermission = async (): Promise<boolean> => {
    try {
        const result = await FoliaWallpaper.hasOverlayPermission();
        return Boolean(result?.granted);
    } catch {
        return false;
    }
};

/** 跳到系统的叠层授权页。 */
export const openWallpaperOverlaySettings = async (): Promise<void> => {
    try {
        await FoliaWallpaper.openOverlaySettings();
    } catch {
        // 桌面端 / 不支持的系统：静默，UI 那边会提示用户手动去设置里开。
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
