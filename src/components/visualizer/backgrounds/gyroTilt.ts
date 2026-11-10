// src/components/visualizer/backgrounds/gyroTilt.ts
// 陀螺仪适配：把手机的倾斜读成镜头的小幅偏移（左右转头、上下俯仰）。
//
// 这份逻辑本来在 components/visualizer/machi/gyro.ts，只给町景用。但它和背景样式
// 没有关系，是所有 3D 背景共用的东西（都走 backgrounds/orbitStage.ts 那套轨道相机），
// 所以搬到这里，町景那边改为从这里 import，行为不变。
//
// 只在这里碰 DeviceOrientationEvent；iOS 要先问一次权限，问过就不再问。

/**
 * 手机最多能把镜头带偏多少（弧度）。
 *
 * ★ 上限要跟着灵敏度一起抬。
 *
 * 灵敏度是「歪 1° 对应多少位移」，上限是「最多能偏多少」。
 * 灵敏度提上去而上限不动的话，手腕一动就顶到天花板，再怎么歪都没有区别 ——
 * 看起来就还是「不敏感」。所以这里跟着灵敏度抬到 ±9° / ±5°。
 */
export const GYRO_TILT_RANGE = {
    azimuth: 9 * Math.PI / 180,
    elevation: 5 * Math.PI / 180,
};

/**
 * 灵敏度：手机读数要先乘这个系数再进镜头。
 *
 * ★ 2.5（用户反馈「还是不敏感，想再灵敏一点」，2026-11-10）。
 *
 * 斜 15° 的手机带偏 37° 的镜头偏移；幅度上限（±9°）在斜 4° 左右就到顶，
 * 手腕稍微一动画面就有明显反应。
 *
 * 抖动的治法不在这里：读数过了低通滤波，相机跟随也压到 0.28 秒的时间常数，
 * 靠这两条压抖动。灵敏度只管「歪多少对应多少位移」，可以放开。
 */
const SENSITIVITY = 2.5;

/**
 * 死区（度）：小于这个幅度的倾斜当作没动。
 *
 * 手握手机时的细微抖动、呼吸带来的前后晃都在这个量级里。
 * 1°：真正的手抖仍在死区内，但正常地歪一下就有反应了。
 */
const DEAD_ZONE_DEGREES = 1;

const DEGREE = Math.PI / 180;

/** 读数抖得厉害，一帧最多走这么多（弧度），剩下的下一帧追。 */
export const GYRO_TILT_MAX_STEP = 0.6 * DEGREE;

export interface GyroTiltOffsets {
    azimuth: number;
    elevation: number;
}

/** 这台设备有没有陀螺仪读数可用（桌面浏览器、部分模拟器没有）。 */
export const gyroTiltSupported = () => (
    typeof window !== 'undefined' && typeof window.DeviceOrientationEvent !== 'undefined'
);

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

/**
 * 屏幕转过的角度（0 / 90 / 180 / 270）。`beta` / `gamma` 是设备坐标系的读数，横屏时它们跟屏幕的
 * 左右、上下差 90°：直接用会「左右变成上下、上下变成左右」，所以要按屏幕角重映射。
 */
export const gyroScreenAngle = (): number => {
    if (typeof window === 'undefined') return 0;
    const orientation = window.screen?.orientation as (ScreenOrientation & { angle?: number }) | undefined;
    const raw = orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
    return ((Math.round(raw / 90) * 90) % 360 + 360) % 360;
};

/**
 * 把设备坐标系里的倾斜量换算成屏幕坐标系里的偏移（弧度）。竖屏就是原来的「`gamma` 管左右、`beta` 管上下」；
 * 横屏两轴互换（90° 与 270° 差一个符号，对应手机往哪边横过来），180° 倒置时两轴都反。
 *
 * 返回值已经过死区和灵敏度处理：小幅抖动直接归零，剩下的按 SENSITIVITY 缩小。
 */
