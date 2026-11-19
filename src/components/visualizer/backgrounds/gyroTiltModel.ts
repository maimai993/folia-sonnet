// src/components/visualizer/backgrounds/gyroTiltModel.ts
// 「手机倾角 → 镜头偏移」的纯函数：死区、灵敏度、限幅、一阶低通都只在这里算一次。
//
// 为什么要单独一层：手感出问题（迟滞 / 过冲 / 抖）几乎全是这几个数字与它们的顺序造成的，
// 而原来的实现把它们散在「传感器订阅」「轨道相机」「町景相机」「场景转镜头」四处，
// 同一份读数被平滑了三次，谁也说不清画面最后跟的是哪条曲线。现在：
//
//   gyroTiltTarget()  一行读数 → 该到的镜头偏移（死区 → 灵敏度 → 限幅），不含时间；
//   createGyroTiltSmoother()  一条按真实时间走的自适应一阶低通，把偏移推到目标；
//   stepGyroTilt()    「这一帧走到哪」就这一行，传 dt 与目标即可。
//
// 相机那边只负责把交出来的偏移贴到画面上，不再自己叠第二层阻尼（那层会让动作落后一截）。

/** 一个镜头的偏移量（弧度）。 */
export interface GyroTiltOffsets {
    azimuth: number;
    elevation: number;
}

const DEGREE = Math.PI / 180;

/**
 * 手机最多能把镜头带偏多少（弧度）。
 *
 * 上限是「用户根本没动、只是把手机拿在某个角度」时镜头停的位置，所以它同时是
 * 读数的有效范围：超过它的倾斜不再让画面多转，但**也不能丢** —— 手机还歪在
 * 40°、用户从头开始歪的时候读数已经贴着上限，再往上歪就没有任何回应了。
 *
 * ±30°：按下面 1.5 的灵敏度，读数到 21° 左右封顶，正常拿手机歪一下（15~20°）
 * 已经在往天花板走，再大就是「手举过头」那种极端姿势了。
 */
export const GYRO_TILT_RANGE = {
    azimuth: 30 * DEGREE,
    elevation: 30 * DEGREE,
};

/**
 * 死区（度）：整体倾角小于这个数就当没动。
 *
 * 0.6°：手持的细微抖动、呼吸带来的前后晃都在这个量级以内，静止时画面不会自己漂；
 * 而真正想歪一下至少有 2~3°，不会被吞掉。判的是两个轴的**合起来**（见 gyroTiltTarget）。
 */
export const GYRO_TILT_DEAD_ZONE_DEGREES = 0.6;

/**
 * 灵敏度：读数（度，已扣死区）乘这个系数才是镜头偏移（度）。
 *
 * 1.5：读数 15° → 画面偏 22°。和旧实现（2.5 的倍率、左右 ±9° 封顶）相比，
 * 「日常手一歪」的画面位移一样明显，但封顶从 4° 的倾斜抬到 21°，
 * 中途不会突然撞到墙。场景转镜头那一侧本来还有一个 6 倍的放大，现在一起收进
 * 这里的 30° 上限里（见 scenes/engine/sceneSignals.ts）。
 */
export const GYRO_TILT_SENSITIVITY = 1.5;

/**
 * 一阶低通的时间常数（秒）：画面走完「剩余距离」的 63% 要这么久。
 *
 * 80ms 是跟手与稳的折中：慢动作（可以逐帧看）时 80ms 以上才看得出「拖着走」，
 * 80ms 以内更像画面直接跟着手走；而传感器噪声（约 10~50Hz）会被削掉一大截。
 *
 * 旧实现这里是 max(FILTER 60ms, 相机 280ms, 场景 110ms) ≈ 450ms —— 一次倾斜
 * 要将近半秒才走完 95%，这就是「迟滞」「不跟手」的直接来源。
 */
export const GYRO_TILT_TIME_CONSTANT_SECONDS = 0.08;

