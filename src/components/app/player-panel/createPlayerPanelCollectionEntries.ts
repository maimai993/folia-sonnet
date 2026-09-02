import type { TFunction } from 'i18next';
import type { LocalSong, SongResult } from '../../../types';
import type { LocalLibraryCatalogSnapshot } from '../../../hooks/useLocalLibraryCatalog';
import type { CollectionNavigationOrigin } from '../../../stores/useCollectionNavigationStore';
import type { GridViewCollectionDescriptor } from '../home/gridViewCollectionAdapters';
import { buildLocalLibraryIndex, followEntityRedirect } from '../../../utils/localLibraryIndex';
import { isLocalPlaybackSong } from '../../../utils/appPlaybackGuards';
import { getSongAlbumLabel, getSongArtistLabel, getSongCoverUrl } from '../../../services/onlineMusic/songMetadata';

// src/components/app/player-panel/createPlayerPanelCollectionEntries.ts
//
// The four "open what is playing in the grid" entries behind the player panel's title, artist and
// album. They lived inline in App.tsx as ~140 lines of closure inside the model's argument list,
// which is the one place in the app where nobody would look for them.

type PlayerPanelCollectionEntriesParams = {
    currentSong: SongResult | null;
    /** The displayed song, which during a blend is the held one - covers and labels must match it. */
    displaySong: SongResult | null;
    localSongs: LocalSong[];
    localLibraryCatalog: LocalLibraryCatalogSnapshot;
    navigateToCollection: (
        collection: GridViewCollectionDescriptor,
        origin: CollectionNavigationOrigin,
    ) => void;
    t: TFunction;
};

export type PlayerPanelCollectionEntries = {
    openCurrentLocalAlbum: () => void;
    openCurrentLocalArtist: (requestedEntityId?: string) => void;
    openCurrentNavidromeAlbum: () => void;
    openCurrentNavidromeArtist: () => void;
};

export const createPlayerPanelCollectionEntries = ({
    currentSong,
    displaySong,
    localSongs,
    localLibraryCatalog,
    navigateToCollection,
    t,
}: PlayerPanelCollectionEntriesParams): PlayerPanelCollectionEntries => {
    const openCurrentLocalAlbum = () => {
        if (currentSong && isLocalPlaybackSong(currentSong)) {
            const catalogIndex = buildLocalLibraryIndex(
                localLibraryCatalog.entities,
                localLibraryCatalog.assignments,
            );
            const assignment = catalogIndex.assignmentsBySongId.get(currentSong.localRef.songId);
            const albumEntityId = assignment?.albumEntityId
                ? followEntityRedirect(assignment.albumEntityId, catalogIndex.entitiesById)
                : undefined;
            const albumEntity = albumEntityId
                ? catalogIndex.entitiesById.get(albumEntityId)
                : undefined;
            if (albumEntity?.kind === 'album') {
                const memberIds = new Set(localLibraryCatalog.assignments
                    .filter(item => item.albumEntityId && (
                        followEntityRedirect(item.albumEntityId, catalogIndex.entitiesById) === albumEntity.id
                    ))
                    .map(item => item.songId));
                const songs = localSongs.filter(song => memberIds.has(song.id));
                if (songs.length > 0) {
                    navigateToCollection({
                        source: 'local',
                        id: albumEntity.id,
                        entityId: albumEntity.id,
                        name: albumEntity.displayName,
                        type: 'album',
                        coverUrl: getSongCoverUrl(displaySong),
                        description: getSongArtistLabel(displaySong),
                        trackCount: songs.length,
                        songIds: songs.map(song => song.id),
                    }, 'player');
                }
            }
        }
    };

    const openCurrentLocalArtist = (requestedEntityId?: string) => {
        if (currentSong && isLocalPlaybackSong(currentSong)) {
            const catalogIndex = buildLocalLibraryIndex(
                localLibraryCatalog.entities,
                localLibraryCatalog.assignments,
            );
            const assignment = catalogIndex.assignmentsBySongId.get(currentSong.localRef.songId);
            const sourceEntityId = requestedEntityId || assignment?.artistEntityIds[0];
            const artistEntityId = sourceEntityId
                ? followEntityRedirect(sourceEntityId, catalogIndex.entitiesById)
                : undefined;
            const artistEntity = artistEntityId
                ? catalogIndex.entitiesById.get(artistEntityId)
                : undefined;
            if (artistEntity?.kind === 'artist') {
                const memberIds = new Set(localLibraryCatalog.assignments
                    .filter(item => item.artistEntityIds.some(entityId => (
                        followEntityRedirect(entityId, catalogIndex.entitiesById) === artistEntity.id
                    )))
                    .map(item => item.songId));
                const songs = localSongs.filter(song => memberIds.has(song.id));
                if (songs.length > 0) {
                    navigateToCollection({
                        source: 'local',
                        id: artistEntity.id,
                        entityId: artistEntity.id,
                        name: artistEntity.displayName,
                        type: 'artist',
                        coverUrl: getSongCoverUrl(currentSong),
                        description: `${songs.length} ${t('home.songs')}`,
                        trackCount: songs.length,
                        songIds: songs.map(song => song.id),
                    }, 'player');
                }
            }
        }
    };

    const openCurrentNavidromeAlbum = () => {
        const currentNavidromeSong = (currentSong as any)?.navidromeData;
        const playbackCarrier = currentNavidromeSong?.navidromeData;
        const albumId = currentNavidromeSong?.albumId || playbackCarrier?.albumId;
        if (albumId) {
            const albumName = getSongAlbumLabel(currentSong) || t('localMusic.unknownAlbum');
            navigateToCollection({
                source: 'navidrome',
                id: albumId,
                name: albumName,
                type: 'album',
                coverUrl: getSongCoverUrl(currentSong),
            }, 'player');
        }
    };

    const openCurrentNavidromeArtist = () => {
        const currentNavidromeSong = (currentSong as any)?.navidromeData;
        const playbackCarrier = currentNavidromeSong?.navidromeData;
        const artistId = currentNavidromeSong?.artistId || playbackCarrier?.artistId;
        if (artistId) {
            const artistName = getSongArtistLabel(currentSong).split(',')[0]?.trim() || t('localMusic.unknownArtist');
            navigateToCollection({
                source: 'navidrome',
                id: artistId,
                name: artistName,
                type: 'artist',
                coverUrl: getSongCoverUrl(currentSong),
            }, 'player');
        }
    };

    return {
        openCurrentLocalAlbum,
        openCurrentLocalArtist,
        openCurrentNavidromeAlbum,
        openCurrentNavidromeArtist,
    };
};
