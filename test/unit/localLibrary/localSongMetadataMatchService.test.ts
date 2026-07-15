import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalSong } from '@/types';
import { applyMatchedMetadata, restoreImportedMetadata } from '@/services/localLibraryCatalogService';
import { cacheLocalSongOnlineCover } from '@/services/coverCache';
import { findAutomaticOnlineMetadataCandidate } from '@/services/onlineMetadataSearchService';
import {
    applyOnlineMetadataCandidate,
    batchAutoMatchLocalSongMetadata,
} from '@/services/localSongMetadataMatchService';

// test/unit/localLibrary/localSongMetadataMatchService.test.ts
// Covers cover policy, protected batch writes, skip behavior, and two-worker concurrency.

vi.mock('@/services/localLibraryCatalogService', () => ({
    applyMatchedMetadata: vi.fn(),
    restoreImportedMetadata: vi.fn(),
}));
vi.mock('@/services/coverCache', () => ({ cacheLocalSongOnlineCover: vi.fn() }));
vi.mock('@/services/onlineMetadataSearchService', () => ({ findAutomaticOnlineMetadataCandidate: vi.fn() }));

const song = (id: string, patch: Partial<LocalSong> = {}): LocalSong => ({
    id,
    fileName: `${id}.flac`,
    filePath: `Library/${id}.flac`,
    duration: 1,
    fileSize: 1,
    mimeType: 'audio/flac',
    addedAt: 1,
    ...patch,
});

const candidate = {
    source: 'qq' as const,
    songId: 'qq-mid',
    title: 'Song',
    artists: [{ name: 'Artist' }],
    album: { id: 'album-id', name: 'Album' },
    coverUrl: 'https://example.test/cover.jpg',
    durationMs: 1,
    score: 90,
    titleMatched: true,
    raw: {
        id: 1,
        name: 'Song',
        artists: [{ id: 2, name: 'Artist' }],
        album: { id: 3, name: 'Album' },
        duration: 1,
    },
};

