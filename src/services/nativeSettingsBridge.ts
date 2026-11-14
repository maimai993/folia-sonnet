// src/services/nativeSettingsBridge.ts
// 原生设置的读写口。**设置的真身在原生**（FoliaSettingsStore），这里只是转发。
//
// 为什么设置要放原生：它会影响播放结果。循环模式决定放完往哪走、跳过不可播决定失败后
// 重试还是换歌、方向设置决定播放页要不要转屏。这些判断现在都在原生做，而前台被系统
// 冻结时 JS 不跑 —— 设置若只活在 WebView 的内存里，原生就没有依据可循。
//
// 前台这边的用法只有两种：
//   1. 启动时 `readNativeSettings()` 拿一份把界面填满；
//   2. 用户改了某项就 `writeNativeSettings({...})`，拿返回的整份快照重画。
// 不做本地缓存、不做乐观更新 —— 那正是「界面显示开了、实际没生效」的来源。

import type { PluginListenerHandle } from '@capacitor/core';
import { isAndroidAppShell } from '../platform/runtime';

/** 原生设置的形状。键名与原生 `FoliaSettingsStore.DEFAULTS` 一一对应。 */
export type NativeSettings = Record<string, unknown>;

type NativeSettingsPlugin = {
    getSettings: () => Promise<NativeSettings>;
    setSettings: (options: { values: NativeSettings }) => Promise<NativeSettings>;
};

type CapacitorGlobal = {
    Plugins?: Record<string, unknown>;
    isNativePlatform?: () => boolean;
};

const capacitor = (): CapacitorGlobal | null =>
    typeof window === 'undefined' ? null : ((window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor ?? null);

const plugin = (): NativeSettingsPlugin | null => {
    // 用 isAndroidAppShell 而不是 isCapacitorAndroid：后者要等桥初始化完才为真，
    // 冷启动头几秒会把「桥还没起来」当成「这个平台没有原生设置」——读回 null、
    // 写也写不进去。这里只判「是不是 App 壳」，能不能真调由下面的 typeof 兜住。
    if (!isAndroidAppShell()) return null;
    const candidate = capacitor()?.Plugins?.FoliaNative as NativeSettingsPlugin | undefined;
    return candidate && typeof candidate.getSettings === 'function' ? candidate : null;
};

/**
 * 读一次原生设置。非安卓、或桥还没装好时返回 null —— 调用方按「还不知道」处理，
 * 别退回一套本地默认值：两处各有一份默认值正是「改了没生效」的常见来源。
 */
export const readNativeSettings = async (): Promise<NativeSettings | null> => {
    const api = plugin();
    if (!api) return null;
    try {
        return await api.getSettings();
    } catch (error) {
        console.warn('[nativeSettings] 读取设置失败', error);
        return null;
    }
};

/**
 * 写设置（整份或部分，原生那边合并写入），返回合并后的整份快照。
 * 失败返回 null，调用方保持界面原状而不是假装成功。
 */
export const writeNativeSettings = async (values: NativeSettings): Promise<NativeSettings | null> => {
    const api = plugin();
    if (!api) return null;
    try {
        return await api.setSettings({ values });
    } catch (error) {
        console.warn('[nativeSettings] 写入设置失败', error);
        return null;
    }
};

export type { PluginListenerHandle };
