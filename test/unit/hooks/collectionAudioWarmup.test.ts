import { afterEach, describe, expect, it, vi } from 'vitest';

// 集合首批曲目到达即只预热首曲，分页不重复取流；退订后不再触发。
const h = vi.hoisted(() => ({ effect: null as null | (() => void | (() => void)), warm: vi.fn(), quality: 'high' }));
vi.mock('react', () => ({ useEffect: (effect: typeof h.effect) => { h.effect = effect; } }));
vi.mock('@/platform/runtime', () => ({ isCapacitorAndroid: () => true }));
vi.mock('@/services/prefetchService', () => ({ warmupSongAudio: h.warm }));
vi.mock('@/stores/useAudioSettingsStore', () => ({ useAudioSettingsStore: { getState: () => ({ audioQuality: h.quality }), subscribe: () => vi.fn() } }));
const { useCollectionAudioWarmup } = await import('@/library/app/useCollectionAudioWarmup');
afterEach(() => { vi.clearAllMocks(); h.quality = 'high'; });
describe('collection first song audio warmup', () => {
    it('warms one online song after resource data arrives, not every page', () => {
        let listener!: () => void;
        const remove = vi.fn();
        const tracks: unknown[] = [];
        const resource = { getSnapshot: () => ({ tracks }), subscribe: (cb: () => void) => { listener = cb; return remove; } };
        useCollectionAudioWarmup(resource as never);
        const cleanup = h.effect!();
        expect(h.warm).not.toHaveBeenCalled();
        const song = { id: 'A', sourceRef: { kind: 'online', providerId: 'test', mediaId: 'A' } };
        tracks.push(song); listener(); listener();
        tracks.push({ id: 'B' }); listener();
        expect(h.warm).toHaveBeenCalledTimes(1);
        expect(h.warm).toHaveBeenCalledWith(song, 'high');
        cleanup?.(); expect(remove).toHaveBeenCalledOnce();
    });
});