/**
 * 慢动作时额外的时间常数（秒）：镜头偏移变化得很慢（每秒不到 40°）时用的那个。
 *
 * 自适应而不是固定值：慢动作要更稳（否则画面能看出细微的抖），快动作要更跟手
 * （否则就是迟滞）。60ms 让慢速的小幅调整也几乎立刻到位。
 */
export const GYRO_TILT_SLOW_TIME_CONSTANT_SECONDS = 0.06;

/** 快慢之间切换的中点（弧度／秒）：镜头偏移的速度超过它就算「快动作」。 */
export const GYRO_TILT_FAST_SPEED = 40 * DEGREE;

/**
 * 判断快慢用的速度是平均值，不是这一帧的瞬时值（秒）。
 *
 * 传感器 60Hz 时每帧只动一点点、系统还会把事件攒起来一阵一阵地丢过来，
 * 瞬时速度因此忽大忽小：按瞬时值判，同一个「慢慢歪」会被一半的帧判成快动作，
 * 于是画面时快时慢、跟不上。取 100ms 的滑动平均，判的是「这段动得多快」。
 */
const SPEED_SMOOTHING_SECONDS = 0.1;

/**
 * 单帧最多补这么多秒。
 *
 * 后台回来、掉帧之后 dt 可能是几百毫秒，按真实 dt 算会一帧就把偏移走完 ——
 * 那是一次瞬跳，观感就是一个「突」字。限住以后只是少走一点，下一帧接着走。
 */
export const GYRO_TILT_MAX_STEP_SECONDS = 0.1;

/** 输出小于这个量（弧度，约 0.01°）就归零：静止时画面完全不动，不会残留一丝抖。 */
const SETTLE_EPSILON = 2e-4;

const clamp = (value: number, limit: number) => Math.min(limit, Math.max(-limit, value));

/**
 * 一行读数（相对基准的设备倾角，度）→ 该到的镜头偏移（弧度）。
 *
 * 顺序是死的：**先判死区，再扣死区，再乘灵敏度，最后限幅**。
 *
 * - 死区按两个轴的合起来判门限，但**每个轴各自扣一次**。只做一维判断会出事：
 *   竖着拿手机时俯仰（beta）可用幅度小、左右（gamma）一动就是十几度，两个轴各自
 *   `|x| <= 死区 归零` 会让俯仰一直被吃掉（「上下不动、只左右晃」），某个轴在死区
 *   边缘被钉成 0 之后还会卡死。整体只扣一次的话，两轴同时动作时会多给一截
 *   （hypot(10,10) 走整体扣减得 11.4°，实际该是 10.8°），画面就跟手不同步。
 * - 限幅放在最后：它限的是**画面**能偏多少，不改读数本身，所以喂超大倾角与喂上限
 *   得到的是同一个目标（消费端再按屏幅夹一次也不会「漂」）。
 *
 * 这是纯函数：同一行读数永远得到同一个目标，时间不参与（时间在 stepGyroTilt 里）。
 */
export const gyroTiltTarget = (tilt: { beta: number; gamma: number }): GyroTiltOffsets => {
    const { beta, gamma } = tilt;
    // 非有限值（某些设备的 alpha/beta/gamma 会给 NaN）当没动。
    const betaDegrees = Number.isFinite(beta) ? beta : 0;
    const gammaDegrees = Number.isFinite(gamma) ? gamma : 0;
    if (Math.hypot(betaDegrees, gammaDegrees) <= GYRO_TILT_DEAD_ZONE_DEGREES) {
        return { azimuth: 0, elevation: 0 };
    }
    const alive = (degrees: number) => (
        Math.sign(degrees) * Math.max(0, Math.abs(degrees) - GYRO_TILT_DEAD_ZONE_DEGREES) * GYRO_TILT_SENSITIVITY
    );
    return {
        azimuth: clamp(alive(gammaDegrees) * DEGREE, GYRO_TILT_RANGE.azimuth),
        elevation: clamp(alive(betaDegrees) * DEGREE, GYRO_TILT_RANGE.elevation),
    };
};

