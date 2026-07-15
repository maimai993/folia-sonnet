import { describe, expect, it } from 'vitest';
import type { LocalSong } from '@/types';
import { buildLocalSongLyricMatchContext, shouldRefreshLocalSongLyricsFromMetadata, shouldRunLocalSongAutomaticMatch } from '@/utils/lyrics/localSongMatchContext';

// test/unit/lyrics/localSongMatchContext.test.ts

const song = (patch: Partial<LocalSong> = {}): LocalSong => ({
    id: 'local-song',
    fileName: 'wrong-file-name.flac',
    filePath: 'Library/wrong-file-name.flac',
    title: 'Wrong title',
    artist: 'Wrong artist',
    album: 'Wrong album',
    duration: 200000,
    fileSize: 1,
    mimeType: 'audio/flac',
    addedAt: 1,
    ...patch,
});

describe('localSongMatchContext', () => {
    it('uses the selected online identity and metadata for lyric matching', () => {
        const context = buildLocalSongLyricMatchContext(song({
            useOnlineMetadata: true,
            matchedMetadataSource: 'qq',
            matchedMetadataSongId: 'selected-mid',
            matchedTitle: 'Correct title',
            matchedArtists: 'Correct artist',
            matchedAlbumName: 'Correct album',
        }));

        expect(context).toEqual({
            title: 'Correct title',
            artist: 'Correct artist',
            album: 'Correct album',
            durationMs: 200000,
            metadataCandidate: { source: 'qq', songId: 'selected-mid' },
        });
    });

    it('does not use a stored candidate when online metadata is disabled', () => {
        const context = buildLocalSongLyricMatchContext(song({
            useOnlineMetadata: false,
            matchedMetadataSource: 'netease',
            matchedMetadataSongId: 321,
            matchedTitle: 'Ignored online title',
        }));

        expect(context.title).toBe('Wrong title');
        expect(context.metadataCandidate).toBeUndefined();
    });

    it('lets an explicit metadata selection bypass a stale no-auto-match flag', () => {
        expect(shouldRunLocalSongAutomaticMatch(song({ noAutoMatch: true }))).toBe(false);
        expect(shouldRunLocalSongAutomaticMatch(song({
            noAutoMatch: true,
            useOnlineMetadata: true,
            matchedMetadataSource: 'netease',
            matchedMetadataSongId: 321,
        }))).toBe(true);
    });

    it('refreshes a legacy automatic lyric result once but preserves manual lyrics', () => {
        const selectedMetadata = {
            useOnlineMetadata: true,
            matchedMetadataSource: 'netease' as const,
            matchedMetadataSongId: 321,
            matchedLyrics: { lines: [], isWordByWord: true },
        };
        expect(shouldRefreshLocalSongLyricsFromMetadata(song(selectedMetadata))).toBe(true);
        expect(shouldRefreshLocalSongLyricsFromMetadata(song({
            ...selectedMetadata,
            matchedLyricsSongId: 321,
        }))).toBe(false);
        expect(shouldRefreshLocalSongLyricsFromMetadata(song({
            ...selectedMetadata,
            hasManualLyricSelection: true,
        }))).toBe(false);
    });
});
