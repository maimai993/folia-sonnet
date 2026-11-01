import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SongResult } from '@/types';
import { OnlineProviderError } from '@/types/onlineMusic';
import { clearPrefetchRuntime, getPrefetchedData, updatePrefetchedAudioUrl, warmupSongAudio } from '@/services/prefetchService';

// test/unit/playback/playlistAudioWarmup.test.ts
// 歌单 ready 的轻量首曲预热：只取音频 URL、同歌同音质在途合并，失败不写缓存。

const mocks = vi.hoisted(() => ({
    getAudioSource: vi.fn(),
    hasCachedSongAudio: vi.fn(),
    onlineRequestCooldown: vi.fn(),
    noteOnlineRequestCooldown: vi.fn(),
}));

vi.mock('@/services/onlineMusic/omni', () => ({
    omni: {
        getAudioSource: (...args: unknown[]) => mocks.getAudioSource(...args),
        canPlaySong: () => true,
        resolveAudioQuality: (_providerId: string, quality: string) => quality,
    },
}));
vi.mock('@/services/onlineMusic/resourceCache', async importOriginal => ({
    ...await importOriginal<typeof import('@/services/onlineMusic/resourceCache')>(),
    hasCachedSongAudio: (...args: unknown[]) => mocks.hasCachedSongAudio(...args),
}));
vi.mock('@/services/onlineMusic/failure/onlineRequestCooldown', () => ({
    onlineRequestCooldown: (...args: unknown[]) => mocks.onlineRequestCooldown(...args),
    noteOnlineRequestCooldown: (...args: unknown[]) => mocks.noteOnlineRequestCooldown(...args),
}));

const song: SongResult = {
    id: 'warmup-song',
    name: 'Warmup Song',
    artists: [],
    album: { id: 'warmup-album', name: 'Warmup Album' },
    durationMs: 1000,
    sourceRef: { kind: 'online', providerId: 'netease', mediaId: 'warmup-song' },
};

beforeEach(() => {
    clearPrefetchRuntime();
    vi.clearAllMocks();
    mocks.hasCachedSongAudio.mockResolvedValue(false);
    mocks.onlineRequestCooldown.mockReturnValue(null);
    mocks.getAudioSource.mockResolvedValue({
        url: 'https://audio.test/warmup.flac',
        fetchedAt: 0,
        quality: 'high',
        replayGain: { trackGain: -6 },
    });
    vi.spyOn(console, 'log').mockImplementation(() => { });
    vi.spyOn(console, 'warn').mockImplementation(() => { });
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('warmupSongAudio', () => {
    it('writes only the audio URL and its ReplayGain into the prefetch cache', async () => {
        await expect(warmupSongAudio(song, 'high')).resolves.toEqual({
            audioUrl: 'https://audio.test/warmup.flac',
            replayGain: { trackGain: -6 },
        });

        expect(mocks.getAudioSource).toHaveBeenCalledTimes(1);
        expect(mocks.getAudioSource).toHaveBeenCalledWith(song, 'high');
        expect(getPrefetchedData(song, 'high')).toMatchObject({
            audioUrl: 'https://audio.test/warmup.flac',
            audioUrlQuality: 'high',
            replayGain: { trackGain: -6 },
            lyrics: null,
            lyricRaw: null,
        });
    });

    it('merges in-flight warmups for the same song and quality', async () => {
        let resolveAudio!: (value: unknown) => void;
        mocks.getAudioSource.mockImplementationOnce(() => new Promise(resolve => {
            resolveAudio = resolve;
        }));

        const first = warmupSongAudio(song, 'high');
        const second = warmupSongAudio(song, 'high');
        expect(second).toBe(first);

        await vi.waitFor(() => expect(mocks.getAudioSource).toHaveBeenCalledTimes(1));
        resolveAudio({ url: 'https://audio.test/merged.flac', fetchedAt: 0, quality: 'high' });

        await expect(first).resolves.toMatchObject({ audioUrl: 'https://audio.test/merged.flac' });
        await expect(second).resolves.toMatchObject({ audioUrl: 'https://audio.test/merged.flac' });
        expect(mocks.getAudioSource).toHaveBeenCalledTimes(1);
    });

    it('reuses a valid URL of the same quality without asking the provider', async () => {
        updatePrefetchedAudioUrl(song, 'https://audio.test/cached.flac', 'high');

        await expect(warmupSongAudio(song, 'high')).resolves.toMatchObject({
            audioUrl: 'https://audio.test/cached.flac',
        });
        expect(mocks.getAudioSource).not.toHaveBeenCalled();
    });

    it('refetches once the cached URL has outlived the TTL', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(0);
        updatePrefetchedAudioUrl(song, 'https://audio.test/expired.flac', 'high');

        now.mockReturnValue(20 * 60 * 1000 + 1);

        await expect(warmupSongAudio(song, 'high')).resolves.toMatchObject({
            audioUrl: 'https://audio.test/warmup.flac',
        });
        expect(mocks.getAudioSource).toHaveBeenCalledTimes(1);
    });

    it('asks again at another quality but leaves the existing source usable when that fails', async () => {
        updatePrefetchedAudioUrl(song, 'https://audio.test/high.flac', 'high', { trackGain: -3 });
        mocks.getAudioSource.mockRejectedValueOnce(new OnlineProviderError('network', 'no link', 'netease'));

        await expect(warmupSongAudio(song, 'lossless')).resolves.toBeNull();

        expect(mocks.getAudioSource).toHaveBeenCalledWith(song, 'lossless');
        expect(getPrefetchedData(song, 'high')).toMatchObject({
            audioUrl: 'https://audio.test/high.flac',
            audioUrlQuality: 'high',
            replayGain: { trackGain: -3 },
        });
    });

    it('writes nothing when the provider fails and there was no entry', async () => {
        mocks.getAudioSource.mockRejectedValueOnce(new OnlineProviderError('network', 'no link', 'netease'));

        await expect(warmupSongAudio(song, 'high')).resolves.toBeNull();

        expect(getPrefetchedData(song)).toBeNull();
    });

    it('keeps the media-cache sentinel without asking for a URL', async () => {
        mocks.hasCachedSongAudio.mockResolvedValue(true);

        await expect(warmupSongAudio(song, 'high')).resolves.toEqual({ audioUrl: 'CACHED_IN_DB' });
        expect(mocks.getAudioSource).not.toHaveBeenCalled();
        expect(getPrefetchedData(song, 'high')?.audioUrl).toBe('CACHED_IN_DB');
    });
});
