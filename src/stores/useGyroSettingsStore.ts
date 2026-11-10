// src/stores/useGyroSettingsStore.ts
// 全局「陀螺仪适配」开关。
//
// 这份开关原来只服务町景（见 components/visualizer/machi/gyro.ts），可它想做的事情
// 和背景无关：手机往哪边歪，镜头就跟着轻轻偏一点。所有 3D 背景（町景 / 粒子 /
// 星河 / 安魂 / 音域回响）用的是同一套轨道相机，所以这个开关也应该是全局的一份，
// 而不是某个背景自己的调优项。
//
// 读写 localStorage 的 'gyro_tilt_enabled'：默认**关**。陀螺仪读数在部分设备上
// 抖得厉害，默认开着会让人以为背景在乱晃。

import { create } from 'zustand';
import { getStoredBoolean, setStoredBoolean } from './storagePrimitives';

export const GYRO_TILT_STORAGE_KEY = 'gyro_tilt_enabled';

/** 这台设备有没有陀螺仪读数可用（桌面浏览器、部分模拟器没有）。 */
export const gyroTiltSupported = () => (
    typeof window !== 'undefined' && typeof window.DeviceOrientationEvent !== 'undefined'
);

interface GyroSettingsState {
    gyroTiltEnabled: boolean;
    /** 开关一次：落盘并改状态。 */
    handleToggleGyroTilt: (enable: boolean) => void;
}

export const useGyroSettingsStore = create<GyroSettingsState>()((set) => ({
    gyroTiltEnabled: getStoredBoolean(GYRO_TILT_STORAGE_KEY, false),
    handleToggleGyroTilt: (enable) => {
        setStoredBoolean(GYRO_TILT_STORAGE_KEY, enable);
        set({ gyroTiltEnabled: enable });
    },
}));

/** 给非 React 的渲染层读当前值（背景每帧要判断要不要收读数）。 */
export const readGyroTiltEnabled = () => useGyroSettingsStore.getState().gyroTiltEnabled;

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
