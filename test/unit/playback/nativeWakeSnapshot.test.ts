import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeQueueState } from '@/services/nativeQueueBridge';
import type { SongResult } from '@/types';

// 原生唤醒快照必须整体认领，不能把旧队列 / 暂停状态当作播放指令。
const h = vi.hoisted(() => ({
    adoptSnapshot: vi.fn(),
    setTime: vi.fn(),
    drop: vi.fn(),
    makeCurrent: vi.fn(),
}));
vi.mock('@/services/playbackEngine/nativePlaybackEngine', () => ({ nativePlaybackEngine: { adoptSnapshot: h.adoptSnapshot } }));
vi.mock('@/stores/motionSignals', () => ({ currentTime: { set: h.setTime } }));
vi.mock('@/components/app/playback/currentSong', () => ({ dropPlaysInFlight: h.drop, makeSongCurrent: h.makeCurrent }));
const { usePlaybackStore } = await import('@/stores/usePlaybackStore');
const { adoptNativePlaybackState } = await import('@/components/app/playback/restore/adoptNativePlaybackState');
const song = (id: string): SongResult => ({ id, name: id, artists: [], album: { id: 0, name: '' }, durationMs: 90000, sourceRef: { kind: 'online', providerId: 'netease', mediaId: id } } as SongResult);
const snapshot = (playing = false, positionMs = 0): NativeQueueState => ({
    entries: ['B', 'C'].map(id => ({ songKey: `online:netease:${id}`, providerId: 'netease', songId: id, mid: '', hash: '', albumAudioId: '', url: `https://example.invalid/${id}`, title: id, artist: '', album: '', coverUrl: '', durationSec: 90 })),
    songKey: 'online:netease:B', hasSong: true, index: 0, size: 2, loopMode: 'off', shuffle: false, revision: 3,
    title: 'B', artist: '', album: '', durationMs: 90000, positionMs, playing, liked: false, canLike: true,
    providerId: 'netease', serverSongId: 'B', artworkUrl: '',
    nativeMedia: { songKey: 'online:netease:B', url: 'https://example.invalid/B', positionMs, durationMs: 90000, playing },
});
beforeEach(() => {
    vi.clearAllMocks();
    usePlaybackStore.setState({ currentSong: song('A'), playQueue: [song('A')], audioSrc: 'https://example.invalid/A', lyrics: { lines: [] }, playerState: 'PLAYING' as never });
});
describe('native wake snapshot', () => {
    it('adopts a native queue absent from stale Web state before claiming its song', () => {
        const native = snapshot();
        expect(adoptNativePlaybackState(native)).toBe(true);
        expect(usePlaybackStore.getState().playQueue.map(s => s.id)).toEqual(['B', 'C']);
        expect(h.makeCurrent).toHaveBeenCalledWith(expect.objectContaining({ id: 'B' }));
        expect(h.adoptSnapshot).toHaveBeenCalledWith(native.nativeMedia);
        expect(h.drop).not.toHaveBeenCalled();
        expect(usePlaybackStore.getState().audioSrc).toBe(native.nativeMedia!.url);
        expect(usePlaybackStore.getState().lyrics).toBe(null);
    });
    it('preserves pause and a zero position, not truthy-only position or forced PLAYING', () => {
        adoptNativePlaybackState(snapshot(false, 0));
        expect(usePlaybackStore.getState().playerState).toBe('PAUSED');
        expect(h.setTime).toHaveBeenCalledWith(0);
    });
    it('resets the clock and duration even if the displayed song key is already current', () => {
        usePlaybackStore.setState({ currentSong: song('B') });
        adoptNativePlaybackState(snapshot(true, 12000));
        expect(h.adoptSnapshot).toHaveBeenCalledOnce();
        expect(h.setTime).toHaveBeenCalledWith(12);
        expect(usePlaybackStore.getState().duration).toBe(90);
        expect(usePlaybackStore.getState().playerState).toBe('PLAYING');
    });
    it.each([
        ['online:qq:mid-B', 'qq', '12345', 'mid-B'],
        ['local:file-B', '', '', ''],
        ['navidrome:server-B', '', '', ''],
    ])('preserves canonical snapshot identity %s when reconstructing a fresh queue', (key, providerId, songId, mid) => {
        const native = snapshot();
        native.songKey = key;
        native.nativeMedia!.songKey = key;
        native.entries = [{ ...native.entries[0], songKey: key, providerId, songId, mid }];
        expect(adoptNativePlaybackState(native)).toBe(true);
        const claimed = h.makeCurrent.mock.calls[0][0];
        expect(claimed.sourceRef.mediaId).toBe(key.startsWith('online:') ? 'mid-B' : key.split(':')[1]);
    });
    it('rejects inconsistent service and actual engine identities without writing', () => {
        const native = snapshot();
        native.nativeMedia!.songKey = 'online:netease:C';
        expect(adoptNativePlaybackState(native)).toBe(false);
        expect(h.adoptSnapshot).not.toHaveBeenCalled();
        expect(h.makeCurrent).not.toHaveBeenCalled();
    });
});
