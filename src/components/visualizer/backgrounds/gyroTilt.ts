// src/components/visualizer/backgrounds/gyroTilt.ts
// 陀螺仪适配：把手机的倾斜读成镜头的小幅偏移（左右转头、上下俯仰）。
//
// 这份逻辑本来在 components/visualizer/machi/gyro.ts，只给町景用。但它和背景样式
// 没有关系，是所有 3D 背景共用的东西（都走 backgrounds/orbitStage.ts 那套轨道相机），
// 所以搬到这里，町景那边改为从这里 import，行为不变。
//
// 只在这里碰 DeviceOrientationEvent；iOS 要先问一次权限，问过就不再问。
//
// 死区、灵敏度、限幅、低通都在 gyroTiltModel.ts（纯函数 + 一处常量）；
// 这里只负责「读事件 → 换算成相对基准的倾角 → 交给那一层 → 把结果按帧交出去」。

import {
    createGyroTiltSmoother,
    gyroTiltTarget,
    stepGyroTilt,
    type GyroTiltOffsets,
} from './gyroTiltModel';

export {
    GYRO_TILT_DEAD_ZONE_DEGREES,
    GYRO_TILT_RANGE,
    GYRO_TILT_SENSITIVITY,
    GYRO_TILT_TIME_CONSTANT_SECONDS,
    type GyroTiltOffsets,
} from './gyroTiltModel';

/**
 * 旧名字，留着给已有调用点：灵敏度现在是 gyroTiltModel 的 GYRO_TILT_SENSITIVITY。
 * 新代码直接用那几个常量。
 */
export { GYRO_TILT_SENSITIVITY as SENSITIVITY } from './gyroTiltModel';

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
 * 设备姿态（alpha/beta/gamma，度）转成四元数。
 *
 * 为什么要绕这一圈：`beta`/`gamma` 是欧拉角，两个轴**不是独立的** ——
 * 手机拿在手里（beta ≈ 90°）时，左右歪一点 `beta` 也会跟着变，这点串扰进了
 * 俯仰通道，表现就是「左右晃的时候上下也跟着抖」。反过来，真正想抬头低头时，
 * `beta` 又会撞上 90° 这个万向节，方向直接翻掉 —— 所以俯仰怎么都不对。
 *
 * 换成四元数之后，两个姿态之间的**相对旋转**是一个干净的三维旋转，
 * 再把它拆成「绕屏幕竖轴转了多大」「绕屏幕横轴转了多大」，两轴互不干扰。
 *
 * 顺序取 Z-X'-Y''（W3C 的 deviceorientation 就是这么定义的）。
 */
const poseToQuaternion = (alpha: number, beta: number, gamma: number): [number, number, number, number] => {
    // `|| 0` 把 -0 归一成 0：偏移量算出负零没有意义。
    const a = ((alpha || 0) * Math.PI) / 360;
    const b = ((beta || 0) * Math.PI) / 360;
    const g = ((gamma || 0) * Math.PI) / 360;
    const cA = Math.cos(a); const sA = Math.sin(a);
    const cB = Math.cos(b); const sB = Math.sin(b);
    const cG = Math.cos(g); const sG = Math.sin(g);
    return [
        cA * cB * cG - sA * sB * sG,
        cA * sB * cG + sA * cB * sG,
        sA * cB * cG - cA * sB * sG,
        cA * cB * sG + sA * sB * cG,
    ];
};

/**
 * 把设备坐标系里的倾角换算成屏幕坐标系里的倾角（度）。
 *
 * 输入是**两个姿态的相对旋转**（四元数算出来的 beta / gamma 增量），不是简单的角度差 ——
 * 见 poseToQuaternion。输出是屏幕上的「向右偏了多少度」「向上偏了多少度」，横竖屏由 angle 决定。
 *
 * **这里只换坐标系，不做死区、不做灵敏度、不限幅**：那三件事是「镜头怎么动」，
 * 统一在 gyroTiltModel.gyroTiltTarget 里做一次。以前死区与灵敏度就混在这个换算里，
 * 于是「读数本身的倾角」和「镜头已经扣过死区的偏移」变成同一个数，谁也没法再拿它
 * 去算转速或判断快慢。
 */
