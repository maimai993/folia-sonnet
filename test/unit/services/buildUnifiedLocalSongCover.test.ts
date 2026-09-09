import { describe, expect, it } from 'vitest';
import { buildUnifiedLocalSong } from '../../../src/services/playbackAdapters';
import { getSongCoverUrl } from '../../../src/services/onlineMusic/songMetadata';
import type { LocalSong } from '../../../src/types';

// test/unit/services/buildUnifiedLocalSongCover.test.ts
// Verifies an untagged album never drops the resolved cover, which queue-derived surfaces
// (Lattice posters, panel collection entries) read only through `album.coverUrl`.

const coverUrl = `folia-cover://asset/sha256:${'a'.repeat(64)}`;

const localSong = (patch: Partial<LocalSong> = {}): LocalSong => ({
    id: 'song',
    fileName: 'song.mp3',
    filePath: 'Music/song.mp3',
    title: '如愿',
    titleOrigin: 'import',
    importedMetadata: { title: '如愿', titleSource: 'embedded', artistNames: ['洋澜一'] },
    duration: 1,
    fileSize: 1,
    mimeType: 'audio/mpeg',
    addedAt: 1,
    ...patch,
});

describe('buildUnifiedLocalSong cover', () => {
    it('keeps the cover on a file that has artwork but no album tag', () => {
        const unified = buildUnifiedLocalSong({
            localSong: localSong(),
            matchedSong: null,
            coverUrl,
            preferOnlineMetadata: false,
        });

        expect(unified.album?.name).toBe('');
        expect(unified.album?.coverUrl).toBe(coverUrl);
        expect(getSongCoverUrl(unified)).toBe(coverUrl);
    });

    it('keeps the cover alongside a present album name', () => {
        const unified = buildUnifiedLocalSong({
            localSong: localSong({
                importedMetadata: { title: '如愿', titleSource: 'embedded', artistNames: ['洋澜一'], albumName: '如愿' },
            }),
            matchedSong: null,
            coverUrl,
            preferOnlineMetadata: false,
        });

        expect(unified.album?.name).toBe('如愿');
        expect(unified.album?.coverUrl).toBe(coverUrl);
    });

    it('leaves the cover field absent when nothing resolved', () => {
        const unified = buildUnifiedLocalSong({
            localSong: localSong(),
            matchedSong: null,
            coverUrl: null,
            preferOnlineMetadata: false,
        });

        expect(unified.album?.coverUrl).toBeUndefined();
    });
});
