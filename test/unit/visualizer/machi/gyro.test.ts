import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    MACHI_GYRO_RANGE,
    machiGyroSupported,
    machiScreenAngle,
    requestMachiGyroPermission,
    subscribeMachiGyro,
} from '@/components/visualizer/machi/gyro';
// 期望值按实现自己的死区与灵敏度算，改常量时这里不必跟着挪数字。
import { GYRO_TILT_DEAD_ZONE_DEGREES, GYRO_TILT_SENSITIVITY } from '@/components/visualizer/backgrounds/gyroTilt';
import { gyroScreenTilt } from '@/components/visualizer/backgrounds/gyroTilt';

// test/unit/visualizer/machi/gyro.test.ts
// 町景陀螺仪读数：相对按下开关那一刻的偏移、夹在范围内、没有 DeviceOrientationEvent 时静静地什么都不做。
// 平滑是按时间做的一阶低通（gyroTiltModel），node 环境没有 rAF，所以每条读数只推进 1/60 秒 ——
// 想看到「走到底」就得连着喂几条读数，这也正是真机上发生的事。

const DEGREE = Math.PI / 180;

/** 造一个假 window，装上 DeviceOrientationEvent 与事件收发。 */
const fakeWindow = (permission?: () => Promise<string>) => {
    const listeners = new Map<string, ((event: unknown) => void)[]>();
    const target = {
        DeviceOrientationEvent: Object.assign(class {}, permission ? { requestPermission: permission } : {}),
        addEventListener: (type: string, listener: (event: unknown) => void) => {
            listeners.set(type, [...(listeners.get(type) ?? []), listener]);
        },
        removeEventListener: (type: string, listener: (event: unknown) => void) => {
            listeners.set(type, (listeners.get(type) ?? []).filter(entry => entry !== listener));
        },
        dispatch: (type: string, event: unknown) => {
            for (const listener of listeners.get(type) ?? []) listener(event);
        },
        listenerCount: (type: string) => (listeners.get(type) ?? []).length,
    };
    vi.stubGlobal('window', target);
    return target;
};

