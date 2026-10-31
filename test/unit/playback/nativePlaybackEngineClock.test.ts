import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativePlaybackEvent } from '@/services/playbackEngine/nativePlayerPlugin';

// test/unit/playback/nativePlaybackEngineClock.test.ts
//
// 原生播放的 Web 侧时钟。原生只在状态边界报位置（不再每 250ms 推一拍），
// 所以这里守的是：
//   · 没有位置事件时，墙钟必须自己往前走（不能被「最多领先多少」卡死）；
//   · 缓冲冻结、播放恢复、暂停、seek、单曲循环各自把基准放到正确的位置；
//   · 允许回退的只有显式 seek / 循环跳变。

const harness = vi.hoisted(() => {
    const listeners = new Set<(event: NativePlaybackEvent) => void>();
    const nativePlayer = {
        prepare: vi.fn(async () => ({ ok: true })),
        play: vi.fn(async () => undefined),
        pause: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        seek: vi.fn(async () => undefined),
        setVolume: vi.fn(async () => undefined),
        setSpeed: vi.fn(async () => undefined),
        getSnapshot: vi.fn(async () => ({ positionMs: 0, durationMs: 0, playing: false })),
        release: vi.fn(async () => undefined),
        addListener: vi.fn((listener: (event: NativePlaybackEvent) => void) => {
            listeners.add(listener);
            return Promise.resolve(() => listeners.delete(listener));
        }),
    };
    return { listeners, nativePlayer };
});

vi.mock('@/services/playbackEngine/nativePlayerPlugin', () => ({
    nativePlayer: harness.nativePlayer,
    isNativePlayerAvailable: () => true,
}));

const { nativePlaybackEngine } = await import('@/services/playbackEngine/nativePlaybackEngine');

const emit = (event: NativePlaybackEvent): void => {
    harness.listeners.forEach(listener => listener(event));
};

let nowMs = 0;
let clock: ReturnType<typeof vi.spyOn>;

describe('nativePlaybackEngine clock', () => {
    beforeEach(async () => {
        nowMs = 0;
        clock = vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
        await nativePlaybackEngine.setSource('https://example.com/song.mp3');
        await nativePlaybackEngine.play();
    });

    afterEach(async () => {
        await nativePlaybackEngine.stop();
        clock.mockRestore();
    });

    it('keeps advancing on the wall clock when no position event arrives', () => {
        emit({ type: 'playing', positionMs: 1000, durationMs: 200_000 });

        nowMs = 10_000;
        expect(nativePlaybackEngine.getPositionSec()).toBeCloseTo(11, 5);

        nowMs = 60_000;
        expect(nativePlaybackEngine.getPositionSec()).toBeCloseTo(61, 5);
    });

    it('freezes while buffering and resumes from the position the player reports', () => {
        emit({ type: 'playing', positionMs: 1000, durationMs: 200_000 });

        nowMs = 2000;
        emit({ type: 'buffering', positionMs: 2000, durationMs: 200_000 });

        nowMs = 5000;
        expect(nativePlaybackEngine.getPositionSec()).toBeCloseTo(2, 5);

        emit({ type: 'playing', positionMs: 5000, durationMs: 200_000 });
        nowMs = 6000;
        expect(nativePlaybackEngine.getPositionSec()).toBeCloseTo(6, 5);
    });

    it('freezes on pause and does not restart from an older sample', async () => {
        emit({ type: 'playing', positionMs: 1000, durationMs: 200_000 });
        nowMs = 5000;
        expect(nativePlaybackEngine.getPositionSec()).toBeCloseTo(6, 5);

        await nativePlaybackEngine.pause();
        nowMs = 10_000;
        expect(nativePlaybackEngine.getPositionSec()).toBeCloseTo(6, 5);

        await nativePlaybackEngine.play();
        nowMs = 12_000;
        expect(nativePlaybackEngine.getPositionSec()).toBeCloseTo(8, 5);
    });

    it('allows an explicit seek to move the clock backwards', async () => {
        emit({ type: 'playing', positionMs: 1000, durationMs: 200_000 });
        nowMs = 10_000;
        expect(nativePlaybackEngine.getPositionSec()).toBeCloseTo(11, 5);

        await nativePlaybackEngine.seek(5);
        nowMs = 15_000;
        expect(nativePlaybackEngine.getPositionSec()).toBeCloseTo(10, 5);
    });

    it('adopts the native clock after a long freeze without playback commands', async () => {
        nowMs = 30 * 60 * 1000;
        vi.clearAllMocks();
        nativePlaybackEngine.adoptSnapshot({ songKey: 'B', url: 'https://example.invalid/B', positionMs: 12000, durationMs: 90000, playing: true });
        expect(nativePlaybackEngine.getPositionSec()).toBe(12);
        nowMs += 1000;
        expect(nativePlaybackEngine.getPositionSec()).toBe(13);
        await nativePlaybackEngine.setSource('https://example.invalid/B', { songKey: 'B' });
        expect(harness.nativePlayer.prepare).not.toHaveBeenCalled();
        expect(harness.nativePlayer.play).not.toHaveBeenCalled();
        expect(harness.nativePlayer.seek).not.toHaveBeenCalled();
        expect(harness.nativePlayer.stop).not.toHaveBeenCalled();
        expect(nativePlaybackEngine.getDurationSec()).toBe(90);
    });

    it('adopts paused zero position and discards delayed events for the old track', () => {
        nativePlaybackEngine.adoptSnapshot({ songKey: 'B', url: 'https://example.invalid/B', positionMs: 0, durationMs: 90000, playing: false });
        emit({ type: 'playing', songKey: 'A', positionMs: 70000, durationMs: 200000 });
        nowMs = 10000;
        expect(nativePlaybackEngine.getPositionSec()).toBe(0);
        expect(nativePlaybackEngine.isPlaying()).toBe(false);
    });

    it('resets to zero when the player loops the track', () => {
        emit({ type: 'playing', positionMs: 1000, durationMs: 200_000 });
        nowMs = 200_000;
        expect(nativePlaybackEngine.getPositionSec()).toBeCloseTo(200, 5);

        emit({ type: 'seeked', positionMs: 0, durationMs: 200_000 });
        nowMs = 205_000;
        expect(nativePlaybackEngine.getPositionSec()).toBeCloseTo(5, 5);
    });
});
