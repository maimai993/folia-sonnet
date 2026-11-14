import { registerPlugin } from '@capacitor/core';
import { isNativePlaybackReconciling } from '../services/playbackEngine/nativePlaybackSync';

// src/platform/foliaColorOsLyrics.ts
// ColorOS 原生锁屏歌词的 Web 侧入口。原生实现见 android/.../coloros/ColorOsLyricBridge。
//
// 与状态栏歌词（Lyricon）不是一回事：
//   Lyricon        → 推给第三方中心服务，渲染在**状态栏**。
//   ColorOS 歌词   → 写进我们自己 MediaSession 的 MediaMetadata["lyricInfo"]，
//                    由**系统锁屏 / AOD 歌词页**原生渲染，Bridge 只是可选增强。
//
// 是否启用**完全由原生判定**：只有真机探测为 ColorOS 16+ 才返回 supported=true。
// 用户没有手动开关 —— 不是那台机器就当这条路不存在。

export interface ColorOsLyricsSupport {
    supported: boolean;
    /** 解析出来的 ColorOS 大版本；0 = 没读出来。 */
    colorOsMajor: number;
    /** 判定依据（属性名 / 兜底原因），只用于诊断日志。 */
    detail: string;
}

interface FoliaColorOsLyricsPlugin {
    isSupported(): Promise<ColorOsLyricsSupport>;
    publish(options: {
        lyricInfo: string;
        hasTranslation: boolean;
        /** 与通知栏同一个歌曲身份；对不上时原生会拒绝这段歌词。 */
        songKey?: string | null;
    }): Promise<{ ok: boolean }>;
    clear(): Promise<void>;
}

const FoliaColorOsLyrics = registerPlugin<FoliaColorOsLyricsPlugin>('FoliaColorOsLyrics');

const NOT_SUPPORTED: ColorOsLyricsSupport = { supported: false, colorOsMajor: 0, detail: 'unavailable' };

let cachedSupport: ColorOsLyricsSupport | null = null;

/**
 * 这台机器走不走 ColorOS 原生歌词通道。
 *
 * 结果缓存起来：判定要读 ROM 属性，一次就够，不必每首歌问一遍。
 * 拿不到答案（没装原生插件 / 插件没注册）一律按「不支持」处理 —— 不是那台机器，
 * 这条路就该安静地不存在。
 */
export const getColorOsLyricsSupport = async (): Promise<ColorOsLyricsSupport> => {
    if (cachedSupport) return cachedSupport;
    try {
        const result = await FoliaColorOsLyrics.isSupported();
        cachedSupport = {
            supported: Boolean(result?.supported),
            colorOsMajor: Number(result?.colorOsMajor ?? 0),
            detail: String(result?.detail ?? ''),
        };
    } catch {
        cachedSupport = NOT_SUPPORTED;
    }
    return cachedSupport;
};

/**
 * 上次探测的结论（同步读缓存），没探测过就是 null。
 *
 * 设置搜索要在**不挂载页面**的前提下判断这一项在不在（`option()` 的 `available` 是同步的），
 * 而真正的探测是一次异步原生调用 —— 只能拿缓存里的结论。探测在 App 启动推歌词时就跑过
 * 一次（useColorOsLyricFeed），所以打开设置时通常已经有答案了。
 */
export const peekColorOsLyricsSupport = (): ColorOsLyricsSupport | null => cachedSupport;

export const publishColorOsLyricInfo = async (
    lyricInfo: string,
    hasTranslation: boolean,
    songKey: string | null,
): Promise<boolean> => {
    if (isNativePlaybackReconciling()) return false;
    try {
        const result = await FoliaColorOsLyrics.publish({ lyricInfo, hasTranslation, songKey });
        return Boolean(result?.ok);
    } catch {
        return false;
    }
};

/** 没有在播的东西（或这首歌没词）：把上一段歌词撤掉。 */
export const clearColorOsLyricInfo = async (): Promise<void> => {
    if (isNativePlaybackReconciling()) return;
    try {
        await FoliaColorOsLyrics.clear();
    } catch {
        // 同上。
    }
};
