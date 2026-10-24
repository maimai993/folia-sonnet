import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalSong } from '../../../src/types';
import type { LocalLibraryAssignment, LocalLibraryEntity } from '../../../src/types/localLibrary';
import {
    appDatabase,
    LOCAL_LIBRARY_ARTIST_SPLIT_MARKER_KEY,
    LOCAL_LIBRARY_BOOTSTRAP_MARKER_KEY,
    type StoredCacheEntry,
} from '../../../src/services/appDatabase';
import { clearAllCaches, getFromCache, saveToCache } from '../../../src/services/db';
import { writeCoverAsset } from '../../../src/services/binaryAssetStore';
import { hasLocalCoverBinary, writeLocalCoverBinary } from '../../../src/services/localCoverBinaryStore';

// test/unit/services/clearAllCaches.test.ts
// 存储页的「全部清空」只清能重建的缓存，本地曲库和手工整理过的歌手 / 专辑不能跟着消失。

const CACHE_TABLES = ['api_cache', 'user_cache', 'media_cache', 'metadata_cache'] as const;
const CATEGORY_KEYS = [
    'playlist_tracks_1',
    'playlist_detail_1',
    'user_playlists',
    'online_provider_synthetic_playlist_tracks_1',
    'online_provider_synthetic_user_playlists',
    'lyric_1',
    'cover_1',
    'audio_1',
    'replayGain_1',
    'audioLevel_1',
    'automix_profile_1',
    'beat_this_grid_1',
    'beat_this_small_grid_1',
    'drum_hits_v1_1',
];
const LOCAL_COVER_ID = `sha256:${'a'.repeat(64)}`;

// 不经本地库初始化或缓存 getter 比较原始记录，避免自动迁移掩盖清除时的损坏。
const readPreservedRecords = async () => ({
    songs: await appDatabase.local_music.toArray(),
    entities: await appDatabase.local_library_entities.toArray(),
    assignments: await appDatabase.local_library_assignments.toArray(),
    sessionKeys: await appDatabase.session.toCollection().primaryKeys(),
    sessionValues: await appDatabase.session.toArray(),
    themes: await appDatabase.theme_registry.toArray(),
    covers: await appDatabase.local_cover_assets.toArray(),
});

