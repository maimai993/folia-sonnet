// src/stores/useGyroSettingsStore.ts
// 全局「陀螺仪适配」开关。
//
// 这份开关原来只服务町景（见 components/visualizer/machi/gyro.ts），可它想做的事情
// 和背景无关：手机往哪边歪，镜头就跟着轻轻偏一点。所有 3D 背景（町景 / 粒子 /
// 星河 / 安魂 / 音域回响）用的是同一套轨道相机，所以这个开关也应该是全局的一份，
// 而不是某个背景自己的调优项。
//
// 读写 localStorage 的 'gyro_tilt_enabled'：默认**开**。安卓上陀螺仪装上就能用，
// 没有理由让人先去设置里找一遍。嫌晃的人自己关。
//
// 每个背景还能单独关（'gyro_tilt_per_mode'）：有的背景晃着好看，有的一动就晕。

import { create } from 'zustand';
import { getStoredBoolean, setStoredBoolean } from './storagePrimitives';

export const GYRO_TILT_STORAGE_KEY = 'gyro_tilt_enabled';
/** 灵敏度（场景转镜头的倍数）落盘的键。 */
export const GYRO_TILT_GAIN_STORAGE_KEY = 'gyro_tilt_gain';
/** 每个背景自己的开关，落盘成一个 JSON 对象。 */
export const GYRO_TILT_PER_MODE_STORAGE_KEY = 'gyro_tilt_per_mode';

/**
 * 灵敏度的默认值。
 *
 * 0.4 是默认值：场景里歪手机看得出镜头在动，但不会「手腕轻轻一动画面就甩过去」。
 * 原来定 0.7，实测仍然偏快，往下压到 0.4；嫌慢的人自己往上拖。
 * 背景那边（gyroTilt.ts）自己的倍率是固定的，这里只管场景这一侧再乘多少。
 */
export const GYRO_TILT_GAIN_DEFAULT = 0.4;
/** 滑块两端：0.2 几乎不动，2.5 一动就到头。 */
export const GYRO_TILT_GAIN_MIN = 0.2;
export const GYRO_TILT_GAIN_MAX = 2.5;

const readStoredGain = (): number => {
    try {
        const raw = localStorage.getItem(GYRO_TILT_GAIN_STORAGE_KEY);
        if (raw === null) return GYRO_TILT_GAIN_DEFAULT;
        const value = Number(raw);
        if (!Number.isFinite(value)) return GYRO_TILT_GAIN_DEFAULT;
        return Math.min(GYRO_TILT_GAIN_MAX, Math.max(GYRO_TILT_GAIN_MIN, value));
    } catch {
        return GYRO_TILT_GAIN_DEFAULT;
    }
};

const readStoredPerMode = (): Record<string, boolean> => {
    try {
        const raw = localStorage.getItem(GYRO_TILT_PER_MODE_STORAGE_KEY);
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return {};
        const out: Record<string, boolean> = {};
        for (const [mode, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof value === 'boolean') out[mode] = value;
        }
        return out;
    } catch {
        // 存坏了就当没配过：全部跟随全局，总好过整份设置读不出来。
        return {};
    }
};

/** 这台设备有没有陀螺仪读数可用（桌面浏览器、部分模拟器没有）。 */
export const gyroTiltSupported = () => (    typeof window !== 'undefined' && typeof window.DeviceOrientationEvent !== 'undefined'
);

interface GyroSettingsState {
    gyroTiltEnabled: boolean;
    /** 开关一次：落盘并改状态。 */
    handleToggleGyroTilt: (enable: boolean) => void;
    /** 场景转镜头的灵敏度倍数。 */
    gyroTiltGain: number;
    /** 改灵敏度：落盘并改状态。 */
    handleSetGyroTiltGain: (gain: number) => void;
    /**
     * 每个背景自己的开关，键是背景 mode（'particles' / 'sonic' / 'machi' …）。
     *
     * 没存过就是「跟随全局」—— 用户从没单独拨过这个背景，就不该因为全局开了
     * 而他恰好没配过这个背景而被当成关着。
     */
    gyroTiltPerMode: Record<string, boolean>;
    /** 单独开关某个背景。 */
    handleSetGyroTiltForMode: (mode: string, enable: boolean) => void;
}

export const useGyroSettingsStore = create<GyroSettingsState>()((set) => ({
    /*
     * 默认打开。
     *
     * iOS 那边真正拿读数还要在用户手势里过一道 requestPermission，没授权时
     * gyroTilt.ts 自己会静静地什么都不做，所以这里「默认开」不会在
     * 没授权的平台上留下一个假的「已开启」。安卓不需要这一步，装上就能用。
     */
    gyroTiltEnabled: getStoredBoolean(GYRO_TILT_STORAGE_KEY, true),
    handleToggleGyroTilt: (enable) => {
        setStoredBoolean(GYRO_TILT_STORAGE_KEY, enable);
        set({ gyroTiltEnabled: enable });
    },
    gyroTiltGain: readStoredGain(),
    handleSetGyroTiltGain: (gain) => {
        const clamped = Math.min(GYRO_TILT_GAIN_MAX, Math.max(GYRO_TILT_GAIN_MIN, gain));
        try {
            localStorage.setItem(GYRO_TILT_GAIN_STORAGE_KEY, String(clamped));
        } catch {
            // 存不下就只改这一次的状态，不影响用。
        }
        set({ gyroTiltGain: clamped });
    },
    gyroTiltPerMode: readStoredPerMode(),
    handleSetGyroTiltForMode: (mode, enable) => {
        const next = { ...useGyroSettingsStore.getState().gyroTiltPerMode, [mode]: enable };
        try {
            localStorage.setItem(GYRO_TILT_PER_MODE_STORAGE_KEY, JSON.stringify(next));
        } catch {
            // 存不下就只改这一次的状态，不影响用。
        }
        set({ gyroTiltPerMode: next });
    },
}));

/** 给非 React 的渲染层读当前值（背景每帧要判断要不要收读数）。 */
export const readGyroTiltEnabled = () => useGyroSettingsStore.getState().gyroTiltEnabled;
/**
 * 这个背景现在到底要不要吃陀螺仪。
 *
 * 全局关掉就是关；全局开着的时候看这个背景自己有没有被单独关过
 * （没存过 = 跟随全局，即开）。
 */
export const readGyroTiltEnabledForMode = (mode: string | null | undefined) => {
    const state = useGyroSettingsStore.getState();
    if (!state.gyroTiltEnabled) return false;
    if (!mode) return true;
    return state.gyroTiltPerMode[mode] ?? true;
};
/** 场景每帧读一次灵敏度：拖滑块时立刻生效，不用重挂。 */
export const readGyroTiltGain = () => useGyroSettingsStore.getState().gyroTiltGain;

/**
 * iOS 13 起要在用户手势里问一次权限。返回能不能用；不是 iOS（不需要问）时直接算可用。
 * 安卓 WebView 没有 requestPermission，就当已授权。
 */
export const requestGyroTiltPermission = async (): Promise<boolean> => {
    if (!gyroTiltSupported()) return false;
    const constructor = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    if (typeof constructor.requestPermission !== 'function') return true;
    try {
        return (await constructor.requestPermission()) === 'granted';
    } catch (error) {
        console.warn('[GyroTilt] 陀螺仪权限没拿到', error);
        return false;
    }
};