/** 同一条姿态连喂 frames 次：每喂一次推进一帧，低通因此有足够时间收敛到目标。 */
const hold = (target: ReturnType<typeof fakeWindow>, pose: { beta: number; gamma: number }, frames: number) => {
    for (let frame = 0; frame < frames; frame += 1) target.dispatch('deviceorientation', pose);
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('machi gyro', () => {
    it('is off when the platform has no DeviceOrientationEvent', () => {
        vi.stubGlobal('window', {});
        expect(machiGyroSupported()).toBe(false);
        // 没有读数就退订函数是空的，权限也算“不给”。
        expect(typeof subscribeMachiGyro(() => {})).toBe('function');
        return expect(requestMachiGyroPermission()).resolves.toBe(false);
    });

    it('measures the tilt relative to the reading it started on', () => {
        const target = fakeWindow();
        const seen: { azimuth: number; elevation: number }[] = [];
        const stop = subscribeMachiGyro(offsets => seen.push(offsets));
        // 第一条读数只当基准，不报偏移。
        target.dispatch('deviceorientation', { beta: 40, gamma: -10 });
        expect(seen).toEqual([]);
        target.dispatch('deviceorientation', { beta: 46, gamma: -4 });
        expect(seen).toHaveLength(1);
        /*
         * beta 与 gamma 一起动了 6°，方向都是「变大」，所以两个轴都该是正的。
         *
         * 不钉死具体幅度：读数先过死区、再乘灵敏度，然后按时间平滑 ——
         * 第一条只走一帧的量。这里要确认的是「动起来了、方向对、没有串成一边倒」。
         */
        expect(seen[0]!.azimuth).toBeGreaterThan(0);
        expect(seen[0]!.elevation).toBeGreaterThan(0);
        stop();
        expect(target.listenerCount('deviceorientation')).toBe(0);
    });

    it('clamps a big tilt to the range so the shot never swings away', () => {
        const target = fakeWindow();
        const seen: { azimuth: number; elevation: number }[] = [];
        subscribeMachiGyro(offsets => seen.push(offsets));
        target.dispatch('deviceorientation', { beta: 0, gamma: 0 });
        // 分两步转，每步都在可信幅度里（一步跳太多会被当成换系，重新取基准）。
        target.dispatch('deviceorientation', { beta: 50, gamma: -50 });
        target.dispatch('deviceorientation', { beta: 89, gamma: -89 });
        // 连喂一串：输出走到上限就停住，不许越过。
        const start = seen.length;
        hold(target, { beta: 89, gamma: -89 }, 120);
        const settled = seen[seen.length - 1]!;
        expect(settled.azimuth).toBeCloseTo(-MACHI_GYRO_RANGE.azimuth, 6);
        expect(settled.elevation).toBeCloseTo(MACHI_GYRO_RANGE.elevation, 6);
        // 中途每一帧都不越过上限（含符号）。
        for (const offsets of seen.slice(start)) {
            expect(Math.abs(offsets.azimuth)).toBeLessThanOrEqual(MACHI_GYRO_RANGE.azimuth + 1e-9);
            expect(Math.abs(offsets.elevation)).toBeLessThanOrEqual(MACHI_GYRO_RANGE.elevation + 1e-9);
        }
    });

    it('skips readings the device sends without motion data', () => {
        const target = fakeWindow();
        const seen: { azimuth: number }[] = [];
        subscribeMachiGyro(offsets => seen.push(offsets));
        target.dispatch('deviceorientation', { beta: null, gamma: null });
        target.dispatch('deviceorientation', { beta: 10, gamma: 5 });
        // 上面那条 null 读数不能当基准，所以这一条才是基准，仍然不报。
        expect(seen).toEqual([]);
        target.dispatch('deviceorientation', { beta: 12, gamma: 7 });
        expect(seen).toHaveLength(1);
    });

    it('takes a new reference after the screen turns', () => {
        const target = fakeWindow();
        const seen: { azimuth: number }[] = [];
        subscribeMachiGyro(offsets => seen.push(offsets));
        target.dispatch('deviceorientation', { beta: 0, gamma: 0 });
        target.dispatch('deviceorientation', { beta: 0, gamma: 5 });
        expect(seen).toHaveLength(1);
        target.dispatch('orientationchange', {});
        // 转屏后第一条读数重新当基准，画面不会跳。
        target.dispatch('deviceorientation', { beta: 30, gamma: -20 });
        expect(seen).toHaveLength(1);
        hold(target, { beta: 30, gamma: -25 }, 120);
        /*
         * 从新基准算的倾角是一个可观的偏移，连喂到收敛之后停在那儿（不漂）。
         *
         * 不钉具体数值：手机竖着拿时，欧拉角里「左右歪」与「上下歪」是耦合的，
         * gamma 变 5° 在四元数里读出来不是刚好 5°；这里要的是「新基准生效、读数跟得上」。
         */
        const settled = seen[seen.length - 1]!.azimuth;
        expect(Math.abs(settled)).toBeGreaterThan(3 * DEGREE);
        expect(Math.abs(settled)).toBeLessThanOrEqual(MACHI_GYRO_RANGE.azimuth + 1e-9);
    });

    it('comes back after sitting at the limit instead of sticking there', () => {
        const target = fakeWindow();
        const seen: { azimuth: number; elevation: number }[] = [];
        subscribeMachiGyro(offsets => seen.push(offsets));
        target.dispatch('deviceorientation', { beta: 0, gamma: 0 });
        // 转到远超范围：连喂到上限。
        target.dispatch('deviceorientation', { beta: 0, gamma: 40 });
        hold(target, { beta: 0, gamma: 40 }, 120);
        expect(seen[seen.length - 1]!.azimuth).toBeCloseTo(MACHI_GYRO_RANGE.azimuth, 6);
        /*
         * 停在极限上转回来：必须马上跟着回，不能卡住。现在读数本身留住了真实倾角，
         * 回到 4° 时目标就不是上限了，第一帧就该往回走。
         */
        target.dispatch('deviceorientation', { beta: 0, gamma: 4 });
        const back = seen[seen.length - 1]!.azimuth;
        expect(back).toBeLessThan(MACHI_GYRO_RANGE.azimuth);
        expect(back).toBeGreaterThan(0);
    });

    it('takes the pose as a new reference when the reading jumps (phone past vertical)', () => {
        const target = fakeWindow();
        const seen: { azimuth: number; elevation: number }[] = [];
        subscribeMachiGyro(offsets => seen.push(offsets));
        target.dispatch('deviceorientation', { beta: 88, gamma: 0 });
        /*
         * 一点点转到上限：一次跳 12° 以上会被当成换系、重取基准（见 MAX_TRUSTED_JUMP），
         * 所以真实的倾斜是几十条读数一条一条累积出来的，这里也照那样喂（每步 1°）。
         * 上限在倾角 21° 左右，所以一路喂到 beta 115。
         */
        for (let beta = 89; beta <= 115; beta += 1) hold(target, { beta, gamma: 0 }, 8);
        hold(target, { beta: 115, gamma: 0 }, 60);
        expect(seen[seen.length - 1]!.elevation).toBeCloseTo(MACHI_GYRO_RANGE.elevation, 6);
        // 翻过竖直方向，读数换系跳一大截：不能当成「倾斜到极限」，而是以新姿态为基准、偏移归零。
        target.dispatch('deviceorientation', { beta: -85, gamma: 0 });
        expect(seen[seen.length - 1]).toEqual({ azimuth: 0, elevation: 0 });
        /*
         * 从新基准继续转，仍然跟得上。
         *
         * 平滑要把输出从 0 拉到自己那一侧，所以第一帧只是「小了一点」，不是一步到位。
         * 这里断言方向与不为零。
         */
        target.dispatch('deviceorientation', { beta: -88, gamma: 0 });
        expect(seen[seen.length - 1]!.elevation).toBeLessThan(0);
        expect(Math.abs(seen[seen.length - 1]!.elevation)).toBeGreaterThan(0);
    });

    it('asks iOS for permission and reports what the user said', async () => {
        fakeWindow(async () => 'granted');
        await expect(requestMachiGyroPermission()).resolves.toBe(true);
        fakeWindow(async () => 'denied');
        await expect(requestMachiGyroPermission()).resolves.toBe(false);
        fakeWindow(async () => {
            throw new Error('no gesture');
        });
        await expect(requestMachiGyroPermission()).resolves.toBe(false);
    });

    it('treats platforms without requestPermission as already allowed', async () => {
        fakeWindow();
        await expect(requestMachiGyroPermission()).resolves.toBe(true);
    });

    it('maps device axes onto screen axes for every screen angle', () => {
        // 竖屏：gamma 管左右、beta 管上下（换坐标系这一步不改数值）。
        expect(gyroScreenTilt(0, 10, 0)).toEqual({ beta: 0, gamma: 10 });
        expect(gyroScreenTilt(10, 0, 0)).toEqual({ beta: 10, gamma: 0 });
        // 横屏 90°：两轴互换（左右变成上下、上下变成左右）。
        expect(gyroScreenTilt(10, 0, 90)).toEqual({ beta: 0, gamma: -10 });
        expect(gyroScreenTilt(0, 10, 90)).toEqual({ beta: 10, gamma: 0 });
        // 反方向横过来：符号相反。
        expect(gyroScreenTilt(10, 0, 270).gamma).toBeCloseTo(10, 6);
        expect(gyroScreenTilt(10, 0, 270).beta).toBeCloseTo(0, 6);
        // 倒置：两轴都反。
        expect(gyroScreenTilt(10, 10, 180).gamma).toBeCloseTo(-10, 6);
        expect(gyroScreenTilt(10, 10, 180).beta).toBeCloseTo(-10, 6);
    });

    it('reads the screen angle, falling back to window.orientation and portrait', () => {
        const target = fakeWindow();
        expect(machiScreenAngle()).toBe(0);
        (target as unknown as { screen: unknown }).screen = { orientation: { angle: 90 } };
        expect(machiScreenAngle()).toBe(90);
        (target as unknown as { screen: unknown }).screen = { orientation: { angle: 275 } };
        expect(machiScreenAngle()).toBe(270);
        (target as unknown as { screen: unknown }).screen = undefined;
        (target as unknown as { orientation: number }).orientation = -90;
        expect(machiScreenAngle()).toBe(270);
    });

    it('turns a landscape tilt into the same on-screen direction', () => {
        const target = fakeWindow();
        (target as unknown as { screen: unknown }).screen = { orientation: { angle: 90 } };
        const seen: { azimuth: number; elevation: number }[] = [];
        subscribeMachiGyro(offsets => seen.push(offsets));
        target.dispatch('deviceorientation', { beta: 0, gamma: 0 });
        /*
         * 横屏下左右倾（设备坐标是 beta）：屏幕上是左右转，方向为负。
         * 连喂到收敛，断言方向与幅度 —— 读数保留真实倾角，5° 经死区与灵敏度后大约是
         * (5 - 死区) × 灵敏度，远不到上限。
         */
        target.dispatch('deviceorientation', { beta: 5, gamma: 0 });
        hold(target, { beta: 5, gamma: 0 }, 120);
        const settled = seen[seen.length - 1]!;
        expect(settled.azimuth).toBeLessThan(0);
        expect(settled.azimuth).toBeCloseTo(-((5 - GYRO_TILT_DEAD_ZONE_DEGREES) * GYRO_TILT_SENSITIVITY) * DEGREE, 3);
        expect(settled.elevation).toBeCloseTo(0, 6);
    });
});
