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
// ★ 这里是「吃不吃读数」**唯一**的判据（issue #429）：以前还有一份按背景分开的开关
// （'gyro_tilt_per_mode'：有的背景晃着好看，有的一动就晕），结果变成「这个背景能用、
// 那个不能用」的白名单。现在所有画面都吃同一份读数，那个键只留在存储契约里不再读，
// 已发布的键名不改（见 dev/dedicatus/storageKeys.mjs 与 storeContract 快照）。

import { create } from 'zustand';
import { getStoredBoolean, setStoredBoolean } from './storagePrimitives';

export const GYRO_TILT_STORAGE_KEY = 'gyro_tilt_enabled';
/** 灵敏度（场景转镜头的倍数）落盘的键。 */
export const GYRO_TILT_GAIN_STORAGE_KEY = 'gyro_tilt_gain';
/**
 * 旧的「按背景单独开关」的键。
 *
 * 已经没有任何代码读写它；留着这个常量是因为键名属于已发布的存储契约
 * （storeContract 快照与 D507 登记），改名或删掉都会让那些检查对不上，而丢掉用户
 * 存过的值也没有意义 —— 那个开关控制的行为已经没有了。
 */
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
}));

/** 给非 React 的渲染层读当前值（背景每帧要判断要不要收读数）。 */
export const readGyroTiltEnabled = () => useGyroSettingsStore.getState().gyroTiltEnabled;
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
