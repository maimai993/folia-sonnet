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
/**
 * 屏幕转过的角度（0 / 90 / 180 / 270）。`beta` / `gamma` 是设备坐标系的读数，横屏时它们跟屏幕的
 * 左右、上下差 90°：直接用会「左右变成上下、上下变成左右」，所以要按屏幕角重映射。
 */
export const machiScreenAngle = (): number => {
    if (typeof window === 'undefined') return 0;
    const orientation = window.screen?.orientation as (ScreenOrientation & { angle?: number }) | undefined;
    const raw = orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
    return ((Math.round(raw / 90) * 90) % 360 + 360) % 360;
};

/**
 * 把设备坐标系里的倾斜量换算成屏幕坐标系里的偏移（弧度）。竖屏就是原来的「`gamma` 管左右、`beta` 管上下」；
 * 横屏两轴互换（90° 与 270° 差一个符号，对应手机往哪边横过来），180° 倒置时两轴都反。
 */
export const machiScreenOffsets = (deltaBeta: number, deltaGamma: number, angle: number): MachiGyroOffsets => {
    // `|| 0` 把 -0 归一成 0：偏移量算出负零没有意义，也比较容易在断言里踩坑。
    const rad = (degrees: number) => degrees * DEGREE || 0;
    switch (angle) {
    case 90:
        return { azimuth: rad(-deltaBeta), elevation: rad(deltaGamma) };
    case 180:
        return { azimuth: rad(-deltaGamma), elevation: rad(-deltaBeta) };
    case 270:
        return { azimuth: rad(deltaBeta), elevation: rad(-deltaGamma) };
    default:
        return { azimuth: rad(deltaGamma), elevation: rad(deltaBeta) };
    }
};

export const subscribeMachiGyro = (onOffsets: (offsets: MachiGyroOffsets) => void) => {
    if (!machiGyroSupported()) return () => {};
    let origin: { beta: number; gamma: number } | null = null;
    let last: { beta: number; gamma: number } | null = null;
    const clamp = (value: number, limit: number) => Math.min(limit, Math.max(-limit, value));
    /**
     * 手机翻过竖直方向时 beta / gamma 会换系、读数一跳就是几十上百度。这种跳变不能当成「倾斜到极限」，
     * 否则基准还留在旧姿态，人就觉得转到底之后陀螺仪失效、转回来也不回。超过这个幅度就当换系，重取基准。
     */
    const MAX_TRUSTED_JUMP = 60;
    const ZERO: MachiGyroOffsets = { azimuth: 0, elevation: 0 };
    /** 以当前姿态为新的基准，并把偏移交回零（镜头慢慢回机位，不跳）。 */
    const rebase = (reading: { beta: number; gamma: number }) => {
        origin = reading;
        onOffsets(ZERO);
    };
    const reset = () => {
        origin = null;
        last = null;
    };
    // 转屏后 beta / gamma 的含义会变，重新取基准。Android 上不一定都发 orientationchange，
    // screen.orientation 的 change 也接上（两处都注册，重复 reset 无副作用）。
    window.addEventListener('orientationchange', reset);
    const screenOrientation = (window.screen as Screen | undefined)?.orientation;
    screenOrientation?.addEventListener?.('change', reset);
    const listener = (event: DeviceOrientationEvent) => {
        // 没有陀螺仪的设备只给 null（有的连 alpha 都是 null）。
        if (event.beta === null || event.gamma === null) return;
        const reading = { beta: event.beta, gamma: event.gamma };
        const jumped = last !== null
            && (Math.abs(reading.beta - last.beta) > MAX_TRUSTED_JUMP || Math.abs(reading.gamma - last.gamma) > MAX_TRUSTED_JUMP);
        last = reading;
        if (!origin) {
            origin = reading;
            return;
        }
        if (jumped) {
            rebase(reading);
            return;
        }
        // 按屏幕角换算：竖屏左右是 gamma、上下是 beta，横屏两轴互换（见 machiScreenOffsets）。
        const mapped = machiScreenOffsets(reading.beta - origin.beta, reading.gamma - origin.gamma, machiScreenAngle());
        onOffsets({
            azimuth: clamp(mapped.azimuth, MACHI_GYRO_RANGE.azimuth),
            elevation: clamp(mapped.elevation, MACHI_GYRO_RANGE.elevation),
        });
    };
    window.addEventListener('deviceorientation', listener);
    return () => {
        window.removeEventListener('deviceorientation', listener);
        window.removeEventListener('orientationchange', reset);
        screenOrientation?.removeEventListener?.('change', reset);
    };
};

/** 一帧能走的最大步长（弧度），给 engine/camera 平滑用。 */
export const MACHI_GYRO_MAX_STEP = MAX_STEP;
