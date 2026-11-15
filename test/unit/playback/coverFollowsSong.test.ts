import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SongResult } from '@/types';

// test/unit/playback/coverFollowsSong.test.ts
// #323：换成另一首歌时上一首的 cachedCoverUrl 不能留下来盖住新歌的封面。

// 解析封面时会顺手排一次字节兜底下载：这里只看 store，不发网络。
vi.mock('@/services/coverCache', () => ({ loadCachedOrFetchCover: vi.fn(() => new Promise(() => undefined)) }));
const { selectCoverUrl, usePlaybackStore } = await import('@/stores/usePlaybackStore');

const songOf = (id: string, coverUrl = ''): SongResult => ({
    id,
    name: `Song ${id}`,
    artists: [],
    durationMs: 1000,
    album: { id: 0, name: '', coverUrl },
    sourceRef: { kind: 'online', providerId: 'netease', mediaId: id },
} as SongResult);

describe('cachedCoverUrl follows the song', () => {
    beforeEach(() => {
        usePlaybackStore.setState({ currentSong: null, cachedCoverUrl: null });
    });

    it('drops the previous song\'s cached cover when another song is set', () => {
        const store = usePlaybackStore.getState();
        store.setCurrentSong(songOf('a', 'https://cover.test/a.jpg'));
        store.setCachedCoverUrl('blob:cover-of-a');
        store.setCurrentSong(songOf('b', 'https://cover.test/b.jpg'));

        const state = usePlaybackStore.getState();
        expect(state.cachedCoverUrl).toBeNull();
        expect(selectCoverUrl(state)).toBe('https://cover.test/b.jpg');
    });

    it('keeps the cached cover when the same song is rewritten', () => {
        const store = usePlaybackStore.getState();
        store.setCurrentSong(songOf('a'));
        store.setCachedCoverUrl('blob:cover-of-a');
        store.setCurrentSong(previous => (previous ? { ...previous, name: 'Song a (with lyrics state)' } : previous));

        expect(usePlaybackStore.getState().cachedCoverUrl).toBe('blob:cover-of-a');
    });

    it('drops the cached cover when the player is emptied', () => {
        const store = usePlaybackStore.getState();
        store.setCurrentSong(songOf('a'));
        store.setCachedCoverUrl('blob:cover-of-a');
        store.setCurrentSong(null);

        expect(usePlaybackStore.getState().cachedCoverUrl).toBeNull();
    });
});