describe('localSongMetadataMatchService', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.mocked(applyMatchedMetadata).mockResolvedValue(song('stored'));
        vi.mocked(restoreImportedMetadata).mockResolvedValue(song('restored'));
        vi.mocked(cacheLocalSongOnlineCover).mockResolvedValue(true);
    });

    it('fills and caches a missing automatic cover while protecting manual origins', async () => {
        await applyOnlineMetadataCandidate(song('one'), candidate, { mode: 'automatic', protectOrigins: ['manual', 'split'] });
        expect(applyMatchedMetadata).toHaveBeenCalledWith('one', expect.objectContaining({
            source: 'qq', title: 'Song', coverUrl: candidate.coverUrl,
        }), expect.objectContaining({
            songPatch: expect.objectContaining({
                matchedMetadataSource: 'qq',
                matchedMetadataSongId: 'qq-mid',
                matchedMetadataAlbumId: 'album-id',
                matchedCoverUrl: candidate.coverUrl,
                useOnlineMetadata: true,
                useOnlineCover: true,
            }),
            protectOrigins: ['manual', 'split'],
        }));
        expect(cacheLocalSongOnlineCover).toHaveBeenCalledWith('one', candidate.coverUrl);
    });

    it('stores but does not enable or cache an automatic cover over an embedded cover', async () => {
        await applyOnlineMetadataCandidate(song('embedded', { embeddedCover: new Blob(['cover']) }), candidate, { mode: 'automatic' });
        expect(applyMatchedMetadata).toHaveBeenCalledWith('embedded', expect.objectContaining({ coverUrl: candidate.coverUrl }), expect.objectContaining({
            songPatch: expect.objectContaining({ matchedCoverUrl: candidate.coverUrl, useOnlineCover: false }),
        }));
        expect(cacheLocalSongOnlineCover).not.toHaveBeenCalled();
    });

    it('applies artist and album together while leaving the online cover disabled', async () => {
        await applyOnlineMetadataCandidate(song('manual'), candidate, {
            mode: 'manual',
            useOnlineMetadata: true,
            useOnlineCover: false,
        });
        expect(applyMatchedMetadata).toHaveBeenCalledWith('manual', expect.objectContaining({
            artists: candidate.artists,
            album: candidate.album,
            coverUrl: candidate.coverUrl,
        }), expect.objectContaining({
            songPatch: expect.objectContaining({
                matchedTitle: 'Song',
                matchedArtists: 'Artist',
                matchedAlbumName: 'Album',
                matchedCoverUrl: candidate.coverUrl,
                useOnlineMetadata: true,
                useOnlineCover: false,
            }),
        }));
        expect(restoreImportedMetadata).not.toHaveBeenCalled();
        expect(cacheLocalSongOnlineCover).not.toHaveBeenCalled();
    });

    it('invalidates an automatic lyric result when the selected metadata identity changes', async () => {
        await applyOnlineMetadataCandidate(song('rematch', {
            matchedMetadataSource: 'netease',
            matchedMetadataSongId: 123,
            matchedLyrics: { lines: [], isWordByWord: true },
            matchedLyricsSongId: 123,
            matchedLyricsSource: 'netease',
            matchedIsPureMusic: true,
        }), candidate, {
            mode: 'manual',
            useOnlineMetadata: true,
            useOnlineCover: false,
        });

        expect(applyMatchedMetadata).toHaveBeenCalledWith('rematch', expect.anything(), expect.objectContaining({
            songPatch: expect.objectContaining({
                matchedMetadataSource: 'qq',
                matchedMetadataSongId: 'qq-mid',
                matchedLyrics: undefined,
                matchedLyricsSongId: undefined,
                matchedLyricsSource: undefined,
                matchedIsPureMusic: undefined,
            }),
        }));
    });

    it('keeps a lyric result that the user selected explicitly', async () => {
        const manualLyrics = { lines: [], isWordByWord: true };
        await applyOnlineMetadataCandidate(song('manual-lyrics', {
            matchedMetadataSource: 'netease',
            matchedMetadataSongId: 123,
            matchedLyrics: manualLyrics,
            matchedLyricsSongId: 123,
            matchedLyricsSource: 'netease',
            hasManualLyricSelection: true,
        }), candidate, {
            mode: 'manual',
            useOnlineMetadata: true,
            useOnlineCover: false,
        });

        const options = vi.mocked(applyMatchedMetadata).mock.calls[0][2];
        expect(options?.songPatch).not.toHaveProperty('matchedLyrics');
        expect(options?.songPatch).not.toHaveProperty('matchedLyricsSongId');
    });

    it('keeps imported metadata while enabling and caching the selected cover', async () => {
        const result = await applyOnlineMetadataCandidate(song('cover-only'), candidate, {
            mode: 'manual',
            useOnlineMetadata: false,
            useOnlineCover: true,
        });
        expect(applyMatchedMetadata).toHaveBeenCalledWith('cover-only', {}, expect.objectContaining({
            lyricsOnly: true,
            songPatch: expect.objectContaining({
                matchedTitle: 'Song',
                matchedArtists: 'Artist',
                matchedAlbumName: 'Album',
                matchedCoverUrl: candidate.coverUrl,
                useOnlineMetadata: false,
                useOnlineCover: true,
            }),
        }));
        expect(restoreImportedMetadata).toHaveBeenCalledWith('cover-only');
        expect(cacheLocalSongOnlineCover).toHaveBeenCalledWith('cover-only', candidate.coverUrl);
        expect(result.song?.id).toBe('restored');
    });

    it('skips noAutoMatch songs and never exceeds two searches', async () => {
        let active = 0;
        let maxActive = 0;
        vi.mocked(findAutomaticOnlineMetadataCandidate).mockImplementation(async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise(resolve => setTimeout(resolve, 5));
            active -= 1;
            return candidate;
        });
        const result = await batchAutoMatchLocalSongMetadata([
            song('skip', { noAutoMatch: true }), song('one'), song('two'), song('three'),
        ]);
        expect(maxActive).toBe(2);
        expect(result.updates.find(update => update.songId === 'skip')?.status).toBe('skipped');
        expect(findAutomaticOnlineMetadataCandidate).toHaveBeenCalledTimes(3);
    });

    it('stops before applying an in-flight result after cancellation', async () => {
        const controller = new AbortController();
        vi.mocked(findAutomaticOnlineMetadataCandidate).mockImplementation(async () => {
            controller.abort();
            return candidate;
        });
        const result = await batchAutoMatchLocalSongMetadata([song('cancelled')], { signal: controller.signal });
        expect(result.cancelled).toBe(true);
        expect(applyMatchedMetadata).not.toHaveBeenCalled();
    });
});