export const gyroScreenTilt = (deltaBeta: number, deltaGamma: number, angle: number): { beta: number; gamma: number } => {
    const beta = deltaBeta || 0;
    const gamma = deltaGamma || 0;
    /*
     * 屏幕转过多少，两轴就跟着转多少。
     *
     * 屏幕是**顺时针**转了 θ 才横过来的，所以把设备轴转到屏幕轴要用 -θ：
     *   屏幕向右 = cos(θ)·gamma - sin(θ)·beta
     *   屏幕向上 = sin(θ)·gamma + cos(θ)·beta
     * 竖屏 θ=0 时退化成「gamma 管左右、beta 管上下」；
     * 90° 时变成「-beta 管左右、+gamma 管上下」，180 与 270 依次推出来。
     */
    const theta = (angle * Math.PI) / 180;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const right = gamma * cos - beta * sin;
    const up = gamma * sin + beta * cos;
    /*
     * 转 90° 的整数倍时 cos/sin 是 cos(90°)=6.1e-17 这样的浮点残渣，不是精确的 0。
     * 乘出来就是 1e-17 量级的「假偏移」，肉眼看不见，但会让「这一轴应该恰好是 0」
     * 的判断与断言失效。小于千分之一度的一律归零。
     */
    const denoise = (degrees: number) => (Math.abs(degrees) < 1e-3 ? 0 : degrees);
    // `|| 0` 把 -0 归一成 0：0 没有符号，负零会让断言里的 toEqual 踩坑。
    const zeroSafe = (degrees: number) => denoise(degrees) || 0;
    return { beta: zeroSafe(up), gamma: zeroSafe(right) };
};

type Quat = readonly [number, number, number, number];

/** 四元数乘法 a·b：先转 b 再转 a。 */
const quatMul = (a: Quat, b: Quat): Quat => {
    const [aw, ax, ay, az] = a;
    const [bw, bx, by, bz] = b;
    return [
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
    ];
};

/**
 * 两个设备姿态之间的相对倾斜，拆成屏幕上的「左右」「上下」（度）。
 *
 * 这是真正给订阅者用的一条路：先各自转四元数、算相对旋转，再取角 —— 见 poseToQuaternion
 * 里关于「为什么不能直接拿 beta/gamma 相减」的说明。
 */
export const gyroPoseDelta = (
    from: { alpha: number; beta: number; gamma: number },
    to: { alpha: number; beta: number; gamma: number },
    angle: number,
): { beta: number; gamma: number } => {
    const q0 = poseToQuaternion(from.alpha, from.beta, from.gamma);
    const q1 = poseToQuaternion(to.alpha, to.beta, to.gamma);
    const [w0, x0, y0, z0] = q0;
    /*
     * 相对旋转 q = q0⁻¹ · q1。
     *
     * 一律走 quatMul，不手写展开式 —— 手写的时候 x/y/z 的符号组合很容易串一位，
     * 而错了之后观测到的现象是「数值大小看着差不多、方向却是反的」，最难查。
     */
    const inverse: Quat = [w0, -x0, -y0, -z0];
    const delta = quatMul(inverse, q1);
    /*
     * 取相对旋转绕**手机当前**横轴、竖轴的分量。
     *
     * ★ 旧实现多了两步：先用 q0 把相对旋转搬回「按下开关那一刻」的手机坐标系
     * （q_local = q0·d·q0⁻¹），再取它的 y/z 分量。那一步是错的，而且错得很隐蔽：
     *
     *   - 手机竖着拿（beta ≈ 90°）时，设备 y 轴与世界竖轴重合。左右歪一下的分量
     *     会被那一步投影到设备 x 上，两个轴都读成 0 —— 举着手机往旁边歪，
     *     画面**一点反应都没有**；
     *   - beta = 40° 时歪 10° 只读到 7.7°，75° 时只读到 2.6°。越接近竖着拿越钝，
     *     手感就是「刚拿起来还行，举稳了就不动了」。
     *
     * 相对旋转 d = q0⁻¹·q1 本来就已经在 q0 的坐标系里表达（左乘逆 = 先换成 q0 的坐标），
     * 它的 y 分量就是绕 q0 横轴的转角、z 分量就是绕 q0 竖轴的转角。
     *
     * 要另做的是「手机整体绕世界竖直转」的那部分（站在不同方向、桌面转椅）：那时
     * 整个旋转轴都换了，y/z 分量会串到一起去。做法是先把基准的姿态拆出「绕世界竖轴
     * 转了多少」，再从相对旋转里把这一段扣掉，剩下的就是纯倾斜。
     */
    const yaw = baselineYaw(q0);
    // 绕设备 z 轴转 -yaw 的四元数——在 q0 下它就是绕世界竖直转的同一个角度。
    const unwind: Quat = [Math.cos(yaw / 2), 0, 0, -Math.sin(yaw / 2)];
    const tilt = quatMul(unwind, delta);
    const lw = tilt[0];
    const lx = tilt[1];
    const lz = tilt[3];
    /*
     * 取角用旋转矩阵的对称差：
     *   m[2][1] - m[1][2] = 4·w·x   → 绕设备横轴（俯仰）
     *   m[1][0] - m[0][1] = 4·w·z   → 绕设备竖轴（左右）
     * 归一化后就是 asin(2wx) 与 asin(2wz)。
     *   beta 0→10  给出 2wx 项 = 10°；
     *   gamma 0→10 给出 2wz 项 = 10°。
     */
    const norm = Math.hypot(lw, lx, lz) || 1;
    const W = lw / norm; const X = lx / norm; const Z = lz / norm;
    const clampUnit = (value: number) => Math.max(-1, Math.min(1, value));
    const toDeg = 180 / Math.PI;
    /*
     * 输出的是**设备系**的 beta / gamma 增量，方向与直接读 deviceorientation 一致
     * （beta 变大 = elevation 变大、gamma 变大 = azimuth 变大）；
     * 屏幕角度的换算交给 gyroScreenTilt，两层不要各翻一次符号。
     */
    return {
        beta: Math.asin(clampUnit(2 * W * X)) * toDeg,
        gamma: Math.asin(clampUnit(2 * W * Z)) * toDeg,
    };
};

