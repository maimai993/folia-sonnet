import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/analysis/drumHitsMixCache.test.ts
// Android 的混音鼓点缓存按前缀分版本（#344）：hat 频带起点从 4000 Hz 改成 6000 Hz 之后，
// 旧边界算出来的缓存（`drum_hits_v1_mix_`）不能再被读，否则用户听同一首歌，鼓面还是旧的。

const store = new Map<string, unknown>();
vi.mock('@/services/db', () => ({
    getFromCache: vi.fn(async (key: string) => store.get(key) ?? null),
    saveToCache: vi.fn(async (key: string, data: unknown) => {
        store.set(key, data);
    }),
    removeFromCache: vi.fn(async (key: string) => {
        store.delete(key);
    }),
}));
vi.mock('@/services/analysis/beatThisGpu', () => ({ HTDEMUCS_GPU_SEGMENT: 16, runHtdemucsGpu: vi.fn() }));
// 手机上：原生分析可用，鼓点走混音频带，缓存读的是 mix 前缀。
vi.mock('@/services/automix/nativeModels', () => ({
    analyzeDrumBandsNativeFromUrl: vi.fn(async () => null),
    cancelNativeSeparation: vi.fn(),
    isNativeModelsAvailable: () => true,
}));

const { getDrumHits, loadStoredDrumHits } = await import('@/services/analysis/drumHits');
const { DRUM_HITS_PREFIX, isDrumHitsKey } = await import('@/services/analysis/beatGridKeys');

const analysis = () => ({
    hits: { times: Float64Array.from([0.5, 1]), strengths: Float32Array.from([1, 0.5]), kinds: Uint8Array.from([0, 1]) },
    drumEnergy: new Float32Array(100).fill(1),
    mixEnergy: new Float32Array(100).fill(1),
});

describe('mix drum hits cache version', () => {
    beforeEach(() => store.clear());

    it('no longer reads a mix analysis cached under the old 4000 Hz hat boundary', async () => {
        store.set(`${DRUM_HITS_PREFIX}mix_song-a`, analysis());
        expect(await loadStoredDrumHits('song-a')).toBeNull();
        expect(getDrumHits('song-a')).toBeNull();
    });

    it('reads a mix analysis cached under the current version', async () => {
        store.set(`${DRUM_HITS_PREFIX}mix2_song-b`, analysis());
        expect(await loadStoredDrumHits('song-b')).not.toBeNull();
        expect(getDrumHits('song-b')?.times.length).toBe(2);
    });

    it('still prefers a real drum stem over the mix', async () => {
        // 两份的第一个 hit 时间不同：读到哪一份，看第一个 hit 的时间（混音那份在手机上还会被规整，不能比个数）。
        const stem = analysis();
        stem.hits.times = Float64Array.from([0.1, 2]);
        const mix = analysis();
        mix.hits.times = Float64Array.from([5, 6]);
        store.set(`${DRUM_HITS_PREFIX}song-c`, stem);
        store.set(`${DRUM_HITS_PREFIX}mix2_song-c`, mix);
        await loadStoredDrumHits('song-c');
        expect(getDrumHits('song-c')?.times[0]).toBeCloseTo(0.1, 5);
    });

    it('keeps the old and new mix entries inside the analysis category, so cache usage and clearing still see them', () => {
        expect(isDrumHitsKey(`${DRUM_HITS_PREFIX}mix_x`)).toBe(true);
        expect(isDrumHitsKey(`${DRUM_HITS_PREFIX}mix2_x`)).toBe(true);
    });
});
