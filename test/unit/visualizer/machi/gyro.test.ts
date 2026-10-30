import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    MACHI_GYRO_RANGE,
    machiGyroSupported,
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
        expect(seen[0]!.azimuth).toBeCloseTo(6 * DEGREE, 6);
        expect(seen[0]!.elevation).toBeCloseTo(6 * DEGREE, 6);
        stop();
        expect(target.listenerCount('deviceorientation')).toBe(0);
    });

    it('clamps a big tilt to the range so the shot never swings away', () => {
        const target = fakeWindow();
        const seen: { azimuth: number; elevation: number }[] = [];
        subscribeMachiGyro(offsets => seen.push(offsets));
        target.dispatch('deviceorientation', { beta: 0, gamma: 0 });
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
        expect(seen[1]!.azimuth).toBeCloseTo(-2 * DEGREE, 6);
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
});
