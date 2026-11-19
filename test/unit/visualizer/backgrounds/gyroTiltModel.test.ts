import { describe, expect, it } from 'vitest';
import {
    GYRO_TILT_DEAD_ZONE_DEGREES,
    GYRO_TILT_RANGE,
    GYRO_TILT_SENSITIVITY,
    GYRO_TILT_SLOW_TIME_CONSTANT_SECONDS,
    GYRO_TILT_TIME_CONSTANT_SECONDS,
    createGyroTiltSmoother,
    gyroTiltTarget,
    stepGyroTilt,
} from '@/components/visualizer/backgrounds/gyroTiltModel';
import { gyroPoseDelta, gyroScreenTilt } from '@/components/visualizer/backgrounds/gyroTilt';

// test/unit/visualizer/backgrounds/gyroTiltModel.test.ts
// 「传感器读数 → 相机角度」这条纯函数链路的行为：死区内不动、阶跃不过冲、输出单调收敛、
// 到了上限再往回歪会立刻跟着回。参数取值本身不在这里钉死，断言都按常量算。

const DEGREE = Math.PI / 180;
const FRAME = 1 / 60;

/** 从静止开始喂一个固定的目标，逐帧推进到 seconds 秒，返回每一帧的输出。 */
const runFor = (target: { azimuth: number; elevation: number }, seconds: number) => {
    const state = createGyroTiltSmoother();
    const path: number[] = [];
    for (let frame = 0; frame < Math.round(seconds / FRAME); frame += 1) {
        path.push(stepGyroTilt(state, target, FRAME).azimuth);
    }
    return { path, state };
};

describe('gyroTiltTarget', () => {
    it('keeps the camera still while the tilt stays inside the dead zone', () => {
        // 四个方向、斜着、以及正好压在门限上的小幅抖动：镜头一点都不许动。
        const inside = GYRO_TILT_DEAD_ZONE_DEGREES * 0.5;
        for (const tilt of [
            { beta: 0, gamma: 0 },
            { beta: inside, gamma: 0 },
            { beta: 0, gamma: -inside },
            { beta: inside * 0.6, gamma: inside * 0.6 },
            { beta: GYRO_TILT_DEAD_ZONE_DEGREES * 0.99, gamma: 0 },
        ]) {
            expect(gyroTiltTarget(tilt)).toEqual({ azimuth: 0, elevation: 0 });
        }
    });

    it('subtracts the dead zone from each axis and scales by the sensitivity', () => {
        const tilt = 10;
        const expected = (tilt - GYRO_TILT_DEAD_ZONE_DEGREES) * GYRO_TILT_SENSITIVITY * DEGREE;
        expect(gyroTiltTarget({ beta: tilt, gamma: 0 }).elevation).toBeCloseTo(expected, 9);
        expect(gyroTiltTarget({ beta: 0, gamma: tilt }).azimuth).toBeCloseTo(expected, 9);
        // 反方向对称。
        expect(gyroTiltTarget({ beta: -tilt, gamma: 0 }).elevation).toBeCloseTo(-expected, 9);
        expect(gyroTiltTarget({ beta: 0, gamma: -tilt }).azimuth).toBeCloseTo(-expected, 9);
    });

    it('treats a reading without usable numbers as no tilt', () => {
        expect(gyroTiltTarget({ beta: Number.NaN, gamma: 0 })).toEqual({ azimuth: 0, elevation: 0 });
        expect(gyroTiltTarget({ beta: 0, gamma: Number.POSITIVE_INFINITY })).toEqual({ azimuth: 0, elevation: 0 });
    });

    it('stops at the limit and gives the same target for a bigger tilt', () => {
        const atLimit = gyroTiltTarget({ beta: 0, gamma: 90 });
        expect(atLimit.azimuth).toBeCloseTo(GYRO_TILT_RANGE.azimuth, 9);
        // 再歪下去目标不再变大：画面停在上限，不会漂。
        expect(gyroTiltTarget({ beta: 0, gamma: 140 }).azimuth).toBeCloseTo(GYRO_TILT_RANGE.azimuth, 9);
        // 俯仰是同一套。
        expect(gyroTiltTarget({ beta: -90, gamma: 0 }).elevation).toBeCloseTo(-GYRO_TILT_RANGE.elevation, 9);
    });
});