/**
 * 把「还剩多远」换成这一帧的步长。
 *
 * 纯指数逼近（current + (target-current)×k）不会过冲：步长永远小于剩余距离，
 * 所以输出只会从一侧单调靠过去。k 按真实 dt 算，与帧率、与传感器事件的多少都无关。
 */
const approach = (current: number, target: number, timeConstant: number, step: number) => {
    const k = 1 - Math.exp(-step / timeConstant);
    return current + (target - current) * k;
};

/** 一阶低通的状态：当前偏移 + 上一帧的目标 + 速度的平滑值（用来判断快慢）。 */
export interface GyroTiltSmoother {
    value: GyroTiltOffsets;
    lastTarget: GyroTiltOffsets;
    /** 目标变化的平滑速度（弧度／秒，指数平均）。 */
    speed: number;
}

/** 起步时直接用目标值：刚挂上、刚换基准的那一刻不该有一段「从零滑过去」的动画。 */
export const createGyroTiltSmoother = (): GyroTiltSmoother => ({
    value: { azimuth: 0, elevation: 0 },
    lastTarget: { azimuth: 0, elevation: 0 },
    speed: 0,
});

/**
 * 推进一帧：把 state.value 往 `target` 推，返回新的值（也写回 state）。
 *
 * 两段：慢动作（target 变化得慢）用 SHORT 时间常数走得更干脆，快动作（甩手机）
 * 用 LONG 那个把噪声压住。两段都是指数逼近，输出不会越过 target。
 *
 * 速度是**平滑过**的，不是这一帧的瞬时值：传感器 60Hz 时每帧只动一点点、
 * 事件还可能一阵一阵地来，按瞬时值判断会让同一个动作在「跟手」和「迟滞」之间来回跳。
 */
export const stepGyroTilt = (state: GyroTiltSmoother, target: GyroTiltOffsets, dtSeconds: number): GyroTiltOffsets => {
    const step = Math.min(GYRO_TILT_MAX_STEP_SECONDS, Math.max(0, Number.isFinite(dtSeconds) ? dtSeconds : 0));
    const moved = Math.max(
        Math.abs(target.azimuth - state.lastTarget.azimuth),
        Math.abs(target.elevation - state.lastTarget.elevation),
    );
    const instantSpeed = moved / Math.max(step, 1e-3);
    state.speed = approach(state.speed, instantSpeed, SPEED_SMOOTHING_SECONDS, step);
    const timeConstant = state.speed < GYRO_TILT_FAST_SPEED
        ? GYRO_TILT_SLOW_TIME_CONSTANT_SECONDS
        : GYRO_TILT_TIME_CONSTANT_SECONDS;
    state.lastTarget = target;
    const next = {
        azimuth: approach(state.value.azimuth, target.azimuth, timeConstant, step),
        elevation: approach(state.value.elevation, target.elevation, timeConstant, step),
    };
    // 到位之后直接吸附到目标（并归零）：停在半路上会残留一丝肉眼看不见、但会让
    // 「镜头在动」的判断一直成立的值，画面就永远差一点点。
    const settle = (current: number, aim: number) => (Math.abs(aim - current) < SETTLE_EPSILON ? aim : current);
    state.value = {
        azimuth: settle(next.azimuth, target.azimuth) || 0,
        elevation: settle(next.elevation, target.elevation) || 0,
    };
    return state.value;
};

/** 把偏移缩放到别处用（场景把弧度换成它自己的屏幕角）。纯函数，不夹、不滤。 */
export const scaleGyroTilt = (offsets: GyroTiltOffsets, gain: number): GyroTiltOffsets => ({
    azimuth: offsets.azimuth * gain,
    elevation: offsets.elevation * gain,
});
