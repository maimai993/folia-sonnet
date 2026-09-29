import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/bodianLibrary.test.ts

const request = vi.hoisted(() => vi.fn());
vi.mock('@/services/onlineMusic/bodianTransport', () => ({ requestBodian: request }));
import { bodianCollectionItems, bodianLibrary, clearBodianLibraryCache } from '@/services/onlineMusic/bodianLibrary';

beforeEach(() => { request.mockReset(); clearBodianLibraryCache(); });

describe('Bodian library adapter', () => {
    it('combines owned, liked and collected playlists once then pages the stable snapshot', async () => {
        request.mockResolvedValue({
            liked: { id: 1, name: '喜欢', sourceType: 5, isFond: 1 },
            owned: { playLists: [{ id: 2, name: '自建', sourceType: 1 }] },
            collected: { playLists: [{ id: 3, name: '收藏', sourceType: 4 }], total: 1 },
        });
        const first = await bodianLibrary.getUserPlaylists('100', 2, 0);
        expect(first).toMatchObject({ total: 3, hasMore: true, nextOffset: 2 });
        expect(first.items.every(item => item.isOwned)).toBe(true);
        const second = await bodianLibrary.getUserPlaylists('100', 2, 2);
        expect(second.items[0]).toMatchObject({ id: '3', isOwned: false, providerData: { source: 4 } });
        expect(second.hasMore).toBe(false);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('keeps users separate and refreshes the first page instead of retaining stale data', async () => {
        request.mockResolvedValue({ liked: {}, owned: { playLists: [] }, collected: {} });
        await bodianLibrary.getUserPlaylists('100', 50, 0);
        await bodianLibrary.getUserPlaylists('100', 50, 0);
        await bodianLibrary.getUserPlaylists('200', 50, 50);
        expect(request).toHaveBeenCalledTimes(3);
    });

    it('treats observed empty containers as empty but rejects malformed nonempty responses', () => {
        expect(bodianCollectionItems({}, 'playLists')).toEqual([]);
        expect(bodianCollectionItems([], 'playLists')).toEqual([]);
        expect(() => bodianCollectionItems({ error: 'rejected' }, 'playLists')).toThrow();
    });

    it('stops a stale-total liked page when it contains no tracks', async () => {
        request.mockResolvedValueOnce({ list: [{ id: 1 }, { id: 2 }], total: 1000 })
            .mockResolvedValueOnce({ list: [], total: 1000 });
        await expect(bodianLibrary.getLikedSongIds!('100')).resolves.toEqual(['1', '2']);
        expect(request).toHaveBeenLastCalledWith('liked_songs', { limit: 100, offset: 2 });
    });
});