/**
 * 基准姿态里「手机绕世界竖轴转了多少」（弧度）。
 *
 * 手机拿在手里、屏幕朝自己立起来时，设备的竖轴在世界里是精确竖直的 —— 取姿态的
 * Z-Y'-X'' 欧拉分解里第一个角就是这段偏航。拆不出来（浮点误差把 sin(beta) 抬过 1）时当 0。
 */
const baselineYaw = (q0: Quat): number => {
    const [w, x, y, z] = q0;
    const sinBeta = 2 * (w * y - z * x);
    const clamped = Math.max(-1, Math.min(1, sinBeta));
    if (Math.abs(clamped) > 1 - 1e-9) return 0;
    return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
};

/**
 * 订阅「手机倾角 → 镜头偏移」，按屏幕的节奏（rAF）把偏移交出来。
 *
 * 一条读数进来要经过三步，**每一步只有一处**：
 *   1. 相对基准的姿态差走四元数（gyroPoseDelta），再按屏幕角换成屏幕轴（gyroScreenTilt）——
 *      这一步只换坐标系，输出是「屏幕向右 / 向上各偏了多少度」；
 *   2. gyroTiltTarget：死区 → 灵敏度 → 限幅，得到「镜头该到什么角度」；
 *   3. stepGyroTilt：按真实 dt 走一阶低通，得到「这一帧镜头在哪」。
 *
 * 画面上看到的就是第 3 步的结果，中间不再叠任何阻尼 —— 以前轨道相机与町景相机各自
 * 又追了一遍，串起来的时间常数近半秒，这才是「迟滞」的来源。
 *
 * 传感器事件只负责更新第 2 步的目标值，第 3 步固定跟着 rAF 走：事件来得多快、
 * 多不均匀，画面的曲线都是同一条。
 */
