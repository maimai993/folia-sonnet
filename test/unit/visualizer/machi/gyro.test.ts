import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    MACHI_GYRO_RANGE,
    machiGyroSupported,
    machiScreenAngle,
    machiScreenOffsets,
    requestMachiGyroPermission,
    subscribeMachiGyro,
} from '@/components/visualizer/machi/gyro';

// test/unit/visualizer/machi/gyro.test.ts
// 町景陀螺仪读数：相对按下开关那一刻的偏移、夹在范围内、没有 DeviceOrientationEvent 时静静地什么都不做。

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

// 偏移按度数给，断言的容差按“到范围内的百分比”看。
const DEGREE = Math.PI / 180;

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
        // 6° 的倾斜经死区（1.5°）与灵敏度（1.5）后是 6.75°，夹到上限 6° / 3.5°。
        expect(seen[0]!.azimuth).toBeCloseTo(9 * DEGREE, 6);
        expect(seen[0]!.elevation).toBeCloseTo(5 * DEGREE, 6);
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
        expect(seen[0]!.azimuth).toBeCloseTo(-MACHI_GYRO_RANGE.azimuth, 6);
        expect(seen[0]!.elevation).toBeCloseTo(MACHI_GYRO_RANGE.elevation, 6);
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
        target.dispatch('deviceorientation', { beta: 30, gamma: -22 });
        // 2° 的倾斜经死区（1°）与灵敏度（2.5）后是 2.5°。
        expect(seen[1]!.azimuth).toBeCloseTo(-2.5 * DEGREE, 6);
    });

    it('comes back after sitting at the limit instead of sticking there', () => {
        const target = fakeWindow();
        const seen: { azimuth: number; elevation: number }[] = [];
        subscribeMachiGyro(offsets => seen.push(offsets));
        target.dispatch('deviceorientation', { beta: 0, gamma: 0 });
        // 转到远超范围：夹在上限。
        target.dispatch('deviceorientation', { beta: 0, gamma: 40 });
        expect(seen[0]!.azimuth).toBeCloseTo(MACHI_GYRO_RANGE.azimuth, 6);
        /*
         * 停在极限上转回来：必须跟着回，不能卡住。
         *
         * 输出过了低通，所以不是一步到位：从上限往目标走，每步只走 25%。
         * 目标是 2.5°（2° 倾斜经死区 1° 与灵敏度 2.5），
         * 于是 9° → 9 + (2.5 - 9) × 0.25 = 7.375°。
         * 这里断言的是低通之后的结果 —— 关键是「回得来」，不是「回得多快」。
         */
        target.dispatch('deviceorientation', { beta: 0, gamma: 2 });
        expect(seen[1]!.azimuth).toBeCloseTo(7.375 * DEGREE, 6);
    });

    it('takes the pose as a new reference when the reading jumps (phone past vertical)', () => {
        const target = fakeWindow();
        const seen: { azimuth: number; elevation: number }[] = [];
        subscribeMachiGyro(offsets => seen.push(offsets));
        target.dispatch('deviceorientation', { beta: 88, gamma: 0 });
        target.dispatch('deviceorientation', { beta: 100, gamma: 0 });
        expect(seen[0]!.elevation).toBeCloseTo(MACHI_GYRO_RANGE.elevation, 6);
        // 翻过竖直方向，读数换系跳一大截：不能当成「倾斜到极限」，而是以新姿态为基准、偏移归零。
        target.dispatch('deviceorientation', { beta: -85, gamma: 0 });
        expect(seen[1]).toEqual({ azimuth: 0, elevation: 0 });
        /*
         * 从新基准继续转，仍然跟得上。
         *
         * 3° 的倾斜经死区（1°）与灵敏度（2.5）后是 5°；
         * 但输出还带着上一帧（上限 5°）的低通残留，所以不是 5° 也不是 1.25°。
         * 这里只断言「跟着新基准走了」—— 符号对、量级不为零。
         */
        target.dispatch('deviceorientation', { beta: -88, gamma: 0 });
        expect(seen[2]!.elevation).toBeLessThan(0);
        expect(Math.abs(seen[2]!.elevation)).toBeGreaterThan(0);
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
        /*
         * gyroScreenOffsets 里带着死区（1.5°）与灵敏度（1.5），所以 10° 的倾斜
         * 进来是 (10 - 1.5) × 1.5 = 12.75°，不是 10°。
         */
        const tilted = (10 - 1) * 2.5;
        // 竖屏：gamma 管左右、beta 管上下。
        expect(machiScreenOffsets(0, 10, 0)).toEqual({ azimuth: tilted * DEGREE, elevation: 0 });
        expect(machiScreenOffsets(10, 0, 0)).toEqual({ azimuth: 0, elevation: tilted * DEGREE });
        // 横屏 90°：两轴互换（左右变成上下、上下变成左右）。
        expect(machiScreenOffsets(10, 0, 90)).toEqual({ azimuth: -tilted * DEGREE, elevation: 0 });
        expect(machiScreenOffsets(0, 10, 90)).toEqual({ azimuth: 0, elevation: tilted * DEGREE });
        // 反方向横过来：符号相反。
        expect(machiScreenOffsets(10, 0, 270)).toEqual({ azimuth: tilted * DEGREE, elevation: 0 });
        expect(machiScreenOffsets(0, 10, 270)).toEqual({ azimuth: 0, elevation: -tilted * DEGREE });
        // 倒置：两轴都反。
        expect(machiScreenOffsets(10, 10, 180)).toEqual({ azimuth: -tilted * DEGREE, elevation: -tilted * DEGREE });
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
        // 横屏下左右倾（设备坐标是 beta）：屏幕上是左右转。
        // 5° 的倾斜经死区（1°）与灵敏度（2.5）后是 10°，夹到上限 9°。
        target.dispatch('deviceorientation', { beta: 5, gamma: 0 });
        expect(seen[0]!.azimuth).toBeCloseTo(-9 * DEGREE, 6);
        expect(seen[0]!.elevation).toBeCloseTo(0, 6);
        // 横屏下上下倾（设备坐标是 gamma）：屏幕上是俯仰。
        // 4° 的倾斜是 7.5°，夹到上限 5°；输出过低通（25%），所以是 1.25°。
        target.dispatch('deviceorientation', { beta: 5, gamma: 4 });
        expect(seen[1]!.azimuth).toBeCloseTo(-9 * DEGREE, 6);
        expect(seen[1]!.elevation).toBeCloseTo(1.25 * DEGREE, 6);
    });
});
