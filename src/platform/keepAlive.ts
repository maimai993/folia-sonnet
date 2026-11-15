import { registerPlugin } from '@capacitor/core';
import { isCapacitorAndroid } from './runtime';

// src/platform/keepAlive.ts
//
// 后台保活的 Web 侧入口。三件事，都只服务于设置页那一行「后台运行」：
//   读状态（是否已在电池优化白名单里）、弹系统的豁免对话框、跳到厂商的自启动 / 耗电页。
//
// 这里不做任何自动化的「保活」：没有轮询、没有后台唤起、没有 AlarmManager。
// 国内 ROM 的省电策略只能由用户在系统里点一次，应用侧唯一能做的是把路铺到他面前，
// 并且如实告诉他"现在系统有没有放行"——而不是让他自己猜为什么息屏一会儿就没声了。

/**
 * 与 `FoliaPlaybackPlugin.kt` 的三个 @PluginMethod 一一对应，改一处必须两处都改。
 */
interface FoliaPlaybackKeepAlivePlugin {
    getKeepAliveStatus(): Promise<KeepAliveStatus>;
    requestBatteryOptimizationExemption(): Promise<{ opened: boolean; granted: boolean }>;
    openKeepAliveSettings(options: { target: KeepAliveTarget }): Promise<{ landed: KeepAliveTarget }>;
}

const FoliaPlayback = registerPlugin<FoliaPlaybackKeepAlivePlugin>('FoliaPlayback');

export type KeepAliveTarget = 'autostart' | 'battery' | 'details';

export interface KeepAliveStatus {
    /** 已被排除在电池优化之外。AOSP 唯一可读的那一条。 */
    ignoringBatteryOptimizations: boolean;
    /** ROM 标签（"MIUI" / "ColorOS" / "OriginOS"…）；判断不出来是空串。 */
    rom: string;
    /** Android API 级别。14+ 的前台服务收紧，提示语里要分开说。 */
    sdkInt: number;
    /** 前台服务当前在不在。服务没起来时谈保活没有意义。 */
    serviceRunning: boolean;
}

export const readKeepAliveStatus = async (): Promise<KeepAliveStatus | null> => {
    if (!isCapacitorAndroid()) {
        return null;
    }
    try {
        return await FoliaPlayback.getKeepAliveStatus();
    } catch {
        // 老版本 APK 上没有这三个方法：设置页据此不显示这一块，而不是显示一个假状态。
        return null;
    }
};

/**
 * 弹系统那个「是否允许后台运行」的对话框。
 *
 * `opened` 为 false = 这台机器上连列表页都跳不过去，只能由文案告诉用户手动怎么走。
 * `granted` 是**弹之前**读到的值：系统对话框是异步的，用户点完返回时值才会变，
 * 所以调用方拿到结果后要重新读一次状态，而不是拿这个字段当最终答案。
 */
export const requestBatteryExemption = async (): Promise<{ opened: boolean; granted: boolean } | null> => {
    if (!isCapacitorAndroid()) {
        return null;
    }
    try {
        return await FoliaPlayback.requestBatteryOptimizationExemption();
    } catch {
        return null;
    }
};

/**
 * 跳到厂商的自启动 / 耗电管理页。
 *
 * 返回的是**实际**落点：候选页猜不中时会退到应用详情页，那时提示语要更具体
 * （"在应用详情里点 电池 → 后台运行"），否则用户会以为跳错了。
 */
export const openKeepAliveSettings = async (target: KeepAliveTarget): Promise<KeepAliveTarget | null> => {
    if (!isCapacitorAndroid()) {
        return null;
    }
    try {
        const result = await FoliaPlayback.openKeepAliveSettings({ target });
        return result?.landed ?? null;
    } catch {
        return null;
    }
};