describe('clearAllCaches', () => {
    beforeEach(async () => {
        vi.stubGlobal('fetch', vi.fn(() => {
            throw new Error('Cache clearing must not use the network');
        }));
        await appDatabase.delete();
        await appDatabase.open();
    });

    afterEach(async () => {
        try {
            await appDatabase.delete();
            expect(globalThis.fetch).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('clears every listed cache but keeps the local library and its manual organization', async () => {
        await saveToCache('lyric_1', { lrc: '' });
        await saveToCache('playlist_tracks_1', [1]);
        await saveToCache('audio_1', new Blob(['audio']));
        await saveToCache('cover_1', new Blob(['cover']));
        await saveToCache('automix_profile_1', { bpm: 120 });
        await saveToCache('theme_1', { name: 'theme' });
        await saveToCache('local_dir_handles', { Music: 'handle' });
        await appDatabase.local_music.put({ id: 'song-1', title: 'Song' } as never);
        await appDatabase.local_library_entities.put({ id: 'artist-1', kind: 'artist', normalizedAliases: ['a'], mergedInto: null, needsReview: 0, createdAt: 1 } as never);
        await appDatabase.local_library_assignments.put({ songId: 'song-1', artistEntityIds: ['artist-1'], albumEntityId: null, artistOrigin: 'manual', albumOrigin: 'manual' } as never);

        await clearAllCaches();

        for (const key of ['lyric_1', 'playlist_tracks_1', 'audio_1', 'cover_1', 'automix_profile_1']) {
            expect(await getFromCache(key)).toBeNull();
        }
        expect(await getFromCache('theme_1')).toEqual({ name: 'theme' });
        expect(await getFromCache('local_dir_handles')).toEqual({ Music: 'handle' });
        expect(await appDatabase.local_music.get('song-1')).toBeTruthy();
        expect(await appDatabase.local_library_entities.get('artist-1')).toBeTruthy();
        expect(await appDatabase.local_library_assignments.get('song-1')).toMatchObject({ artistOrigin: 'manual' });
    });

    it('removes all five categories from every cache table and preserves exact durable records after reopening', async () => {
        const song: LocalSong = {
            id: 'song-1',
            title: '手工标题',
            titleOrigin: 'manual',
            fileName: 'song.flac',
            filePath: 'Music/Album/song.flac',
            nativeAudioRef: 'synthetic-local-audio',
            duration: 123456,
            fileSize: 4096,
            fileLastModified: 11,
            fileSignature: 'synthetic-signature',
            mimeType: 'audio/flac',
            addedAt: 12,
            importedMetadata: {
                title: 'Imported title',
                titleSource: 'embedded',
                artistNames: ['Imported artist'],
                albumName: 'Imported album',
            },
            localCoverAssetId: LOCAL_COVER_ID,
            localCoverSource: 'embedded',
            replayGain: -4.5,
            noAutoMatch: true,
            hasManualLyricSelection: true,
            hasLocalLyrics: true,
            localLyricsContent: '[00:01.00]手工保留的歌词',
            lyricsSource: 'local',
        };
        const entities: LocalLibraryEntity[] = [
            {
                id: 'artist-1', kind: 'artist', displayName: '手工歌手',
                aliases: ['Imported artist', 'Alias'], normalizedAliases: ['imported artist', 'alias'],
                needsReview: false, createdAt: 13, updatedAt: 14,
            },
            {
                id: 'album-1', kind: 'album', displayName: '手工专辑',
                aliases: ['Imported album'], normalizedAliases: ['imported album'],
                needsReview: true, createdAt: 15, updatedAt: 16,
            },
            {
                id: 'artist-merged', kind: 'artist', displayName: 'Merged artist',
                aliases: ['Old artist'], normalizedAliases: ['old artist'],
                mergedInto: 'artist-1', createdAt: 17, updatedAt: 18,
            },
        ];
        const assignment: LocalLibraryAssignment = {
            songId: song.id, artistEntityIds: ['artist-1'], albumEntityId: 'album-1',
            artistOrigin: 'manual', albumOrigin: 'manual', updatedAt: 19,
        };
        const localCover = new Blob([new Uint8Array([137, 80, 78, 71, 0, 1, 255])], { type: 'image/png' });
        await appDatabase.local_music.put(song);
        await appDatabase.local_library_entities.bulkPut(entities);
        await appDatabase.local_library_assignments.put(assignment);
        await appDatabase.session.put({ songId: song.id, position: 4321, queue: [song.id] }, 'synthetic-session');
        await appDatabase.session.put('retained session filename', 'fileName');
        await appDatabase.theme_registry.put({
            fingerprint: 'synthetic-theme', name: '手工主题', colors: ['#123456', '#abcdef'], updatedAt: 20,
        });
        // v0.9 仍允许迁移前的 Blob；不能只保住元数据而丢掉封面字节。
        await appDatabase.local_cover_assets.put({
            id: LOCAL_COVER_ID, mimeType: localCover.type, size: localCover.size, createdAt: 21, blob: localCover,
        });

        const preservedByTable: Record<typeof CACHE_TABLES[number], StoredCacheEntry[]> = {
            api_cache: [
                { key: 'local_dir_handles', data: { Music: { kind: 'directory', name: 'Music', syntheticId: 'dir-1' } }, timestamp: 22 },
                { key: 'local_snapshot_Music', data: { rootFolderName: 'Music', rootRemoved: true, ignoredFolderPaths: ['Hidden'] }, timestamp: 23 },
                { key: LOCAL_LIBRARY_BOOTSTRAP_MARKER_KEY, data: { version: 1, complete: true }, timestamp: 24 },
                { key: LOCAL_LIBRARY_ARTIST_SPLIT_MARKER_KEY, data: { version: 1, complete: true }, timestamp: 25 },
            ],
            user_cache: [
                { key: 'user_profile', data: { syntheticId: 'offline-profile' }, timestamp: 26 },
                { key: 'user_liked_songs', data: ['offline-song'], timestamp: 27 },
            ],
            media_cache: [{ key: 'unclassified_media_record', data: { keep: true }, timestamp: 28 }],
            metadata_cache: [{ key: 'theme_1', data: { name: '手工主题', custom: true }, timestamp: 29 }],
        };
        for (const tableName of CACHE_TABLES) {
            const table = appDatabase.table<StoredCacheEntry, string>(tableName);
            await table.bulkPut(preservedByTable[tableName]);
            // 分类清除必须覆盖历史上写错表的记录，不能只检查今天的路由位置。
            await table.bulkPut(CATEGORY_KEYS.map(key => ({ key, data: { synthetic: true }, timestamp: 30 })));
            expect(await table.count()).toBe(preservedByTable[tableName].length + CATEGORY_KEYS.length);
        }
        const before = await readPreservedRecords();
        expect(before.songs).toEqual([song]);
        expect(before.assignments).toEqual([assignment]);
        expect(before.entities).toHaveLength(3);
        expect(await before.covers[0].blob!.arrayBuffer()).toEqual(await localCover.arrayBuffer());

        await clearAllCaches();
        appDatabase.close();
        await appDatabase.open();

        for (const tableName of CACHE_TABLES) {
            const table = appDatabase.table<StoredCacheEntry, string>(tableName);
            for (const key of CATEGORY_KEYS) {
                expect(await table.get(key), `${tableName}: ${key}`).toBeUndefined();
            }
            expect(await table.toArray()).toEqual(
                [...preservedByTable[tableName]].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
            );
        }
        const after = await readPreservedRecords();
        expect(after).toEqual(before);
        expect(after.covers[0].blob?.type).toBe(localCover.type);
        expect(after.covers[0].blob?.size).toBe(localCover.size);
        expect(await after.covers[0].blob!.arrayBuffer()).toEqual(await localCover.arrayBuffer());

        // 第二次清除也不能动保留记录，或因已经没有缓存而失败。
        await clearAllCaches();
        appDatabase.close();
        await appDatabase.open();
        const afterSecondClear = await readPreservedRecords();
        expect(afterSecondClear).toEqual(before);
        expect(await afterSecondClear.covers[0].blob!.arrayBuffer()).toEqual(await localCover.arrayBuffer());
        for (const tableName of CACHE_TABLES) {
            expect(await appDatabase.table(tableName).toArray()).toEqual(
                [...preservedByTable[tableName]].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
            );
        }
    });

    it('clears synthetic external media and cover caches without deleting canonical local-cover binaries', async () => {
        const localBinaries = new Map<string, { bytes: number[]; mimeType: string }>();
        const rebuildableCovers = new Map<string, number[]>();
        const audioCopies = new Set(['synthetic-audio']);
        const nativeAudioCopies = new Set(['synthetic-native-audio']);
        const clearLocalCoverAssets = vi.fn(async () => { localBinaries.clear(); });
        const removeLocalCoverAsset = vi.fn(async (id: string) => { localBinaries.delete(id); });
        const clearCoverCache = vi.fn(async () => { rebuildableCovers.clear(); });
        const clearAudioCache = vi.fn(async () => { audioCopies.clear(); });
        const clearMediaCache = vi.fn(async () => { nativeAudioCopies.clear(); });
        // 仅模拟进程边界；db、Dexie 与两种 binary store 的实现均保持真实。
        vi.stubGlobal('window', {
            electron: {
                hasLocalCoverAsset: async (id: string) => localBinaries.has(id),
                saveLocalCoverAsset: async (id: string, bytes: ArrayBuffer, mimeType: string) => {
                    localBinaries.set(id, { bytes: Array.from(new Uint8Array(bytes)), mimeType });
                },
                removeLocalCoverAsset,
                clearLocalCoverAssets,
                getCoverCache: async () => ({ found: false }),
                saveCoverCache: async (key: string, bytes: ArrayBuffer) => {
                    rebuildableCovers.set(key, Array.from(new Uint8Array(bytes)));
                },
                removeCoverCache: async (key: string) => { rebuildableCovers.delete(key); },
                clearCoverCache,
                getAudioCacheUsage: async () => audioCopies.size,
                clearAudioCache,
            },
            Capacitor: { Plugins: { FoliaNative: { clearMediaCache } } },
        });
        const localCover = new Blob([new Uint8Array([137, 80, 78, 71, 7, 8, 255])], { type: 'image/png' });
        expect(await writeLocalCoverBinary(LOCAL_COVER_ID, localCover)).toEqual({
            backend: 'electron', mimeType: localCover.type, size: localCover.size,
        });
        await appDatabase.local_cover_assets.put({
            id: LOCAL_COVER_ID, backend: 'electron', mimeType: localCover.type,
            size: localCover.size, createdAt: 31, migratedAt: 32,
        });
        expect(await writeCoverAsset('cover_1', new Blob(['rebuildable'], { type: 'image/png' }))).not.toBeNull();
        const expectedMetadata = await appDatabase.local_cover_assets.toArray();
        const expectedBinaries = Array.from(localBinaries.entries());
        expect(expectedBinaries).toHaveLength(1);
        expect(rebuildableCovers.size).toBe(1);

        await clearAllCaches();
        appDatabase.close();
        await appDatabase.open();

        expect(rebuildableCovers.size).toBe(0);
        expect(audioCopies.size).toBe(0);
        expect(nativeAudioCopies.size).toBe(0);
        expect(clearCoverCache).toHaveBeenCalled();
        expect(clearAudioCache).toHaveBeenCalled();
        expect(clearMediaCache).toHaveBeenCalled();
        expect(clearLocalCoverAssets).not.toHaveBeenCalled();
        expect(removeLocalCoverAsset).not.toHaveBeenCalled();
        expect(await hasLocalCoverBinary(LOCAL_COVER_ID)).toBe(true);
        expect(Array.from(localBinaries.entries())).toEqual(expectedBinaries);
        expect(await appDatabase.local_cover_assets.toArray()).toEqual(expectedMetadata);
    });
});
