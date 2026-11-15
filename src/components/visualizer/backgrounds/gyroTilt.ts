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
    /*
     * 上下原来只有 ±5°，是左右的六成不到。俯仰的手腕行程本来就和左右差不多，
     * 于是稍微一低头就顶到天花板、再歪也没区别 —— 手感是「上半截卡死」。
     * 抬到 ±8°，和左右基本齐平，俯仰才走得动。
     */
    elevation: 8 * Math.PI / 180,
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
 *
 * ★ 现在从 2.5 收到 1.2：2.5 的时候斜 4° 就顶到上限，手腕稍微一动画面就甩到头，
 * 手感像「一碰就飞」。1.2 之后斜 8° 左右到顶，正常举着手机歪一下是渐进的。
 */
export const SENSITIVITY = 1.2;

/**
 * 死区（度）：小于这个幅度的倾斜当作没动。
 *
 * 手握手机时的细微抖动、呼吸带来的前后晃都在这个量级里。
 * 1°：真正的手抖仍在死区内，但正常地歪一下就有反应了。
 */
export const DEAD_ZONE_DEGREES = 1;

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
 * 把设备坐标系里的倾斜量换算成屏幕坐标系里的偏移（弧度）。
 *
 * 输入是**两个姿态的相对旋转**（四元数），不是简单的角度差 —— 见 poseToQuaternion。
 * 输出仍然是屏幕上的「向右多少」「向上多少」，横竖屏由 angle 决定。
 *
 * 返回值已经过死区和灵敏度处理：小幅抖动直接归零，剩下的按 SENSITIVITY 缩小。
 */
export const gyroScreenOffsets = (deltaBeta: number, deltaGamma: number, angle: number): GyroTiltOffsets => {
    // `|| 0` 把 -0 归一成 0：偏移量算出负零没有意义，也比较容易在断言里踩坑。
    const rad = (degrees: number) => degrees * DEGREE || 0;
    /*
     * 死区按**整体幅度**判门限，但**每个轴各自扣一次死区**。
     *
     * 只做一维判断会出事：竖着拿手机时俯仰（beta）可用幅度小、左右（gamma）一动就是十几度，
     * 两个轴各自 ``|x| <= 1° 归零`` 会让俯仰一直被吃掉（「上下不动、只左右晃」），
     * 某个轴在死区边缘被钉成 0 之后还会**卡死**。
     *
     * 所以门槛看两根轴合起来的长度：整体进了死区才算「没动」，谁也不因为自己小就被单独判死。
     * 但扣减仍然按轴各扣一次 —— 整体只扣一次的话，两轴同时动作时会多给一截
     * （``hypot(10,10)`` 走整体扣减得 11.4°，实际该是 10.8°），画面就跟手不同步了。
     */
    const magnitude = Math.hypot(deltaBeta, deltaGamma);
    if (magnitude <= DEAD_ZONE_DEGREES) {
        return { azimuth: 0, elevation: 0 };
    }
    const alive = (degrees: number) => Math.sign(degrees) * Math.max(0, Math.abs(degrees) - DEAD_ZONE_DEGREES) * SENSITIVITY;
    const beta = alive(deltaBeta);
    const gamma = alive(deltaGamma);
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
    return { azimuth: rad(denoise(right)), elevation: rad(denoise(up)) };
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
    const [w, x, y, z] = quatMul(inverse, q1);
    /*
     * 把相对旋转**变换回设备自己的坐标系**再取角。
     *
     * 这一步是必须的。相对旋转 q = q0⁻¹·q1 算出来是在**世界系**里的，直接取
     * 它的 y/z 分量，量到的是「绕世界竖轴转了多少」。可用户要的是「绕手机自己的
     * 竖轴转了多少」—— 手机一旦是斜的（beta=40°），这两根轴差了一大截，
     * 实测 gamma 明明变了 6°，读出来却是 -11.2°，方向和大小都错。
     *
     * 做法：用 q0 把 q 转到局部系，q_local = q0 · q · q0⁻¹。
     */
    const local = quatMul(quatMul(q0, [w, x, y, z]), inverse);
    const [lw, lx, , lz] = local;
    /*
     * 取角用旋转矩阵的对称差：
     *   m[2][1] - m[1][2] = 4·w·x   → 绕设备横轴（俯仰）
     *   m[1][0] - m[0][1] = 4·w·z   → 绕设备竖轴（左右）
     * 归一化后就是 asin(2wx) 与 asin(2wz)。
     *   beta 0→10  给出 2wx 项 = 10°；
     *   gamma 0→10 给出 2wz 项 = 10°。
     * 两个轴的耦合在矩阵里已经算干净，不用再自己凑系数。
     */
    const norm = Math.hypot(lw, lx, lz) || 1;
    const W = lw / norm; const X = lx / norm; const Z = lz / norm;
    const clampUnit = (value: number) => Math.max(-1, Math.min(1, value));
    const toDeg = 180 / Math.PI;
    /*
     * 输出的是**设备系**的 beta / gamma 增量，方向与直接读 deviceorientation 一致
     * （beta 变大 = elevation 变大、gamma 变大 = azimuth 变大）；
     * 屏幕角度的换算交给 gyroScreenOffsets，两层不要各翻一次符号。
     */
    return {
        beta: Math.asin(clampUnit(2 * W * X)) * toDeg,
        gamma: Math.asin(clampUnit(2 * W * Z)) * toDeg,
    };
};