export const subscribeGyroTilt = (onOffsets: (offsets: GyroTiltOffsets) => void) => {
    if (!gyroTiltSupported()) return () => {};
    let origin: { alpha: number; beta: number; gamma: number } | null = null;
    let last: { alpha: number; beta: number; gamma: number } | null = null;
    /** 低通的全部状态（当前偏移 + 上一帧的目标）。 */
    const smoother = createGyroTiltSmoother();
    /** 屏幕轴上的倾角（度）：传感器最近一次给出的。rAF 每帧拿它算一次目标。 */
    let tilt = { beta: 0, gamma: 0 };
    /** 有没有收到过读数：没收到之前一帧都不该往外交（交了就是一堆假零）。 */
    let live = false;
    /*
     * 手机翻过竖直方向时 beta / gamma 会换系、读数一跳就是几十上百度。这种跳变不能当成「倾斜到极限」，
     * 否则基准还留在旧姿态，人就觉得转到底之后陀螺仪失效、转回来也不回。超过这个幅度就当换系，重取基准。
     */
    const MAX_TRUSTED_JUMP = 60;
    const resetSmoother = () => {
        smoother.value = { azimuth: 0, elevation: 0 };
        smoother.lastTarget = { azimuth: 0, elevation: 0 };
        smoother.speed = 0;
    };
    /** 以当前姿态为新的基准，并把偏移交回零。 */
    const rebase = (reading: { alpha: number; beta: number; gamma: number }) => {
        origin = reading;
        tilt = { beta: 0, gamma: 0 };
        resetSmoother();
        onOffsets({ azimuth: 0, elevation: 0 });
    };
    const reset = () => {
        origin = null;
        last = null;
        tilt = { beta: 0, gamma: 0 };
        live = false;
        resetSmoother();
    };
    // 转屏后 beta / gamma 的含义会变，重新取基准。Android 上不一定都发 orientationchange，
    // screen.orientation 的 change 也接上（两处都注册，重复 reset 无副作用）。
    window.addEventListener('orientationchange', reset);
    const screenOrientation = (window.screen as Screen | undefined)?.orientation;
    screenOrientation?.addEventListener?.('change', reset);
    const listener = (event: DeviceOrientationEvent) => {
        // 没有陀螺仪的设备只给 null（有的连 alpha 都是 null）。
        if (event.beta === null || event.gamma === null) return;
        const reading = { alpha: event.alpha ?? 0, beta: event.beta, gamma: event.gamma };
        /*
         * 跳变判断仍然看 beta / gamma：四元数里 0° 与 360° 是同一个姿态，
         * 拿角度直接比会把「alpha 绕了一圈」误判成跳变。姿态本身去抖，
         * 这里只负责识别「翻过竖直了」这种真的换系。
         */
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
        /*
         * 相对基准的姿态差走四元数（gyroPoseDelta），不再拿 beta/gamma 直接相减。
         *
         * 手机竖着拿时 beta 就在 90° 附近，两个欧拉角在这里是**耦合**的：低头时 beta 变，
         * 左右歪也会带着 beta 变一点点，反过来俯仰又会从 gamma 里漏出来。
         * 于是「上下动只左右晃、俯仰干脆不动」—— 这正是之前看到的现象。
         * 四元数求的是两个姿态之间的真实旋转，两轴不再串。
         */
        const angle = gyroScreenAngle();
        const delta = gyroPoseDelta(origin, reading, angle);
        tilt = gyroScreenTilt(delta.beta, delta.gamma, angle);
        live = true;
    };
    /*
     * 用 rAF 而不是在事件回调里直接算。传感器事件可能一阵子来好几个、也可能半天不来一个；
     * 跟着它走，画面就跟着它抖。交给 rAF 之后，事件只更新倾角，画面永远按屏幕自己的节奏走。
     */
    const hasRaf = typeof requestAnimationFrame === 'function';
    const advance = (step: number) => {
        if (!live) return;
        onOffsets(stepGyroTilt(smoother, gyroTiltTarget(tilt), step));
    };
    let frame: number | null = null;
    let lastFrameAt = 0;
    const tick = (now: number) => {
        frame = requestAnimationFrame(tick);
        /*
         * 第一帧没有上一帧可比：按 60Hz 的一帧算，别用 performance.now() 那个大数
         * （有的机器 rAF 给的 now 与那套时间轴不同源，第一帧会算出几十秒）。
         */
        const step = lastFrameAt === 0 ? 1 / 60 : (now - lastFrameAt) / 1000;
        lastFrameAt = now;
        advance(step);
    };
    /*
     * 没有 rAF 的环境（单元测试的 node 环境就没有）按事件推进：拿不到屏幕的节奏，
     * 就退回「每条读数走一帧」。
     *
     * ★ 这个监听必须和主监听一起注销。早先它是注册在一个匿名函数上、退回时又从没删过：
     * 每一行读数都会让平滑推进两次（时间常数等于凭空减半），而带 rAF 的真实环境里
     * 主监听那份又什么都不做 —— 同一个订阅在两种环境下的手感不一样，很难查。
     */
    const fallbackListener = hasRaf ? null : () => advance(1 / 60);
    window.addEventListener('deviceorientation', listener);
    if (fallbackListener) window.addEventListener('deviceorientation', fallbackListener);
    if (hasRaf) frame = requestAnimationFrame(tick);
    return () => {
        window.removeEventListener('deviceorientation', listener);
        if (fallbackListener) window.removeEventListener('deviceorientation', fallbackListener);
        window.removeEventListener('orientationchange', reset);
        screenOrientation?.removeEventListener?.('change', reset);
        if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
        frame = null;
    };
};
