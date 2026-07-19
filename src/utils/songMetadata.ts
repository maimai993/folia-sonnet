import type { SongResult } from '../types';
import type { ProviderSongMetadata } from '../types/onlineMusic';

// src/utils/songMetadata.ts

export const getSongAlbumCoverUrl = (song?: Pick<SongResult, 'album'> | null): string | undefined => {
    const coverUrl = song?.album?.coverUrl || song?.album?.picUrl;
    return typeof coverUrl === 'string' && coverUrl ? coverUrl : undefined;
};

// Builds provider-neutral song metadata after a provider has normalized its response.
export const createProviderSongMetadata = (song: SongResult): ProviderSongMetadata => ({
    artists: Array.isArray(song.artists) ? song.artists : [],
    album: song.album
        ? {
            id: song.album.id,
            name: song.album.name,
            ...(song.album.coverUrl ? { coverUrl: song.album.coverUrl } : {}),
            ...(song.album.entityId ? { entityId: song.album.entityId } : {}),
            ...(song.album.catalogRef ? { catalogRef: song.album.catalogRef } : {}),
        }
        : { id: 0, name: '' },
    durationMs: Number.isFinite(song.duration) ? song.duration : 0,
    coverUrl: typeof song.album?.coverUrl === 'string' && song.album.coverUrl
        ? song.album.coverUrl
        : undefined,
    aliases: Array.isArray(song.aliases) ? song.aliases : [],
    translatedNames: Array.isArray(song.translatedNames) ? song.translatedNames : [],
});
