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
        seek: vi.fn(async (_positionMs?: number) => undefined),
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

const { nativePlaybackEngine, isStaleSourceEvent } = await import('@/services/playbackEngine/nativePlaybackEngine');

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

    /*
     * 事件是「过去」发生的：`positionMs` 标的是生成那一刻的位置，不是收到那一刻。
     * 少了这一步，起播时过桥排队的那几百毫秒会变成整首歌的恒定滞后 —— 歌词永远比声音晚，
     * 换哪副耳机都一样（跟音频输出延迟无关）。
     */
    it('rebases to when the event was emitted rather than when it was received', () => {
        const wall = 1_700_000_000_000;
        const wallClock = vi.spyOn(Date, 'now').mockReturnValue(wall);
        nowMs = 0;

        emit({ type: 'playing', positionMs: 1000, durationMs: 200_000, wallMs: wall - 300 });
        expect(nativePlaybackEngine.getPositionSec()).toBeCloseTo(1.3, 5);

        nowMs = 1000;
        expect(nativePlaybackEngine.getPositionSec()).toBeCloseTo(2.3, 5);

        wallClock.mockRestore();
    });

    it('ignores a wall-clock stamp that cannot be a bridge delay', () => {
        const wall = 1_700_000_000_000;
        const wallClock = vi.spyOn(Date, 'now').mockReturnValue(wall);
        nowMs = 0;

        // 三小时前的戳（时钟被拽过 / 不是这一下的位置）：按收到的那一刻算，不整首推走。
        emit({ type: 'playing', positionMs: 1000, durationMs: 200_000, wallMs: wall - 3 * 3600 * 1000 });
        expect(nativePlaybackEngine.getPositionSec()).toBeCloseTo(1, 5);

        wallClock.mockRestore();
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

    it.each([
        ['seeked', 'buffering'],
        ['buffering', 'seeked'],
    ] as const)('keeps the clock frozen for seek/buffering order %s then %s (#168)', async (first, second) => {
        emit({ type: 'buffering', positionMs: 10000, durationMs: 200000 });
        await nativePlaybackEngine.seek(90);
        expect(nativePlaybackEngine.getPositionSec()).toBe(90);
        emit({ type: first, positionMs: 90000, buffering: true, playing: true });
        emit({ type: second, positionMs: 90000, buffering: true, playing: true });
        nowMs = 3000;
        expect(nativePlaybackEngine.getPositionSec()).toBe(90);
        emit({ type: 'playing', positionMs: 90000 });
        nowMs = 4000;
        expect(nativePlaybackEngine.getPositionSec()).toBe(91);
    });

    it('adopts buffering snapshots without letting the lyric clock run ahead (#174)', () => {
        vi.clearAllMocks();
        nativePlaybackEngine.adoptSnapshot({ songKey: 'A', url: 'https://example.invalid/A', positionMs: 10000, durationMs: 90000, playing: true, buffering: true });
        nowMs = 5000;
        expect(nativePlaybackEngine.getPositionSec()).toBe(10);
        expect(harness.nativePlayer.seek).not.toHaveBeenCalled();
    });

    it('settles the old rate before changing playback speed', () => {
        emit({ type: 'playing', positionMs: 0, durationMs: 200000 });
        nowMs = 60000;
        expect(nativePlaybackEngine.getPositionSec()).toBe(60);
        nativePlaybackEngine.setSpeed(1.25);
        expect(nativePlaybackEngine.getPositionSec()).toBe(60);
        nowMs = 64000;
        expect(nativePlaybackEngine.getPositionSec()).toBe(65);
        nativePlaybackEngine.setSpeed(1);
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

    it('invalidates an in-flight play when adopting a new snapshot', async () => {
        let releasePlay: (() => void) | undefined;
        harness.nativePlayer.play.mockImplementationOnce(() => new Promise<undefined>(resolve => {
            releasePlay = () => resolve(undefined);
        }));
        const pendingPlay = nativePlaybackEngine.play();
        await vi.waitFor(() => expect(releasePlay).toBeDefined());
        nativePlaybackEngine.adoptSnapshot({ songKey: 'B', url: 'https://example.invalid/B', positionMs: 0, durationMs: 90000, playing: false });
        releasePlay?.();
        await pendingPlay;
        expect(nativePlaybackEngine.isPlaying()).toBe(false);
    });

    it('skips a queued source command after adopting its snapshot', async () => {
        vi.clearAllMocks();
        let releasePrepare: (() => void) | undefined;
        harness.nativePlayer.prepare.mockImplementationOnce(() => new Promise<{ ok: boolean }>(resolve => {
            releasePrepare = () => resolve({ ok: true });
        }));
        const pendingSource = nativePlaybackEngine.setSource('https://example.invalid/C', { songKey: 'C' });
        await vi.waitFor(() => expect(releasePrepare).toBeDefined());
        const staleSource = nativePlaybackEngine.setSource('https://example.invalid/D', { songKey: 'D' });
        nativePlaybackEngine.adoptSnapshot({ songKey: 'D', url: 'https://example.invalid/D', positionMs: 0, durationMs: 90000, playing: false });
        releasePrepare?.();
        await pendingSource;
        await staleSource;
        expect(harness.nativePlayer.prepare).toHaveBeenCalledTimes(1);
        expect(nativePlaybackEngine.currentSongKey()).toBe('D');
    });

    it('adopts paused zero position and discards delayed events for the old track', () => {
        nativePlaybackEngine.adoptSnapshot({ songKey: 'B', url: 'https://example.invalid/B', positionMs: 0, durationMs: 90000, playing: false });
        emit({ type: 'playing', songKey: 'A', positionMs: 70000, durationMs: 200000 });
        nowMs = 10000;
        expect(nativePlaybackEngine.getPositionSec()).toBe(0);
        expect(nativePlaybackEngine.isPlaying()).toBe(false);
    });

    // ---- #337 #339 #341：原生命令结算与 source 令牌 ----

    it('sends a fresh source token with every prepare and tags the adopted source with it', async () => {
        vi.clearAllMocks();
        await nativePlaybackEngine.setSource('https://example.invalid/T1', { songKey: 'T' });
        await nativePlaybackEngine.setSource('https://example.invalid/T2', { songKey: 'T' });
        const tokens = harness.nativePlayer.prepare.mock.calls.map((call: unknown[]) => (call[0] as { sourceToken?: string }).sourceToken);
        expect(tokens).toHaveLength(2);
        expect(tokens[0]).toMatch(/^w:[a-z0-9]+\.\d+$/);
        expect(tokens[1]).toMatch(/^w:[a-z0-9]+\.\d+$/);
        expect(tokens[0]).not.toBe(tokens[1]);
    });

    it('drops a late event of an older source even when songKey is identical (A→B→A)', async () => {
        vi.clearAllMocks();
        await nativePlaybackEngine.setSource('https://example.invalid/A1', { songKey: 'A' });
        await nativePlaybackEngine.setSource('https://example.invalid/B', { songKey: 'B' });
        await nativePlaybackEngine.setSource('https://example.invalid/A2', { songKey: 'A' });
        const tokens = harness.nativePlayer.prepare.mock.calls.map((call: unknown[]) => (call[0] as { sourceToken: string }).sourceToken);
        const first = tokens[0];
        const third = tokens[2];
        nowMs = 1000;
        emit({ type: 'playing', songKey: 'A', sourceToken: first, positionMs: 70_000, durationMs: 200_000 });
        expect(nativePlaybackEngine.isPlaying()).toBe(false);
        emit({ type: 'playing', songKey: 'A', sourceToken: third, positionMs: 2000, durationMs: 200_000 });
        expect(nativePlaybackEngine.isPlaying()).toBe(true);
    });

    it('after adopting a snapshot only events of the adopted token are applied', () => {
        nativePlaybackEngine.adoptSnapshot({ songKey: 'B', sourceToken: 'n:t9', url: 'https://example.invalid/B', positionMs: 5000, durationMs: 90000, playing: false });
        emit({ type: 'playing', songKey: 'B', sourceToken: 'w:old.1', positionMs: 50_000, durationMs: 90000 });
        expect(nativePlaybackEngine.isPlaying()).toBe(false);
        emit({ type: 'playing', songKey: 'B', sourceToken: 'n:t9', positionMs: 5000, durationMs: 90000 });
        expect(nativePlaybackEngine.isPlaying()).toBe(true);
    });

    it('does not record playing when native reports the play was superseded', async () => {
        await nativePlaybackEngine.pause();
        harness.nativePlayer.play.mockImplementationOnce(async () => ({ ok: false, stale: true, reason: 'intent-superseded' }) as never);
        const applied = await nativePlaybackEngine.play();
        expect(applied).toBe(false);
        expect(nativePlaybackEngine.isPlaying()).toBe(false);
    });

    it('reports play() as applied only when native really executed it', async () => {
        await nativePlaybackEngine.pause();
        expect(await nativePlaybackEngine.play()).toBe(true);
        expect(nativePlaybackEngine.isPlaying()).toBe(true);
    });

    // M1：原生自己重装同一个 songKey（单曲循环 / 单曲队列的下一首）时令牌是 n:，Web 还是 w:，不能全丢。
    it('keeps accepting events from a native-initiated reload of the same song', async () => {
        await nativePlaybackEngine.pause();
        await nativePlaybackEngine.setSource('https://example.invalid/L', { songKey: 'L' });
        nowMs = 1000;
        emit({ type: 'playing', songKey: 'L', sourceToken: 'n:t7', positionMs: 0, durationMs: 100_000 });
        expect(nativePlaybackEngine.isPlaying()).toBe(true);
    });

    it('still drops a late event that carries a web token the engine already retired', async () => {
        await nativePlaybackEngine.setSource('https://example.invalid/M1', { songKey: 'M' });
        await nativePlaybackEngine.setSource('https://example.invalid/M2', { songKey: 'M' });
        const prepareTokens = harness.nativePlayer.prepare.mock.calls.map((call: unknown[]) => (call[0] as { sourceToken: string }).sourceToken);
        const first = prepareTokens[prepareTokens.length - 2];
        await nativePlaybackEngine.pause();
        emit({ type: 'playing', songKey: 'M', sourceToken: first, positionMs: 5000, durationMs: 100_000 });
        expect(nativePlaybackEngine.isPlaying()).toBe(false);
    });

    it('decides staleness from both tokens (unknown on either side lets the event through)', () => {
        expect(isStaleSourceEvent(undefined, 'w:a.1')).toBe(false);
        expect(isStaleSourceEvent('', 'w:a.1')).toBe(false);
        expect(isStaleSourceEvent('w:a.1', null)).toBe(false);
        expect(isStaleSourceEvent('w:a.1', 'w:a.1')).toBe(false);
        expect(isStaleSourceEvent('w:a.1', 'w:a.2')).toBe(true);
        expect(isStaleSourceEvent('n:t3', 'w:a.2')).toBe(false);
        // 原生自己换源（含认领来的 n: 令牌之后再次重装同一首）：交给 songKey 过滤，不按令牌丢
        expect(isStaleSourceEvent('n:t3', 'n:t4')).toBe(false);
        // 旧的 Web 令牌（A→B→A 的 ABA）才是真正的旧事件
        expect(isStaleSourceEvent('w:a.1', 'n:t4')).toBe(true);
    });

    it('keeps accepting a native reload of the same song after the snapshot was adopted (n: after n:)', () => {
        nativePlaybackEngine.adoptSnapshot({ songKey: 'S', sourceToken: 'n:t1', url: 'https://example.invalid/S', positionMs: 1000, durationMs: 90000, playing: false });
        nowMs = 500;
        emit({ type: 'playing', songKey: 'S', sourceToken: 'n:t2', positionMs: 0, durationMs: 90000 });
        expect(nativePlaybackEngine.isPlaying()).toBe(true);
    });

    it('does not overwrite a stall that the native player reported while play() was settling', async () => {
        await nativePlaybackEngine.pause();
        let releasePlay: (() => void) | undefined;
        harness.nativePlayer.play.mockImplementationOnce(() => new Promise<undefined>(resolve => {
            releasePlay = () => resolve(undefined);
        }));
        const playing = nativePlaybackEngine.play();
        await vi.waitFor(() => expect(releasePlay).toBeDefined());
        // 事件先于 play() 的延续到达：缓冲中
        emit({ type: 'playing', positionMs: 3000, durationMs: 200_000 });
        emit({ type: 'buffering', positionMs: 3000, durationMs: 200_000 });
        releasePlay?.();
        expect(await playing).toBe(true);
        nowMs += 5000;
        // stalled 没有被乐观写入改回 false：墙钟冻在 3 秒
        expect(nativePlaybackEngine.getPositionSec()).toBeCloseTo(3, 5);
    });

    it('does not send a seek when nothing is loaded', async () => {
        await nativePlaybackEngine.stop();
        harness.nativePlayer.seek.mockClear();
        emit({ type: 'idle', positionMs: 0, durationMs: 0 });
        await nativePlaybackEngine.seek(5);
        expect(harness.nativePlayer.seek).not.toHaveBeenCalled();
    });

    it('lets a pause that is superseded by a later play yield to the play', async () => {
        const pausing = nativePlaybackEngine.pause();
        const playing = nativePlaybackEngine.play();
        await Promise.all([pausing, playing]);
        expect(nativePlaybackEngine.isPlaying()).toBe(true);
    });

    it('does not push a stale volume to a superseded prepare', async () => {
        vi.clearAllMocks();
        harness.nativePlayer.prepare.mockImplementationOnce(async () => ({ ok: false, stale: true, reason: 'source-superseded' }));
        await nativePlaybackEngine.setSource('https://example.invalid/S', { songKey: 'S' });
        expect(harness.nativePlayer.setVolume).not.toHaveBeenCalled();
    });

    it('queues seeks behind a pending prepare and keeps the last seek last', async () => {
        vi.clearAllMocks();
        const order: string[] = [];
        let releasePrepare: (() => void) | undefined;
        harness.nativePlayer.prepare.mockImplementationOnce(() => new Promise<{ ok: boolean }>(resolve => {
            releasePrepare = () => { order.push('prepare'); resolve({ ok: true }); };
        }));
        harness.nativePlayer.seek.mockImplementation(async (position?: number) => { order.push(`seek:${position}`); return undefined; });
        const source = nativePlaybackEngine.setSource('https://example.invalid/Q', { songKey: 'Q' });
        await vi.waitFor(() => expect(releasePrepare).toBeDefined());
        const first = nativePlaybackEngine.seek(10);
        const second = nativePlaybackEngine.seek(20);
        releasePrepare?.();
        await Promise.all([source, first, second]);
        expect(order).toEqual(['prepare', 'seek:10000', 'seek:20000']);
        harness.nativePlayer.seek.mockImplementation(async () => undefined);
    });

    it('drops a queued seek once the source changed', async () => {
        vi.clearAllMocks();
        let releasePrepare: (() => void) | undefined;
        harness.nativePlayer.prepare.mockImplementationOnce(() => new Promise<{ ok: boolean }>(resolve => {
            releasePrepare = () => resolve({ ok: true });
        }));
        const source = nativePlaybackEngine.setSource('https://example.invalid/R1', { songKey: 'R1' });
        await vi.waitFor(() => expect(releasePrepare).toBeDefined());
        const seek = nativePlaybackEngine.seek(30);
        const next = nativePlaybackEngine.setSource('https://example.invalid/R2', { songKey: 'R2' });
        releasePrepare?.();
        await Promise.all([source, seek, next]);
        expect(harness.nativePlayer.seek).not.toHaveBeenCalled();
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
