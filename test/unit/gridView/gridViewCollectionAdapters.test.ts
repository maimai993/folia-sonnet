import { describe, expect, it } from 'vitest';
import {
    createLocalGridViewCollection,
    createNavidromeGridViewCollection,
    resolveLocalGridViewCoverSource,
    resolveLocalGridViewTracks,
} from '../../../src/components/app/home/gridViewCollectionAdapters';
import type { LocalLibraryGroup, LocalSong } from '../../../src/types';

// test/unit/gridView/gridViewCollectionAdapters.test.ts
// Verifies that GridView descriptors stay serializable and resolve local queues by id.

const buildLocalSong = (id: string, title: string): LocalSong => ({
    id,
    fileName: `${title}.mp3`,
    filePath: `/music/${title}.mp3`,
    title,
    artist: 'Artist',
    album: 'Album',
    duration: 180000,
    fileSize: 1024,
    mimeType: 'audio/mpeg',
    addedAt: 1,
});

describe('gridViewCollectionAdapters', () => {
    it('creates a local descriptor without embedding song objects', () => {
        const songs = [
            buildLocalSong('song-a', 'A'),
            buildLocalSong('song-b', 'B'),
        ];
        const group: LocalLibraryGroup = {
            id: 'folder-music',
            name: 'Music',
            type: 'folder',
            songs,
            coverUrl: 'blob:cover',
            trackCount: songs.length,
            description: 'Folder',
        };

        const descriptor = createLocalGridViewCollection(group);

        expect(descriptor).toEqual({
            source: 'local',
            id: 'folder-music',
            name: 'Music',
            type: 'folder',
            coverUrl: 'blob:cover',
            description: 'Folder',
            trackCount: 2,
            songIds: ['song-a', 'song-b'],
            playlistId: undefined,
            isVirtual: undefined,
        });
        expect('songs' in descriptor).toBe(false);
    });

    it('resolves local tracks from descriptor ids in descriptor order', () => {
        const songs = [
            buildLocalSong('song-a', 'A'),
            buildLocalSong('song-b', 'B'),
            buildLocalSong('song-c', 'C'),
        ];
        const descriptor = createLocalGridViewCollection({
            id: 'playlist-1',
            name: 'Ordered',
            type: 'playlist',
            songs: [songs[2], songs[0]],
        });

        const tracks = resolveLocalGridViewTracks(descriptor, songs);

        expect(tracks.map(track => (track as any).localData?.id)).toEqual(['song-c', 'song-a']);
        expect(tracks.every(track => (track as any).isLocal)).toBe(true);
    });

    it('ignores non-Blob embedded covers when resolving local collection covers', () => {
        const songs = [
            {
                ...buildLocalSong('song-a', 'A'),
                addedAt: 2,
                embeddedCover: { size: 20, type: 'image/png' } as unknown as Blob,
                matchedCoverUrl: 'https://example.com/a.jpg',
            },
            {
                ...buildLocalSong('song-b', 'B'),
                addedAt: 1,
            },
        ];
        const descriptor = createLocalGridViewCollection({
            id: 'folder-music',
            name: 'Music',
            type: 'folder',
            songs,
        });

        expect(resolveLocalGridViewCoverSource(descriptor, songs)).toBe('https://example.com/a.jpg');
    });

    it('prefers matched covers when online covers are enabled', () => {
        const embeddedCover = new Blob(['cover'], { type: 'image/png' });
        const songs = [
            {
                ...buildLocalSong('song-a', 'A'),
                embeddedCover,
                matchedCoverUrl: 'https://example.com/online.jpg',
                useOnlineCover: true,
            },
        ];
        const descriptor = createLocalGridViewCollection({
            id: 'folder-music',
            name: 'Music',
            type: 'folder',
            songs,
        });

        expect(resolveLocalGridViewCoverSource(descriptor, songs)).toBe('https://example.com/online.jpg');
    });

    it('returns no local cover source when only invalid embedded covers are available', () => {
        const songs = [
            {
                ...buildLocalSong('song-a', 'A'),
                embeddedCover: { size: 20, type: 'image/png' } as unknown as Blob,
            },
        ];
        const descriptor = createLocalGridViewCollection({
            id: 'folder-music',
            name: 'Music',
            type: 'folder',
            songs,
        });

        expect(resolveLocalGridViewCoverSource(descriptor, songs)).toBeUndefined();
    });

    it('creates Navidrome descriptors for every GridView collection type', () => {
        const baseItem = {
            id: 'navi-1',
            name: 'Navi Item',
            coverUrl: 'cover.jpg',
            description: 'Remote collection',
            trackCount: 12,
        };

        expect(createNavidromeGridViewCollection(baseItem, 'album')).toMatchObject({
            source: 'navidrome',
            id: 'navi-1',
            name: 'Navi Item',
            type: 'album',
        });
        const playlistItem = { ...baseItem, editable: true };
        expect(createNavidromeGridViewCollection(playlistItem, 'playlist')).toMatchObject({
            type: 'playlist',
            editable: true,
        });
        expect(createNavidromeGridViewCollection(baseItem, 'artist').type).toBe('artist');
        expect(createNavidromeGridViewCollection(baseItem, 'random').type).toBe('random');
        expect(createNavidromeGridViewCollection(baseItem, 'favorites').type).toBe('favorites');
    });
});
