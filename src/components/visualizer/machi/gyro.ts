// src/components/visualizer/machi/gyro.ts
// 町景的陀螺仪适配：把手机的倾斜读成镜头的小幅偏移（左右转头、上下俯仰），交给 engine/camera 叠在静止视角上。
// 只在这里碰 DeviceOrientationEvent；iOS 要先问一次权限，问过就不再问。

/** 手机最多能把镜头带偏多少（弧度）：左右 ±10°、上下 ±6°，再大就晕了。 */
export const MACHI_GYRO_RANGE = {
    azimuth: 10 * Math.PI / 180,
    elevation: 6 * Math.PI / 180,
};

/** 读数换算成偏移：转动角度按范围夹住，再乘一个系数放大到镜头上。 */
const DEGREE = Math.PI / 180;

/** 读数抖得厉害，一帧最多走这么多（弧度），剩下的下一帧追。 */
const MAX_STEP = 1.5 * DEGREE;

export interface MachiGyroOffsets {
    azimuth: number;
    elevation: number;
}

/** 这台设备有没有陀螺仪读数可用（桌面浏览器、部分模拟器没有）。 */
export const machiGyroSupported = () => typeof window !== 'undefined' && typeof window.DeviceOrientationEvent !== 'undefined';

/**
 * iOS 13 起要在用户手势里问一次权限。返回能不能用；不是 iOS（不需要问）时直接算可用。
 * 别的地方（比如安卓 WebView）没有 requestPermission，就当已授权。
 */
export const requestMachiGyroPermission = async (): Promise<boolean> => {
    if (!machiGyroSupported()) return false;
    const constructor = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    if (typeof constructor.requestPermission !== 'function') return true;
    try {
        return (await constructor.requestPermission()) === 'granted';
    } catch (error) {
        console.warn('[Machi] 陀螺仪权限没拿到', error);
        return false;
    }
};

/**
 * 订阅设备倾斜，回调给相对「按下开关那一刻」的偏移（弧度）。返回退订函数。
 * 用第一条读数当基准，所以开关一开画面不会突然跳；屏幕转过来（横竖屏）时基准跟着重置。
 */
export const subscribeMachiGyro = (onOffsets: (offsets: MachiGyroOffsets) => void) => {
    if (!machiGyroSupported()) return () => {};
    let origin: { beta: number; gamma: number } | null = null;
    const clamp = (value: number, limit: number) => Math.min(limit, Math.max(-limit, value));
    const reset = () => {
        origin = null;
    };
    // 转屏后 beta / gamma 的含义会变，重新取基准。
    window.addEventListener('orientationchange', reset);
    const listener = (event: DeviceOrientationEvent) => {
        // 没有陀螺仪的设备只给 null（有的连 alpha 都是 null）。
        if (event.beta === null || event.gamma === null) return;
        if (!origin) {
            origin = { beta: event.beta, gamma: event.gamma };
            return;
        }
        const gamma = clamp((event.gamma - origin.gamma) * DEGREE, MACHI_GYRO_RANGE.azimuth);
        const beta = clamp((event.beta - origin.beta) * DEGREE, MACHI_GYRO_RANGE.elevation);
        onOffsets({ azimuth: gamma, elevation: beta });
    };
    window.addEventListener('deviceorientation', listener);
    return () => {
        window.removeEventListener('deviceorientation', listener);
        window.removeEventListener('orientationchange', reset);
    };
};

/** 一帧能走的最大步长（弧度），给 engine/camera 平滑用。 */
export const MACHI_GYRO_MAX_STEP = MAX_STEP;
