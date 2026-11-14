import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCachedCoverUrl, loadCachedOrFetchCover } from '@/services/coverCache';

// test/unit/services/coverCache.test.ts
// Verifies invalid persisted cover payloads degrade to cache misses and legacy Blobs migrate safely.

const mocks = vi.hoisted(() => ({
    getFromCache: vi.fn(),
    removeFromCache: vi.fn(),
    saveToCache: vi.fn(),
    readCoverAsset: vi.fn(),
    removeCoverAsset: vi.fn(),
    writeCoverAsset: vi.fn(),
}));

vi.mock('@/services/db', () => ({
    getFromCache: mocks.getFromCache,
    removeFromCache: mocks.removeFromCache,
    saveToCache: mocks.saveToCache,
}));
vi.mock('@/services/binaryAssetStore', () => ({
    clearCoverAssets: vi.fn(),
    getCoverAssetUsage: vi.fn(),
    readCoverAsset: mocks.readCoverAsset,
    removeCoverAsset: mocks.removeCoverAsset,
    writeCoverAsset: mocks.writeCoverAsset,
}));

describe('coverCache', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getFromCache.mockResolvedValue(null);
        mocks.readCoverAsset.mockResolvedValue(null);
        vi.stubGlobal('fetch', vi.fn());
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:safe-cover');
    });

    it('deletes an invalid IndexedDB value without creating an object URL', async () => {
        mocks.getFromCache.mockResolvedValue({ size: 4, type: 'image/png' });

        await expect(getCachedCoverUrl('cover_local_bad')).resolves.toBeNull();

        expect(URL.createObjectURL).not.toHaveBeenCalled();
        expect(mocks.removeFromCache).toHaveBeenCalledWith('cover_local_bad');
        expect(mocks.removeCoverAsset).toHaveBeenCalledWith('cover_local_bad');
    });

    it('lazily migrates a valid legacy Blob before returning its object URL', async () => {
        const cover = new Blob(['cover'], { type: 'image/png' });
        const descriptor = {
            backend: 'opfs',
            mimeType: 'image/png',
            size: cover.size,
            updatedAt: 1,
        };
        mocks.getFromCache.mockResolvedValue(cover);
        mocks.writeCoverAsset.mockResolvedValue(descriptor);

        await expect(getCachedCoverUrl('cover_local_valid')).resolves.toBe('blob:safe-cover');

        expect(mocks.writeCoverAsset).toHaveBeenCalledWith('cover_local_valid', cover);
        expect(mocks.saveToCache).toHaveBeenCalledWith('cover_local_valid', descriptor);
        expect(URL.createObjectURL).toHaveBeenCalledWith(cover);
    });

    it('keeps a valid legacy Blob when migration to the file store fails', async () => {
        const cover = new Blob(['cover'], { type: 'image/png' });
        mocks.getFromCache.mockResolvedValue(cover);
        mocks.writeCoverAsset.mockRejectedValue(new Error('disk full'));

        await expect(getCachedCoverUrl('cover_local_legacy')).resolves.toBe('blob:safe-cover');

        expect(mocks.removeFromCache).not.toHaveBeenCalled();
        expect(mocks.saveToCache).not.toHaveBeenCalled();
    });

    it('keeps a downloaded Blob usable for the current session when disk persistence fails', async () => {
        const cover = new Blob(['cover'], { type: 'image/jpeg' });
        vi.mocked(fetch).mockResolvedValue(new Response(cover, {
            status: 200,
            headers: { 'Content-Type': 'image/jpeg' },
        }));
        mocks.writeCoverAsset.mockRejectedValue(new Error('disk full'));

        await expect(loadCachedOrFetchCover('cover_local_session', 'https://example.com/cover.jpg'))
            .resolves.toBe('blob:safe-cover');
        expect(mocks.saveToCache).not.toHaveBeenCalled();
        expect(URL.createObjectURL).toHaveBeenCalled();
    });

    // #323：本地歌重新匹配到另一张在线封面时 key 不变，缓存那份不能再冒充新封面。
    it('refetches when the cached cover was downloaded from another address', async () => {
        const descriptor = { backend: 'opfs', mimeType: 'image/jpeg', size: 5, updatedAt: 1 };
        mocks.getFromCache.mockResolvedValue({ ...descriptor, sourceUrl: 'https://example.com/old.jpg' });
        mocks.readCoverAsset.mockResolvedValue(new Blob(['old'], { type: 'image/jpeg' }));
        vi.mocked(fetch).mockResolvedValue(new Response(new Blob(['fresh']), { status: 200 }));
        mocks.writeCoverAsset.mockResolvedValue(descriptor);

        await loadCachedOrFetchCover('cover_local_rematched', 'https://example.com/new.jpg');

        expect(mocks.removeCoverAsset).toHaveBeenCalledWith('cover_local_rematched');
        expect(fetch).toHaveBeenCalled();
        expect(mocks.saveToCache).toHaveBeenCalledWith('cover_local_rematched', { ...descriptor, sourceUrl: 'https://example.com/new.jpg' });
    });

    it('serves a cached cover of the same address, and one stored before addresses were kept', async () => {
        const descriptor = { backend: 'opfs', mimeType: 'image/jpeg', size: 5, updatedAt: 1 };
        mocks.readCoverAsset.mockResolvedValue(new Blob(['cover'], { type: 'image/jpeg' }));

        mocks.getFromCache.mockResolvedValue({ ...descriptor, sourceUrl: 'https://example.com/same.jpg' });
        await expect(loadCachedOrFetchCover('cover_local_same', 'https://example.com/same.jpg')).resolves.toBe('blob:safe-cover');
        mocks.getFromCache.mockResolvedValue(descriptor);
        await expect(loadCachedOrFetchCover('cover_local_legacy', 'https://example.com/any.jpg')).resolves.toBe('blob:safe-cover');

        expect(fetch).not.toHaveBeenCalled();
    });

    it('refetches an entry with no recorded address when the caller says the cover changed', async () => {
        const descriptor = { backend: 'opfs', mimeType: 'image/jpeg', size: 5, updatedAt: 1 };
        mocks.getFromCache.mockResolvedValue(descriptor);
        mocks.readCoverAsset.mockResolvedValue(new Blob(['old'], { type: 'image/jpeg' }));
        vi.mocked(fetch).mockResolvedValue(new Response(new Blob(['fresh']), { status: 200 }));
        mocks.writeCoverAsset.mockResolvedValue(descriptor);

        await loadCachedOrFetchCover('cover_local_automatch', 'https://example.com/new.jpg', { coverChanged: true });

        expect(mocks.removeCoverAsset).toHaveBeenCalledWith('cover_local_automatch');
        expect(fetch).toHaveBeenCalled();
    });

    it('answers a miss for a cover of another address when an address is expected', async () => {
        const descriptor = { backend: 'opfs', mimeType: 'image/jpeg', size: 5, updatedAt: 1 };
        mocks.readCoverAsset.mockResolvedValue(new Blob(['cover'], { type: 'image/jpeg' }));
        mocks.getFromCache.mockResolvedValue({ ...descriptor, sourceUrl: 'https://example.com/old.jpg' });

        await expect(getCachedCoverUrl('cover_local_x', 'https://example.com/new.jpg')).resolves.toBeNull();
        await expect(getCachedCoverUrl('cover_local_x', 'https://example.com/old.jpg')).resolves.toBe('blob:safe-cover');
        await expect(getCachedCoverUrl('cover_local_x')).resolves.toBe('blob:safe-cover');
    });
});
