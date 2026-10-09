import { registerPlugin } from '@capacitor/core';

// src/platform/foliaLyricon.ts
// 状态栏歌词（Lyricon）的 Web 侧入口。原生实现见 android/.../lyricon/FoliaLyricon。
//
// Lyricon 是一个中心服务：各播放器作为 Provider 把当前歌曲、歌词与进度推给它，
// 由它渲染到状态栏。这里只负责把 App 已经在播的东西转译过去。

export interface LyriconLyricLine {
    /** 歌词文本。 */
    text: string;
    /** 起始毫秒。 */
    start: number;
    /** 结束毫秒。 */
    end: number;
    /**
     * 翻译行。**没有翻译时请整个字段省略**，不要传 null：null 过桥会变成 JSONObject.NULL，
     * 原生 `optString` 读出来是字符串 "null"，状态栏上就会真的显示「null」。
     */
    translation?: string;
}

export interface LyriconSongPayload {
    /** 歌曲的唯一标识，用来让中心服务判断「换没换歌」。 */
    id?: string | null;
    title?: string | null;
    artist?: string | null;
    durationMs?: number;
    lines?: LyriconLyricLine[];
}

interface FoliaLyriconPlugin {
    setEnabled(options: { enabled: boolean }): Promise<{ enabled: boolean; connected: boolean }>;
    getStatus(): Promise<{ enabled: boolean; connected: boolean }>;
    publish(payload: LyriconSongPayload): Promise<{ ok: boolean; connected: boolean }>;
    /**
     * `continuous`：这次位置只是**正常播放的延续**（重锚 / 段内推进），不是跳转。
     * 带上了它，原生就不会走 seekTo —— 那会让中心服务把显示状态重启一遍去追新位置。
     */
    setPosition(options: { positionMs: number; playing: boolean; continuous?: boolean })
        : Promise<{ ok: boolean }>;
    clear(): Promise<void>;
}

const FoliaLyricon = registerPlugin<FoliaLyriconPlugin>('FoliaLyricon');

/** 打开 / 关闭状态栏歌词。返回中心服务是否真的连上了。 */
export const setLyriconEnabled = async (enabled: boolean): Promise<{ enabled: boolean; connected: boolean }> => {
    try {
        const result = await FoliaLyricon.setEnabled({ enabled });
        return { enabled: Boolean(result?.enabled), connected: Boolean(result?.connected) };
    } catch {
        // 没装 Lyricon 或版本不兼容：当作连不上，UI 上如实显示。
        return { enabled: false, connected: false };
    }
};

export const getLyriconStatus = async (): Promise<{ enabled: boolean; connected: boolean }> => {
    try {
        const result = await FoliaLyricon.getStatus();
        return { enabled: Boolean(result?.enabled), connected: Boolean(result?.connected) };
    } catch {
        return { enabled: false, connected: false };
    }
};

export const publishLyriconSong = async (payload: LyriconSongPayload): Promise<boolean> => {
    try {
        const result = await FoliaLyricon.publish(payload);
        return Boolean(result?.ok);
    } catch {
        return false;
    }
};

export const publishLyriconPosition = async (
    positionMs: number,
    playing: boolean,
    options?: { continuous?: boolean },
): Promise<boolean> => {
    try {
        const result = await FoliaLyricon.setPosition({
            positionMs,
            playing,
            continuous: options?.continuous === true,
        });
        return Boolean(result?.ok);
    } catch {
        return false;
    }
};

/** 没有在播的东西了：让状态栏把歌词收起来。 */
export const clearLyricon = async (): Promise<void> => {
    try {
        await FoliaLyricon.clear();
    } catch {
        // 同上。
    }
};