describe('stepGyroTilt', () => {
    it('approaches a step input from one side without overshooting', () => {
        const target = gyroTiltTarget({ beta: 0, gamma: 18 });
        const { path } = runFor(target, 2);
        // 决不许越过目标（过冲的直接判据）。
        for (const value of path) expect(value).toBeLessThanOrEqual(target.azimuth + 1e-12);
        // 也不许反向。
        for (const value of path) expect(value).toBeGreaterThanOrEqual(0);
        // 两秒之后已经停稳。
        expect(path[path.length - 1]!).toBeCloseTo(target.azimuth, 9);
    });

    it('rises monotonically to the target', () => {
        const target = gyroTiltTarget({ beta: 0, gamma: 18 });
        const { path } = runFor(target, 2);
        for (let index = 1; index < path.length; index += 1) {
            // 严格不减（等于发生在已经吸附到目标之后）。
            expect(path[index]!).toBeGreaterThanOrEqual(path[index - 1]! - 1e-12);
        }
    });

    it('reaches 90% of a step within about 220ms and settles within about 500ms', () => {
        /*
         * 这组是「跟手」的量化判据：旧实现是一条约 450ms 的曲线，90% 要 1 秒左右，
         * 倾斜手机时画面才慢半拍。现在时间常数只有几十毫秒，90% 在 0.2 秒上下。
         */
        const target = gyroTiltTarget({ beta: 0, gamma: 18 });
        const { path } = runFor(target, 1);
        const reach90 = path.findIndex(value => value >= target.azimuth * 0.9) * FRAME;
        const reach99 = path.findIndex(value => value >= target.azimuth * 0.99) * FRAME;
        expect(reach90).toBeLessThan(0.25);
        expect(reach99).toBeLessThan(0.6);
        // 也不能「一帧到位」—— 那是瞬跳，噪声会原样进画面。
        expect(path[0]!).toBeLessThan(target.azimuth * 0.9);
    });

    it('notices a slow drift promptly (the short time constant)', () => {
        const state = createGyroTiltSmoother();
        // 每帧只动 0.05°：这是「慢慢歪」的情形，应当几乎紧跟，而不是被长时间常数拖住。
        let target = { azimuth: 0, elevation: 0 };
        const drift = gyroTiltTarget({ beta: 0, gamma: 12 }) .azimuth / 60;
        for (let frame = 0; frame < 60; frame += 1) {
            target = { azimuth: target.azimuth + drift, elevation: 0 };
            stepGyroTilt(state, target, FRAME);
        }
        // 60 帧之后应当追到绝大部分（这条曲线的时间常数是慢动作那一个）。
        expect(state.value.azimuth).toBeGreaterThan(target.azimuth * 0.85);
        expect(GYRO_TILT_SLOW_TIME_CONSTANT_SECONDS).toBeLessThan(GYRO_TILT_TIME_CONSTANT_SECONDS);
    });

    it('never overshoots a large step either (the fast time constant)', () => {
        // 一步甩到很大的角度：快动作走的是长一点的那个时间常数，同样不许过冲。
        const target = { azimuth: GYRO_TILT_RANGE.azimuth, elevation: GYRO_TILT_RANGE.elevation };
        const state = createGyroTiltSmoother();
        for (let frame = 0; frame < 120; frame += 1) {
            const value = stepGyroTilt(state, target, FRAME);
            expect(value.azimuth).toBeLessThanOrEqual(target.azimuth + 1e-12);
            expect(value.elevation).toBeLessThanOrEqual(target.elevation + 1e-12);
        }
        expect(state.value.azimuth).toBeCloseTo(target.azimuth, 9);
    });

    it('comes back at once from the limit when the phone turns back', () => {
        // 先贴到上限，再喂一个明显更小的目标：必须立刻往回走，而且不过冲。
        const state = createGyroTiltSmoother();
        const atLimit = gyroTiltTarget({ beta: 0, gamma: 90 });
        for (let frame = 0; frame < 60; frame += 1) stepGyroTilt(state, atLimit, FRAME);
        expect(state.value.azimuth).toBeCloseTo(GYRO_TILT_RANGE.azimuth, 9);
        const back = gyroTiltTarget({ beta: 0, gamma: 4 });
        const next = stepGyroTilt(state, back, FRAME);
        expect(next.azimuth).toBeLessThan(GYRO_TILT_RANGE.azimuth);
        for (let frame = 0; frame < 60; frame += 1) {
            const value = stepGyroTilt(state, back, FRAME);
            expect(value.azimuth).toBeGreaterThanOrEqual(back.azimuth - 1e-12);
        }
        expect(state.value.azimuth).toBeCloseTo(back.azimuth, 9);
    });

    it('is frame-rate independent: the same tilt lands in the same place', () => {
        const target = gyroTiltTarget({ beta: 0, gamma: 18 });
        const run = (step: number, seconds: number) => {
            const state = createGyroTiltSmoother();
            for (let elapsed = 0; elapsed < seconds; elapsed += step) stepGyroTilt(state, target, step);
            return state.value.azimuth;
        };
        /*
         * 30Hz 与 120Hz 在同一时刻应当基本一致。容差按目标的百分之一给：
         * 位移小于死区的取样点会吸附到目标（SETTLE_EPSILON），两边的取样点不同，
         * 差的就是最后那一丝。
         */
        const at30 = run(1 / 30, 0.2);
        const at120 = run(1 / 120, 0.2);
        expect(Math.abs(at30 - at120)).toBeLessThan(target.azimuth * 0.03);
        // 两边都必须把这一小段基本走完，而不是一边走完一边没动。
        expect(Math.min(at30, at120)).toBeGreaterThan(target.azimuth * 0.9);
    });

    it('treats a long frame gap as a big dt, not as several seconds of catch-up', () => {
        // 后台回来：dt 给 5 秒，单帧最多补 GYRO_TILT_MAX_STEP_SECONDS，不许一帧走完。
        const target = gyroTiltTarget({ beta: 0, gamma: 60 });
        const state = createGyroTiltSmoother();
        const afterGap = stepGyroTilt(state, target, 5);
        expect(afterGap.azimuth).toBeLessThan(target.azimuth);
        // 而一帧正常的推进就会走掉大半。
        expect(afterGap.azimuth).toBeGreaterThan(target.azimuth * 0.5);
    });

    it('sits perfectly still when the tilt goes back inside the dead zone', () => {
        const state = createGyroTiltSmoother();
        const target = gyroTiltTarget({ beta: 0, gamma: 18 });
        for (let frame = 0; frame < 60; frame += 1) stepGyroTilt(state, target, FRAME);
        // 手停下、回中：目标归零，输出回零之后不再有任何残余（不会一直「微微在动」）。
        const zero = gyroTiltTarget({ beta: 0, gamma: 0 });
        expect(zero).toEqual({ azimuth: 0, elevation: 0 });
        for (let frame = 0; frame < 60; frame += 1) stepGyroTilt(state, zero, FRAME);
        expect(state.value).toEqual({ azimuth: 0, elevation: 0 });
    });
});

