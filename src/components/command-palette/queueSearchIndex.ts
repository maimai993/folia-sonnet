import type { SongResult } from '../../types';
import { getProviderSongMetadata } from '../../services/onlineMusic/songMetadata';
import type { ProviderSongMetadata } from '../../types/onlineMusic';
import { getPlaybackSongKey, getPlaybackSourceRef } from '../../utils/appPlaybackGuards';
import type { QueueFacetKind } from './queueQuery';

// src/components/command-palette/queueSearchIndex.ts
// Precomputes normalized queue text and stable artist/album facets when the queue changes.

export type QueueFacet = {
    kind: QueueFacetKind;
    key: string;
    label: string;
    normalizedLabel: string;
};

export type QueueSearchEntry = {
    song: SongResult;
    queueIndex: number;
    searchText: string;
    facets: QueueFacet[];
};

export const normalizeQueueSearchText = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');

const getSourceScope = (song: SongResult) => {
    const sourceRef = getPlaybackSourceRef(song);
    return sourceRef.kind === 'online' ? `online:${sourceRef.providerId}` : sourceRef.kind;
};

const createFacetKey = (
    song: SongResult,
    kind: QueueFacetKind,
    id: string | number | undefined,
    entityId: string | undefined,
    label: string,
) => `${kind}:${entityId || `${getSourceScope(song)}:${String(id ?? normalizeQueueSearchText(label))}`}`;

export const getSongQueueFacets = (song: SongResult, providedMetadata?: ProviderSongMetadata): QueueFacet[] => {
    const metadata = providedMetadata ?? getProviderSongMetadata(song);
    const artistFacets = metadata.artists
        .filter(artist => Boolean(artist.name))
        .map(artist => ({
            kind: 'artist' as const,
            key: createFacetKey(song, 'artist', artist.id, artist.entityId, artist.name),
            label: artist.name,
            normalizedLabel: normalizeQueueSearchText(artist.name),
        }));
    const album = metadata.album;
    const albumFacet = album?.name
        ? [{
            kind: 'album' as const,
            key: createFacetKey(song, 'album', album.id, album.entityId, album.name),
            label: album.name,
            normalizedLabel: normalizeQueueSearchText(album.name),
        }]
        : [];

    return [...artistFacets, ...albumFacet];
};

export const buildQueueSearchIndex = (queue: SongResult[]): QueueSearchEntry[] => queue.map((song, queueIndex) => {
    const metadata = getProviderSongMetadata(song);
    return {
        song,
        queueIndex,
        facets: getSongQueueFacets(song, metadata),
        searchText: normalizeQueueSearchText([
            String(queueIndex + 1),
            song.name,
            ...metadata.artists.map(artist => artist.name),
            metadata.album?.name,
            ...metadata.aliases,
            ...metadata.translatedNames,
        ].filter(Boolean).join(' ')),
    };
});

export const getCurrentQueueIndex = (index: QueueSearchEntry[], currentSong: SongResult | null) => {
    if (!currentSong) return -1;
    const exactIndex = index.findIndex(entry => entry.song === currentSong);
    if (exactIndex >= 0) return index[exactIndex].queueIndex;
    const currentKey = getPlaybackSongKey(currentSong);
    return index.find(entry => getPlaybackSongKey(entry.song) === currentKey)?.queueIndex ?? -1;
};