export const gyroScreenOffsets = (deltaBeta: number, deltaGamma: number, angle: number): GyroTiltOffsets => {
    // `|| 0` 把 -0 归一成 0：偏移量算出负零没有意义，也比较容易在断言里踩坑。
    const rad = (degrees: number) => degrees * DEGREE || 0;
    /** 死区：幅度不到 DEAD_ZONE_DEGREES 当作没动，多出来的部分才计入。 */
    const alive = (degrees: number) => {
        const magnitude = Math.abs(degrees);
        if (magnitude <= DEAD_ZONE_DEGREES) return 0;
        return Math.sign(degrees) * (magnitude - DEAD_ZONE_DEGREES) * SENSITIVITY;
    };
    const beta = alive(deltaBeta);
    const gamma = alive(deltaGamma);
    switch (angle) {
    case 90:
        return { azimuth: rad(-beta), elevation: rad(gamma) };
    case 180:
        return { azimuth: rad(-gamma), elevation: rad(-beta) };
    case 270:
        return { azimuth: rad(beta), elevation: rad(-gamma) };
    default:
        return { azimuth: rad(gamma), elevation: rad(beta) };
    }
};

export const subscribeGyroTilt = (onOffsets: (offsets: GyroTiltOffsets) => void) => {
    if (!gyroTiltSupported()) return () => {};
    let origin: { beta: number; gamma: number } | null = null;
    let last: { beta: number; gamma: number } | null = null;
    /**
     * 平滑后的**输出偏移**（低通）。
     *
     * ★ 滤波放在这里，不放在原始读数上。
     *
     * 早先滤的是读数：每帧只走 18% 的新读数，于是 6° 的真实倾斜被滤成
     * 1.08°，直接落进死区（1.5°）里 —— 输出恒为 0，陀螺仪看着完全不敏感
     * （单元测试就是这个用例挂的）。
     *
     * 现在分成两步：
     *   1. 原始读数差 → 死区 → 灵敏度 → 夹到范围内（这一步是「歪多少对应多少位移」）；
     *   2. 这个结果再过一遍低通（这一步是「把抖动抹平」）。
     *
     * 死区因此作用在真实倾斜上（3° 就是 3°），滤波只负责压噪声。
     */
    let smoothed: GyroTiltOffsets | null = null;
    const SMOOTHING = 0.25;
    const clamp = (value: number, limit: number) => Math.min(limit, Math.max(-limit, value));
    /**
     * 手机翻过竖直方向时 beta / gamma 会换系、读数一跳就是几十上百度。这种跳变不能当成「倾斜到极限」，
     * 否则基准还留在旧姿态，人就觉得转到底之后陀螺仪失效、转回来也不回。超过这个幅度就当换系，重取基准。
     */
    const MAX_TRUSTED_JUMP = 60;
    const ZERO: GyroTiltOffsets = { azimuth: 0, elevation: 0 };
    /** 以当前姿态为新的基准，并把偏移交回零（镜头慢慢回机位，不跳）。 */
    const rebase = (reading: { beta: number; gamma: number }) => {
        origin = reading;
        smoothed = null;
        onOffsets(ZERO);
    };
    const reset = () => {
        origin = null;
        last = null;
        smoothed = null;
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
        // 第一步：原始读数差直接进换算（死区与灵敏度作用在真实倾斜上）。
        const mapped = gyroScreenOffsets(reading.beta - origin.beta, reading.gamma - origin.gamma, gyroScreenAngle());
        const target: GyroTiltOffsets = {
            azimuth: clamp(mapped.azimuth, GYRO_TILT_RANGE.azimuth),
            elevation: clamp(mapped.elevation, GYRO_TILT_RANGE.elevation),
        };
        // 第二步：输出偏移过低通，抹掉抖动。
        smoothed = smoothed === null ? target : {
            azimuth: smoothed.azimuth + (target.azimuth - smoothed.azimuth) * SMOOTHING,
            elevation: smoothed.elevation + (target.elevation - smoothed.elevation) * SMOOTHING,
        };
        onOffsets(smoothed);
    };
    window.addEventListener('deviceorientation', listener);
    return () => {
        window.removeEventListener('deviceorientation', listener);
        window.removeEventListener('orientationchange', reset);
        screenOrientation?.removeEventListener?.('change', reset);
    };
};
