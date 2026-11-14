import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 唤醒的异步快照串行化与卸载清理，不依赖真实时间或 Android 设备。
const h = vi.hoisted(() => ({
    effect: null as null | (() => void | (() => void)),
    read: vi.fn(),
    setPending: vi.fn(),
    pending: true,
    requests: 0,
    generation: 0,
    background: null as null | ((hidden: boolean) => void),
}));
vi.mock('react', () => ({
    useRef: (value: unknown) => ({ current: value }),
    useEffect: (effect: typeof h.effect) => { h.effect = effect; },
    useSyncExternalStore: (_subscribe: unknown, get: () => boolean) => get(),
}));
vi.mock('@/platform/runtime', () => ({ isCapacitorAndroid: () => true }));
vi.mock('@/components/app/playback/currentSong', () => ({ playRequestsSoFar: () => h.requests }));
vi.mock('@/services/nativeQueueBridge', () => ({ readNativeQueueState: h.read }));
vi.mock('@/services/playbackEngine/nativePlaybackSync', () => ({
    isNativePlaybackReconciling: () => h.pending,
    setNativePlaybackReconciling: h.setPending,
    subscribeNativePlaybackSync: vi.fn(),
    beginNativePlaybackRead: () => ++h.generation,
    isLatestNativePlaybackRead: (generation: number) => generation === h.generation,
}));
vi.mock('@/utils/backgroundRenderGate', () => ({ subscribeBackgroundRenderSuspended: (cb: typeof h.background) => { h.background = cb; return () => { h.background = null; }; } }));
const { useNativePlaybackReconciliation } = await import('@/hooks/useNativePlaybackReconciliation');
let doc: EventTarget & { visibilityState: string };
let win: EventTarget;
let cleanup: (() => void) | void;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
beforeEach(() => {
    vi.clearAllMocks();
    doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    win = new EventTarget();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', win);
    h.read.mockResolvedValue({ hasSong: false });
});
afterEach(() => { cleanup?.(); cleanup = undefined; vi.unstubAllGlobals(); });
describe('native wake reconciliation', () => {
    it('gates writes before the read and only releases after adopting', async () => {
        const adopt = vi.fn(() => true);
        h.read.mockResolvedValue({ hasSong: true, songKey: 'B', nativeMedia: {} });
        useNativePlaybackReconciliation(adopt);
        cleanup = h.effect!();
        expect(h.setPending).toHaveBeenCalledWith(true);
        expect(adopt).not.toHaveBeenCalled();
        await flush();
        expect(adopt).toHaveBeenCalledWith({ hasSong: true, songKey: 'B', nativeMedia: {} });
        expect(h.setPending).toHaveBeenLastCalledWith(false);
    });
    it('coalesces foreground events while a read is in flight', async () => {
        let resolve!: (value: unknown) => void;
        h.read.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
        useNativePlaybackReconciliation(() => true);
        cleanup = h.effect!();
        win.dispatchEvent(new Event('focus'));
        win.dispatchEvent(new Event('resume'));
        expect(h.read).toHaveBeenCalledTimes(1);
        resolve({ hasSong: false });
        await flush();
        expect(h.read).toHaveBeenCalledTimes(2);
    });
    it('does not cancel a user play requested while the snapshot was pending', async () => {
        let resolve!: (value: unknown) => void;
        h.read.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
        const adopt = vi.fn(() => true);
        useNativePlaybackReconciliation(adopt);
        cleanup = h.effect!();
        h.requests += 1;
        resolve({ hasSong: true, songKey: 'old' });
        await flush();
        expect(adopt).not.toHaveBeenCalled();
        expect(h.setPending).toHaveBeenLastCalledWith(false);
    });
    it('does not adopt a result arriving after unmount', async () => {
        let resolve!: (value: unknown) => void;
        h.read.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
        const adopt = vi.fn(() => true);
        useNativePlaybackReconciliation(adopt);
        cleanup = h.effect!();
        cleanup?.(); cleanup = undefined;
        resolve({ hasSong: true });
        await flush();
        expect(adopt).not.toHaveBeenCalled();
        expect(h.setPending).not.toHaveBeenCalledWith(false);
    });
    it('does not release the gate after an inconsistent snapshot', async () => {
        h.read.mockResolvedValue({ hasSong: true, nativeMedia: {} });
        useNativePlaybackReconciliation(() => false);
        cleanup = h.effect!(); await flush();
        expect(h.setPending).not.toHaveBeenCalledWith(false);
    });
    it('closes the gate in the background and refreshes on native foreground', async () => {
        useNativePlaybackReconciliation(() => true);
        cleanup = h.effect!(); await flush();
        h.background?.(true);
        expect(h.setPending).toHaveBeenLastCalledWith(true);
        h.background?.(false); await flush();
        expect(h.read).toHaveBeenCalledTimes(2);
    });
});