describe('gyroScreenTilt', () => {
    it('maps device axes onto screen axes for every screen angle', () => {
        // 竖屏：gamma 管左右、beta 管上下。
        expect(gyroScreenTilt(10, 0, 0)).toEqual({ beta: 10, gamma: 0 });
        expect(gyroScreenTilt(0, 10, 0)).toEqual({ beta: 0, gamma: 10 });
        // 横屏 90°：两轴互换 —— 屏幕上往右是 -beta，往上仍是 +gamma。
        expect(gyroScreenTilt(10, 0, 90)).toEqual({ beta: 0, gamma: -10 });
        expect(gyroScreenTilt(0, 10, 90)).toEqual({ beta: 10, gamma: 0 });
        // 倒置：两轴都反（左右用 -gamma，上下用 -beta）。
        expect(gyroScreenTilt(10, 10, 180).gamma).toBeCloseTo(-10, 9);
        expect(gyroScreenTilt(10, 10, 180).beta).toBeCloseTo(-10, 9);
        expect(gyroScreenTilt(10, 10, 270).gamma).toBeCloseTo(10, 9);
        expect(gyroScreenTilt(10, 10, 270).beta).toBeCloseTo(-10, 9);
    });

    it('keeps the screen axes clean at right-angle rotations', () => {
        // cos(90°) 是 6e-17 的浮点残渣，不该留下「假偏移」。
        expect(gyroScreenTilt(10, 0, 90).beta).toBe(0);
        expect(gyroScreenTilt(0, 10, 90).gamma).toBe(0);
        expect(gyroScreenTilt(10, 0, 180).gamma).toBe(0);
    });
});

describe('pose delta', () => {
    /*
     * 这些用例钉的是 issue #429 里最实际的一条：**手机竖着拿**（beta 接近 90°，
     * 屏幕朝自己）时左右歪一下，画面必须同等幅度地响应。
     *
     * 旧实现先把相对旋转搬回「按下开关时」的手机坐标系再取角，竖着拿时设备 y 轴
     * 与世界竖轴重合，左右歪的分量被投影到横轴上，读出来是 0 —— 举着手机往旁边歪，
     * 画面纹丝不动。这里按「歪多少度就读到多少度」断言，姿态换成多少都不许衰减。
     */
    it('reads a sideways tilt one for one at any holding angle', () => {
        for (const beta of [0, 40, 70, 75, 90]) {
            const delta = gyroPoseDelta({ alpha: 0, beta, gamma: 0 }, { alpha: 0, beta, gamma: 10 }, 0);
            expect(delta.gamma).toBeCloseTo(10, 1);
            expect(Math.abs(delta.beta)).toBeLessThan(0.5);
            // 反方向对称。
            const left = gyroPoseDelta({ alpha: 0, beta, gamma: 0 }, { alpha: 0, beta, gamma: -10 }, 0);
            expect(left.gamma).toBeCloseTo(-10, 1);
        }
    });

    it('reads an upright pitch one for one, including past vertical', () => {
        // beta 从 85° 走到 95° 会翻过竖直：仍然是 10° 的俯仰，不是一百多度也不是 0。
        const delta = gyroPoseDelta({ alpha: 0, beta: 85, gamma: 0 }, { alpha: 0, beta: 95, gamma: 0 }, 0);
        expect(delta.beta).toBeCloseTo(10, 1);
        expect(Math.abs(delta.gamma)).toBeLessThan(0.5);
    });

    it('keeps the screen away from a turn in place (alpha only)', () => {
        /*
         * 用户原地转身、或把手机绕竖直轴转到另一个方向：不应该被当成「往旁边歪」。
         * 早先这一条会让画面自己甩一下。
         */
        const delta = gyroPoseDelta({ alpha: 0, beta: 40, gamma: 0 }, { alpha: 90, beta: 40, gamma: 0 }, 0);
        expect(Math.abs(delta.gamma)).toBeLessThan(1);
        expect(Math.abs(delta.beta)).toBeLessThan(1);
    });
});