export const subscribeGyroTilt = (onOffsets: (offsets: GyroTiltOffsets) => void) => {
    if (!gyroTiltSupported()) return () => {};
    let origin: { alpha: number; beta: number; gamma: number } | null = null;
    let last: { alpha: number; beta: number; gamma: number } | null = null;
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
    /** 传感器最近一次给出的目标值；rAF 循环负责把 smoothed 往它那儿推。 */
    let target: GyroTiltOffsets | null = null;
    /**
     * 平滑的时间常数（秒），不是「每次走多少」。
     *
     * ★ 原来写的是固定系数 0.25：每来一个 deviceorientation 事件就把当前值往目标挪 25%。
     * 那套在事件频率稳定时看着还行，可传感器的频率根本不稳定 —— 有的机器 60Hz，有的 10Hz，
     * 系统还会把一阵子的事件攒起来一次性丢过来。同样的系数，60Hz 时 50ms 就走完，
     * 10Hz 时一次跳一大格，成串来的时候更是原地抖好几下：手感就是「一顿一顿、很卡」。
     *
     * 现在按**真实经过的时间**推进（指数逼近，帧率无关）：不管设备给多少 Hz、
     * 事件来得有多不均匀，画面在同一条时间曲线上走。
     */
    const FOLLOW_SECONDS = 0.06;
    /** 单帧最多补这么多秒：后台回来或者掉帧时，别一帧走完一大截。 */
    const MAX_STEP_SECONDS = 0.1;
    /*
     * 用 rAF 而不是在事件回调里直接算。
     *
     * 传感器事件可能一阵子来好几个、也可能半天不来一个；跟着它走，画面就跟着它抖。
     * 交给 rAF 之后，事件只负责「更新目标值」，画面永远按屏幕自己的节奏走。
     */
    let frame: number | null = null;
    let lastFrameAt = 0;
    /*
     * 没有 rAF 的环境（单元测试的 node 环境就没有）直接按事件推进：
     * 拿不到屏幕的节奏，就退回原来那套，至少功能是对的。
     */
    const hasRaf = typeof requestAnimationFrame === 'function';
    /** 把 smoothed 往 target 推一步；step 是这一步代表多少秒。 */
    const advance = (step: number) => {
        if (target === null) return;
        if (smoothed === null) {
            smoothed = target;
            onOffsets(smoothed);
            return;
        }
        // 指数逼近：经过 FOLLOW_SECONDS 之后走过剩余距离的 (1 - 1/e)，与帧率无关。
        const alpha = 1 - Math.exp(-step / FOLLOW_SECONDS);
        smoothed = {
            azimuth: smoothed.azimuth + (target.azimuth - smoothed.azimuth) * alpha,
            elevation: smoothed.elevation + (target.elevation - smoothed.elevation) * alpha,
        };
        onOffsets(smoothed);
    };
    const tick = (now: number) => {
        frame = requestAnimationFrame(tick);
        const step = Math.min(MAX_STEP_SECONDS, lastFrameAt === 0 ? 1 / 60 : (now - lastFrameAt) / 1000);
        lastFrameAt = now;
        advance(step);
    };
    const clamp = (value: number, limit: number) => Math.min(limit, Math.max(-limit, value));
    /**
     * 手机翻过竖直方向时 beta / gamma 会换系、读数一跳就是几十上百度。这种跳变不能当成「倾斜到极限」，
     * 否则基准还留在旧姿态，人就觉得转到底之后陀螺仪失效、转回来也不回。超过这个幅度就当换系，重取基准。
     */
    const MAX_TRUSTED_JUMP = 60;
    const ZERO: GyroTiltOffsets = { azimuth: 0, elevation: 0 };
    /** 以当前姿态为新的基准，并把偏移交回零（镜头慢慢回机位，不跳）。 */
    const rebase = (reading: { alpha: number; beta: number; gamma: number }) => {
        origin = reading;
        smoothed = null;
        target = null;
        onOffsets(ZERO);
    };
    const reset = () => {
        origin = null;
        last = null;
        smoothed = null;
        target = null;
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
        const delta = gyroPoseDelta(origin, reading, gyroScreenAngle());
        const mapped = gyroScreenOffsets(delta.beta, delta.gamma, gyroScreenAngle());
        // 第二步：只记下目标值，平滑交给 rAF（见 tick）：事件来得多快都不影响画面节奏。
        target = {
            azimuth: clamp(mapped.azimuth, GYRO_TILT_RANGE.azimuth),
            elevation: clamp(mapped.elevation, GYRO_TILT_RANGE.elevation),
        };
        // 没有 rAF（node 测试环境）就在这儿直接走一步，否则读数永远交不出去。
        if (!hasRaf) advance(1 / 60);
    };
    window.addEventListener('deviceorientation', listener);
    if (hasRaf) frame = requestAnimationFrame(tick);
    return () => {
        window.removeEventListener('deviceorientation', listener);
        window.removeEventListener('orientationchange', reset);
        screenOrientation?.removeEventListener?.('change', reset);
        if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
        frame = null;
    };
};
