import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appDatabase } from '../../../src/services/appDatabase';
import { assignImportedSongs } from '../../../src/services/localLibraryCatalogService';
import {
    migrateLegacyLocalCoverAssetsInBackground,
    prepareLocalCoverBlob,
    resetLocalCoverAssetRuntime,
} from '../../../src/services/localCoverAssetService';
import type { LocalSong } from '../../../src/types';
import { hashLocalCoverBlobAsync } from '../../../src/utils/localMetadataWorkerClient';
import { hasLocalCoverBinary, removeLocalCoverBinary, writeLocalCoverBinary } from '../../../src/services/localCoverBinaryStore';

// test/unit/services/localCoverAssetService.test.ts
// Verifies one-time hashing, external deduplication, lightweight descriptors, and retry-safe migration.

vi.mock('../../../src/utils/localMetadataWorkerClient', () => ({
    hashLocalCoverBlobAsync: vi.fn(),
}));

vi.mock('../../../src/services/localCoverBinaryStore', async importOriginal => {
    const actual = await importOriginal<typeof import('../../../src/services/localCoverBinaryStore')>();
    return {
        ...actual,
        hasLocalCoverBinary: vi.fn(),
        removeLocalCoverBinary: vi.fn(),
        writeLocalCoverBinary: vi.fn(),
    };
});

const buildSong = (id: string, localCoverAssetId?: string): LocalSong => ({
    id,
    fileName: `${id}.flac`,
    filePath: `Music/${id}.flac`,
    title: id,
    titleOrigin: 'import',
    importedMetadata: {
        title: id,
        titleSource: 'filename',
        artistNames: ['Artist'],
        albumName: 'Album',
    },
    duration: 1,
    fileSize: 1,
    mimeType: 'audio/flac',
    addedAt: 1,
    localCoverAssetId,
});

describe('localCoverAssetService', () => {
    beforeEach(async () => {
        resetLocalCoverAssetRuntime();
        await appDatabase.delete();
        await appDatabase.open();
        vi.mocked(hashLocalCoverBlobAsync).mockReset();
        vi.mocked(hasLocalCoverBinary).mockResolvedValue(false);
        vi.mocked(removeLocalCoverBinary).mockResolvedValue(undefined);
        vi.mocked(writeLocalCoverBinary).mockImplementation(async (_assetId, blob) => ({
            backend: 'opfs',
            mimeType: (blob as Blob).type,
            size: (blob as Blob).size,
        }));
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await appDatabase.delete();
    });

    it('hashes a shared cover once and stores one external payload for two song references', async () => {
        const assetId = `sha256:${'1'.repeat(64)}`;
        const cover = new Blob(['same-cover'], { type: 'image/png' });
        vi.mocked(hashLocalCoverBlobAsync).mockResolvedValue({ cover, coverAssetId: assetId });

        const prepared = await prepareLocalCoverBlob(cover);
        await assignImportedSongs([
            buildSong('one', prepared?.assetId),
            buildSong('two', prepared?.assetId),
        ]);

        expect(hashLocalCoverBlobAsync).toHaveBeenCalledOnce();
        expect(writeLocalCoverBinary).toHaveBeenCalledOnce();
        expect(await appDatabase.local_cover_assets.count()).toBe(1);
        expect(await appDatabase.local_music.toArray()).toEqual(expect.arrayContaining([
            expect.objectContaining({ localCoverAssetId: assetId }),
            expect.objectContaining({ localCoverAssetId: assetId }),
        ]));
        expect(await appDatabase.local_cover_assets.get(assetId)).not.toHaveProperty('blob');
    });

    it('infers the MIME type for a folder cover File whose browser type is empty', async () => {
        const assetId = `sha256:${'4'.repeat(64)}`;
        const folderFile = new File(['folder-cover'], 'cover.jpg');
        vi.mocked(hashLocalCoverBlobAsync).mockImplementation(async cover => ({ cover, coverAssetId: assetId }));

        const result = await prepareLocalCoverBlob(folderFile);

        expect(result).toMatchObject({ assetId });
        expect(result?.blob.type).toBe('image/jpeg');
    });

    it('cleans an unreferenced external asset if the owning song transaction fails', async () => {
        const assetId = `sha256:${'5'.repeat(64)}`;
        const cover = new Blob(['transaction-cover'], { type: 'image/png' });
        vi.mocked(hashLocalCoverBlobAsync).mockResolvedValue({ cover, coverAssetId: assetId });
        await prepareLocalCoverBlob(cover);
        vi.spyOn(appDatabase.local_music, 'bulkPut').mockRejectedValueOnce(new Error('forced song failure'));

        await expect(assignImportedSongs([buildSong('rollback-cover', assetId)])).rejects.toThrow('forced song failure');

        expect(await appDatabase.local_cover_assets.get(assetId)).toBeUndefined();
        expect(await appDatabase.local_music.get('rollback-cover')).toBeUndefined();
    });

    it('keeps a legacy IndexedDB Blob untouched when external migration fails', async () => {
        const assetId = `sha256:${'8'.repeat(64)}`;
        const cover = new Blob(['legacy-cover'], { type: 'image/png' });
        await appDatabase.local_cover_assets.put({
            id: assetId,
            blob: cover,
            mimeType: cover.type,
            size: cover.size,
            createdAt: 1,
        });
        vi.mocked(writeLocalCoverBinary).mockRejectedValueOnce(new Error('quota exceeded'));

        await migrateLegacyLocalCoverAssetsInBackground();

        expect((await appDatabase.local_cover_assets.get(assetId))?.blob).toBeInstanceOf(Blob);
    });

    it('replaces a migrated IndexedDB Blob with a lightweight descriptor', async () => {
        const assetId = `sha256:${'9'.repeat(64)}`;
        const cover = new Blob(['legacy-cover'], { type: 'image/webp' });
        await appDatabase.local_cover_assets.put({
            id: assetId,
            blob: cover,
            mimeType: cover.type,
            size: cover.size,
            createdAt: 1,
        });

        await migrateLegacyLocalCoverAssetsInBackground();

        expect(await appDatabase.local_cover_assets.get(assetId)).toMatchObject({
            id: assetId,
            backend: 'opfs',
            mimeType: 'image/webp',
        });
        expect(await appDatabase.local_cover_assets.get(assetId)).not.toHaveProperty('blob');
    });
});
