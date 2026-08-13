import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import GridView, { GridViewSourceActions } from '../../GridView';
import ArtistGridView from '../../ArtistGridView';
import { useSettingsUiStore } from '../../../stores/useSettingsUiStore';
import { getActiveGridViewCollection, useCollectionNavigationStore } from '../../../stores/useCollectionNavigationStore';
import { LocalSong, SongResult, UnifiedSong } from '../../../types';
import { resolveNavidromePlaybackCarrier } from '../../../utils/appPlaybackGuards';
import { deleteFolderSongs, resyncAllFolders, resyncFolder } from '../../../services/localMusicService';
import { deleteLocalPlaylist, removeSongsFromLocalPlaylist, updateLocalPlaylist } from '../../../services/localPlaylistService';
import { downloadLocalPlaylistM3u8 } from '../../../services/localPlaylistFileService';
import { getNavidromeConfig, navidromeApi } from '../../../services/navidromeService';
import { getLocalCoverAssetUrl } from '../../../services/localCoverAssetUrl';
import {
    GridViewCollectionDescriptor,
    LocalGridViewCollectionDescriptor,
    isLocalGridViewCollection,
    isNavidromeGridViewCollection,
    refreshLocalGridViewCollection,
    resolveLocalAlbumArtistDisplay,
    resolveLocalGridViewTracks,
    resolveNavidromeGridViewTracks,
} from './gridViewCollectionAdapters';
import type { LocalLibraryCatalogSnapshot } from '../../../hooks/useLocalLibraryCatalog';
import { LocalLibraryEntityPanel } from '../../modal/LocalLibraryEntityPanel';
import { LocalFolderSongInfoPanel } from '../../modal/LocalFolderSongInfoPanel';
import { LocalSongMetadataMatchDialog } from '../../modal/LocalSongMetadataMatchDialog';
import { buildLocalLibraryIndex, followEntityRedirect } from '../../../utils/localLibraryIndex';
import { applyLocalSongCoverDisplay } from '../../../services/playbackAdapters';
import { resolveSongCatalogRef } from '../../../services/onlineMusic/catalogRefs';
import type { HomeSurfaceProps } from './homeSurfaceTypes';

// src/components/app/home/GridViewOverlayHost.tsx
// Hosts the GridView overlay outside Grid3D so it can be opened/restored independently.

type GridViewOverlayHostProps = {
    surfaceProps: HomeSurfaceProps;
    onOpenCollection: (collection: GridViewCollectionDescriptor) => void;
    onPushCollection: (collection: GridViewCollectionDescriptor) => void;
    onBackCollection: () => void;
    isInteractive?: boolean;
    children: (
        openGridView: (collection: GridViewCollectionDescriptor) => void,
        isHomeGridInteractive: boolean,
    ) => React.ReactNode;
};

const getPersistentCoverUrl = (url?: string) => (
    url && !url.startsWith('blob:') ? url : undefined
);

const resolveLocalCollectionCoverUrlFromTracks = (
    tracks: UnifiedSong[],
    localSongs: LocalSong[],
): string | undefined => {
    const songsById = new Map(localSongs.map(song => [song.id, song]));
    const songs = tracks
        .map(track => track.localRef ? songsById.get(track.localRef.songId) : undefined)
        .filter((song): song is LocalSong => Boolean(song))
        .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    const preferredSong = songs.find(song => {
        const hasEmbeddedCover = Boolean(getLocalCoverAssetUrl(song.localCoverAssetId));
        if (song.useOnlineCover) {
            return song.onlineMetadata?.coverUrl || hasEmbeddedCover;
        }
        return hasEmbeddedCover || song.onlineMetadata?.coverUrl;
    });

    if (!preferredSong) {
        return undefined;
    }

    if (preferredSong.useOnlineCover && preferredSong.onlineMetadata?.coverUrl) {
        return preferredSong.onlineMetadata.coverUrl;
    }

    const localCoverUrl = getLocalCoverAssetUrl(preferredSong.localCoverAssetId, 512);
    if (localCoverUrl) return localCoverUrl;

    return preferredSong.onlineMetadata?.coverUrl;
};

const resolveLiveLocalCollection = (
    collection: LocalGridViewCollectionDescriptor,
    surfaceProps: HomeSurfaceProps,
    catalog: LocalLibraryCatalogSnapshot,
): LocalGridViewCollectionDescriptor | null => {
    if (!collection.playlistId) {
        return refreshLocalGridViewCollection(
            collection,
            surfaceProps.localSongs,
            catalog.ready ? catalog : undefined,
        );
    }

    const playlist = surfaceProps.localPlaylists.find(item => item.id === collection.playlistId);
    if (!playlist) {
        return null;
    }

    const validSongIds = new Set(surfaceProps.localSongs.map(song => song.id));
    const songIds = playlist.songIds.filter(songId => validSongIds.has(songId));

    return {
        ...collection,
        name: playlist.name,
        songIds,
        trackCount: songIds.length,
        isVirtual: playlist.isFavorite,
    };
};

const GridViewOverlayHost: React.FC<GridViewOverlayHostProps> = ({
    surfaceProps,
    onOpenCollection,
    onPushCollection,
    onBackCollection,
    isInteractive = true,
    children,
}) => {
    const { t } = useTranslation();
    const collectionSnapshot = useCollectionNavigationStore(state => state.snapshot);
    const isDaylight = useSettingsUiStore(state => state.isDaylight);
    const localLibraryCatalog = surfaceProps.localLibraryCatalog;
    const selectedCollection = getActiveGridViewCollection(collectionSnapshot);
    const [externalTracks, setExternalTracks] = useState<SongResult[] | undefined>(undefined);
    const [externalTracksLoading, setExternalTracksLoading] = useState(false);
    const [resolvedLocalCollectionCoverUrl, setResolvedLocalCollectionCoverUrl] = useState<string | undefined>(undefined);
    const [navidromePlaylistItems, setNavidromePlaylistItems] = useState<Array<{ id: string | number; name: string; description?: string; }>>([]);
    const [editingEntityId, setEditingEntityId] = useState<string | null>(null);
    const [organizingFolder, setOrganizingFolder] = useState<LocalGridViewCollectionDescriptor | null>(null);
    const [matchingSongId, setMatchingSongId] = useState<string | null>(null);
    const selectedCollectionKey = selectedCollection
        ? `${selectedCollection.source}:${selectedCollection.type}:${String(selectedCollection.id)}`
        : '';
    const liveSelectedCollection = useMemo(() => {
        if (!selectedCollection || !isLocalGridViewCollection(selectedCollection)) {
            if (selectedCollection?.source !== 'online') return selectedCollection;

            const refreshed = surfaceProps.playlists.find(collection => (
                collection.providerId === selectedCollection.providerId
                && String(collection.id) === String(selectedCollection.id)
            ));
            return refreshed
                ? { ...selectedCollection, ...refreshed, source: 'online' as const, providerId: selectedCollection.providerId }
                : selectedCollection;
        }

        return resolveLiveLocalCollection(selectedCollection, surfaceProps, localLibraryCatalog);
    }, [surfaceProps.localPlaylists, surfaceProps.localSongs, surfaceProps.playlists, localLibraryCatalog, selectedCollection]);
    const displaySelectedCollection = useMemo(() => {
        if (!liveSelectedCollection) {
            return null;
        }

        if (!isLocalGridViewCollection(liveSelectedCollection)) {
            return liveSelectedCollection;
        }

        const coverUrl = resolvedLocalCollectionCoverUrl
            || getPersistentCoverUrl(liveSelectedCollection.coverUrl);

        return {
            ...liveSelectedCollection,
            coverUrl,
        };
    }, [liveSelectedCollection, resolvedLocalCollectionCoverUrl]);

    const openGridView = useCallback((collection: GridViewCollectionDescriptor) => {
        onOpenCollection(collection);
    }, [onOpenCollection]);

    const handlePushCollection = useCallback((col: GridViewCollectionDescriptor) => {
        onPushCollection(col);
    }, [onPushCollection]);

    const handleBackCollection = useCallback(() => {
        onBackCollection();
    }, [onBackCollection]);

    useEffect(() => {
        if (
            localLibraryCatalog.ready &&
            selectedCollection &&
            isLocalGridViewCollection(selectedCollection) &&
            selectedCollection.entityId &&
            liveSelectedCollection &&
            isLocalGridViewCollection(liveSelectedCollection) &&
            liveSelectedCollection.trackCount === 0
        ) {
            handleBackCollection();
        }
    }, [handleBackCollection, liveSelectedCollection, localLibraryCatalog.ready, selectedCollection]);

    const showCatalogUnavailable = useCallback(() => {
        surfaceProps.onStatusMessage?.({ type: 'error', text: t('search.catalogUnavailable') });
    }, [surfaceProps, t]);

    const handlePushAlbumCollection = useCallback(async (
        albumId: number | string,
        album?: any,
        track?: SongResult,
    ) => {
        if (!selectedCollection) return;

        const source = selectedCollection.source;
        const albumName = album?.name || '';
        const albumCoverUrl = album?.coverUrl;
        if (source === 'online') {
            let resolvedAlbumId = albumId;
            if (track) {
                try {
                    const ref = await resolveSongCatalogRef(track as UnifiedSong, 'album', {
                        id: albumId,
                        name: albumName,
                        coverUrl: albumCoverUrl,
                        catalogRef: album?.catalogRef,
                    });
                    if (!ref) {
                        showCatalogUnavailable();
                        return;
                    }
                    resolvedAlbumId = ref.id;
                } catch (error) {
                    console.warn('[CatalogNavigation] Failed to resolve nested album:', error);
                    showCatalogUnavailable();
                    return;
                }
            }
            handlePushCollection({
                ...(album && typeof album === 'object' ? album : {}),
                source: 'online',
                providerId: selectedCollection.providerId,
                id: resolvedAlbumId,
                name: albumName,
                type: 'album',
                coverUrl: albumCoverUrl,
            });
        } else if (source === 'navidrome') {
            handlePushCollection({
                source: 'navidrome',
                id: String(albumId),
                name: albumName,
                type: 'album',
                coverUrl: albumCoverUrl,
            });
        } else if (source === 'local') {
            const catalogIndex = buildLocalLibraryIndex(
                localLibraryCatalog.entities,
                localLibraryCatalog.assignments,
            );
            const activeEntityId = followEntityRedirect(String(albumId), catalogIndex.entitiesById);
            const localAlbumEntity = activeEntityId
                ? catalogIndex.entitiesById.get(activeEntityId)
                : localLibraryCatalog.entities.find(entity => (
                    entity.kind === 'album' && !entity.mergedInto && entity.displayName === album?.name
                ));
            if (localAlbumEntity?.kind !== 'album') return;
            const selectedAlbumSourceId = selectedCollection.entityId
                || (selectedCollection.type === 'album' ? String(selectedCollection.id) : undefined);
            const selectedAlbumEntityId = selectedAlbumSourceId
                ? followEntityRedirect(selectedAlbumSourceId, catalogIndex.entitiesById)
                : undefined;
            if (selectedCollection.type === 'album' && selectedAlbumEntityId === localAlbumEntity.id) {
                return;
            }
            const localAlbumName = localAlbumEntity.displayName;
            const localCoverUrl = albumCoverUrl;
            const memberIds = new Set(localLibraryCatalog.assignments
                .filter(assignment => assignment.albumEntityId && (
                    followEntityRedirect(assignment.albumEntityId, catalogIndex.entitiesById) === localAlbumEntity.id
                ))
                .map(assignment => assignment.songId));
            const albumSongs = surfaceProps.localSongs.filter(song => memberIds.has(song.id));
            const albumArtist = resolveLocalAlbumArtistDisplay(
                albumSongs.map(song => song.id),
                localLibraryCatalog,
            );
            handlePushCollection({
                source: 'local',
                id: localAlbumEntity.id,
                entityId: localAlbumEntity.id,
                name: localAlbumName,
                type: 'album',
                coverUrl: localCoverUrl,
                description: albumArtist,
                albumArtist,
                songIds: albumSongs.map(song => song.id),
            });
        }
    }, [handlePushCollection, surfaceProps.localSongs, localLibraryCatalog, selectedCollection, showCatalogUnavailable]);

    const handlePushArtistCollection = useCallback(async (
        artistId: number | string,
        artist?: any,
        track?: SongResult,
    ) => {
        if (!selectedCollection) return;

        const source = selectedCollection.source;
        const artistName = artist?.name || String(artistId);
        if (source === 'online') {
            let resolvedArtistId = artistId;
            if (track) {
                try {
                    const ref = await resolveSongCatalogRef(track as UnifiedSong, 'artist', {
                        id: artistId,
                        name: artistName,
                        catalogRef: artist?.catalogRef,
                    });
                    if (!ref) {
                        showCatalogUnavailable();
                        return;
                    }
                    resolvedArtistId = ref.id;
                } catch (error) {
                    console.warn('[CatalogNavigation] Failed to resolve nested artist:', error);
                    showCatalogUnavailable();
                    return;
                }
            }
            handlePushCollection({
                source: 'online',
                providerId: selectedCollection.providerId,
                id: resolvedArtistId,
                name: artistName,
                type: 'artist',
            });
            return;
        }
        if (source === 'navidrome') {
            handlePushCollection({
                source: 'navidrome',
                id: String(artistId),
                name: artistName,
                type: 'artist',
            });
            return;
        }

        const catalogIndex = buildLocalLibraryIndex(
            localLibraryCatalog.entities,
            localLibraryCatalog.assignments,
        );
        const activeEntityId = followEntityRedirect(String(artistId), catalogIndex.entitiesById);
        const artistEntity = activeEntityId
            ? catalogIndex.entitiesById.get(activeEntityId)
            : localLibraryCatalog.entities.find(entity => (
                entity.kind === 'artist' && !entity.mergedInto && entity.displayName === artistName
            ));
        if (!artistEntity) return;
        const memberIds = new Set(localLibraryCatalog.assignments
            .filter(assignment => assignment.artistEntityIds.some(entityId => (
                followEntityRedirect(entityId, catalogIndex.entitiesById) === artistEntity.id
            )))
            .map(assignment => assignment.songId));
        const artistSongs = surfaceProps.localSongs.filter(song => memberIds.has(song.id));
        handlePushCollection({
            source: 'local',
            id: artistEntity.id,
            entityId: artistEntity.id,
            name: artistEntity.displayName,
            type: 'artist',
            songIds: artistSongs.map(song => song.id),
        });
    }, [handlePushCollection, surfaceProps.localSongs, localLibraryCatalog, selectedCollection, showCatalogUnavailable]);

    useEffect(() => {
        if (!selectedCollection) {
            setExternalTracks(undefined);
            setExternalTracksLoading(false);
            setResolvedLocalCollectionCoverUrl(undefined);
            setNavidromePlaylistItems([]);
            return;
        }

        if (selectedCollection.source === 'online') {
            setExternalTracks(undefined);
            setExternalTracksLoading(false);
            setResolvedLocalCollectionCoverUrl(undefined);
            setNavidromePlaylistItems([]);
        }
    }, [selectedCollectionKey]);

    useEffect(() => {
        if (!selectedCollection || !isLocalGridViewCollection(selectedCollection)) {
            return;
        }

        if (!liveSelectedCollection || !isLocalGridViewCollection(liveSelectedCollection)) {
            handleBackCollection();
            return;
        }

        const resolvedTracks = resolveLocalGridViewTracks(
            liveSelectedCollection,
            surfaceProps.localSongs,
            localLibraryCatalog,
        ) as UnifiedSong[];
        if (liveSelectedCollection.songIds.length > 0 && resolvedTracks.length === 0) {
            handleBackCollection();
            return;
        }

        setNavidromePlaylistItems([]);
        setResolvedLocalCollectionCoverUrl(resolveLocalCollectionCoverUrlFromTracks(
            resolvedTracks,
            surfaceProps.localSongs,
        ));

        const localSongsById = new Map(surfaceProps.localSongs.map(song => [song.id, song]));
        const processedTracks = resolvedTracks.map(track => {
            const localData = track.localRef ? localSongsById.get(track.localRef.songId) : undefined;
            if (!localData) return track;

            const preferOnlineCover = localData.useOnlineCover === true;
            if (preferOnlineCover && localData.onlineMetadata?.coverUrl) {
                return track;
            }

            const url = getLocalCoverAssetUrl(localData.localCoverAssetId, 512);
            if (url) return applyLocalSongCoverDisplay(track, url);

            return track;
        });

        setExternalTracks(processedTracks);
        setExternalTracksLoading(false);
    }, [
        handleBackCollection,
        surfaceProps.localSongs,
        liveSelectedCollection,
        localLibraryCatalog,
        selectedCollection,
    ]);

    useEffect(() => {
        if (!selectedCollection || !isNavidromeGridViewCollection(selectedCollection)) {
            return;
        }

        let cancelled = false;
        setExternalTracks([]);
        setExternalTracksLoading(true);
        setResolvedLocalCollectionCoverUrl(undefined);

        resolveNavidromeGridViewTracks(selectedCollection)
            .then((tracks) => {
                if (!cancelled) {
                    setExternalTracks(tracks);
                }
            })
            .catch((error) => {
                console.error('[GridViewOverlayHost] Failed to load Navidrome GridView tracks:', error);
                if (!cancelled) {
                    setExternalTracks([]);
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setExternalTracksLoading(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [
        selectedCollection,
    ]);

    const refreshNavidromePlaylists = useCallback(async () => {
        const config = getNavidromeConfig();
        if (!config) {
            setNavidromePlaylistItems([]);
            return;
        }

        const playlists = await navidromeApi.getPlaylists(config);
        setNavidromePlaylistItems(playlists.map(playlist => ({
            id: playlist.id,
            name: playlist.name,
            description: playlist.owner,
        })));
    }, []);

    useEffect(() => {
        if (selectedCollection && isNavidromeGridViewCollection(selectedCollection)) {
            void refreshNavidromePlaylists();
        }
    }, [refreshNavidromePlaylists, selectedCollection]);

    const handleSelectTrack = useCallback((track: SongResult, queue: SongResult[]) => {
        surfaceProps.onPlaySong(track, queue);
    }, [surfaceProps]);

    const handleAddTrackToQueue = useCallback((track: SongResult) => {
        const unifiedTrack = track as UnifiedSong;
        const localSongId = unifiedTrack.localRef?.songId;
        const localSong = localSongId ? surfaceProps.localSongs.find(song => song.id === localSongId) : undefined;
        if (unifiedTrack.isLocal && localSong) {
            surfaceProps.onAddLocalSongToQueue?.(localSong);
            return;
        }
        if (unifiedTrack.isNavidrome) {
            const naviSong = resolveNavidromePlaybackCarrier(unifiedTrack);
            if (naviSong) {
                surfaceProps.onAddNavidromeSongsToQueue?.([naviSong]);
                return;
            }
        }
        surfaceProps.onAddSongToQueue?.(track);
    }, [surfaceProps]);

    const sourceActions = useMemo<GridViewSourceActions>(() => ({
        local: {
            onRefresh: surfaceProps.onRefreshLocalSongs,
            onEditEntity: async (entityId) => setEditingEntityId(entityId),
            onOrganizeFolderSongInfo: async (collection) => {
                if (isLocalGridViewCollection(collection) && collection.type === 'folder' && !collection.isVirtual) {
                    setOrganizingFolder(collection);
                }
            },
            onMatchSong: async (songId) => setMatchingSongId(songId),
            onResyncFolder: async (collection) => {
                const importedSongs = await resyncFolder(collection.name);
                if (importedSongs !== null) {
                    await surfaceProps.onRefreshLocalSongs();
                }
            },
            onResyncAllFolders: async () => {
                const importedSongs = await resyncAllFolders();
                if (importedSongs !== null) {
                    await surfaceProps.onRefreshLocalSongs();
                }
            },
            onDeleteFolder: async (collection) => {
                await deleteFolderSongs(collection.name);
                surfaceProps.onRefreshLocalSongs();
            },
            onRenamePlaylist: async (playlistId, name) => {
                await updateLocalPlaylist(playlistId, playlist => ({
                    ...playlist,
                    name: name.trim(),
                }));
                surfaceProps.onRefreshLocalSongs();
            },
            onDeletePlaylist: async (playlistId) => {
                await deleteLocalPlaylist(playlistId);
                surfaceProps.onRefreshLocalSongs();
            },
            onExportPlaylist: async (playlistId) => {
                const playlist = surfaceProps.localPlaylists.find(item => item.id === playlistId);
                if (!playlist) return;
                downloadLocalPlaylistM3u8(playlist, surfaceProps.localSongs);
                surfaceProps.onStatusMessage?.({
                    type: 'success',
                    text: t('localMusic.playlistExportSuccess', { name: playlist.name }),
                });
            },
            onRemovePlaylistSongs: async (playlistId, songIds) => {
                await removeSongsFromLocalPlaylist(playlistId, songIds);
            },
        },
        navidrome: {
            availablePlaylists: navidromePlaylistItems,
            onAddToPlaylist: async (playlistId, songs) => {
                const config = getNavidromeConfig();
                if (!config) return;

                await navidromeApi.updatePlaylist(config, String(playlistId), {
                    songIdsToAdd: songs
                        .map(song => (song as UnifiedSong).navidromeData?.id)
                        .filter((id): id is string => Boolean(id)),
                });
                await refreshNavidromePlaylists();
            },
            onCreatePlaylist: async (name, songs) => {
                const config = getNavidromeConfig();
                if (!config) return;

                await navidromeApi.createPlaylist(
                    config,
                    name,
                    songs
                        .map(song => (song as UnifiedSong).navidromeData?.id)
                        .filter((id): id is string => Boolean(id))
                );
                await refreshNavidromePlaylists();
            },
            onRenamePlaylist: async (playlistId, name) => {
                const config = getNavidromeConfig();
                if (!config) return;

                await navidromeApi.updatePlaylist(config, playlistId, { name });
                await refreshNavidromePlaylists();
            },
            onDeletePlaylist: async (playlistId) => {
                const config = getNavidromeConfig();
                if (!config) return;

                await navidromeApi.deletePlaylist(config, playlistId);
                await refreshNavidromePlaylists();
            },
            onRemovePlaylistSongs: async (playlistId, songIndexes) => {
                const config = getNavidromeConfig();
                if (!config) return;

                await navidromeApi.updatePlaylist(config, playlistId, {
                    songIndexesToRemove: songIndexes,
                });
            },
        },
    }), [surfaceProps, navidromePlaylistItems, refreshNavidromePlaylists]);

    const editingEntity = editingEntityId
        ? localLibraryCatalog.entities.find(entity => entity.id === editingEntityId)
        : undefined;
    const editingEntityMemberIds = new Set(localLibraryCatalog.assignments
        .filter(assignment => editingEntity?.kind === 'artist'
            ? assignment.artistEntityIds.includes(editingEntity.id)
            : assignment.albumEntityId === editingEntity?.id)
        .map(assignment => assignment.songId));
    const editingEntitySongs = surfaceProps.localSongs.filter(song => editingEntityMemberIds.has(song.id));
    const organizingFolderSongs = organizingFolder
        ? organizingFolder.songIds
            .map(songId => surfaceProps.localSongs.find(song => song.id === songId))
            .filter((song): song is LocalSong => Boolean(song))
        : [];
    const matchingSong = matchingSongId
        ? surfaceProps.localSongs.find(song => song.id === matchingSongId)
        : undefined;
    const matchingSongAssignment = matchingSongId
        ? localLibraryCatalog.assignments.find(assignment => assignment.songId === matchingSongId)
        : undefined;

    return (
        <>
            <div
                className="absolute inset-0"
                aria-hidden={Boolean(selectedCollection)}
                style={{
                    visibility: selectedCollection ? 'hidden' : 'visible',
                    pointerEvents: selectedCollection ? 'none' : 'auto',
                }}
            >
                {children(openGridView, isInteractive && !selectedCollection)}
            </div>
            <AnimatePresence initial={false}>
                {selectedCollection && (
                    <motion.div
                        key="grid-transition-backdrop"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                        className="fixed inset-0 z-[49] pointer-events-none"
                        style={{ backgroundColor: 'var(--bg-color)' }}
                    />
                )}
            </AnimatePresence>
            <AnimatePresence initial={false}>
                {displaySelectedCollection && (
                    displaySelectedCollection.type === 'artist' ? (
                        <ArtistGridView
                            key={selectedCollectionKey}
                            collection={displaySelectedCollection}
                            onBack={handleBackCollection}
                            onSelectTrack={handleSelectTrack}
                            onAddTrackToQueue={handleAddTrackToQueue}
                            onPlayAll={surfaceProps.onPlayAll}
                            onAddAllToQueue={surfaceProps.onAddAllToQueue}
                            onSelectAlbum={handlePushAlbumCollection}
                            onSelectArtist={handlePushArtistCollection}
                            theme={surfaceProps.theme}
                            isDaylight={isDaylight}
                            localSongs={surfaceProps.localSongs}
                            onEditEntity={(entityId) => setEditingEntityId(entityId)}
                            isInteractive={isInteractive}
                        />
                    ) : (
                        <GridView
                            key={selectedCollectionKey}
                            title={displaySelectedCollection.name}
                            subtitle={(displaySelectedCollection as any).creator?.nickname || (displaySelectedCollection as any).artists?.[0]?.name || displaySelectedCollection.description || ''}
                            collection={displaySelectedCollection}
                            mode="tracks"
                            onBack={handleBackCollection}
                            onSelectTrack={handleSelectTrack}
                            onAddTrackToQueue={handleAddTrackToQueue}
                            onPlayAll={surfaceProps.onPlayAll}
                            onAddAllToQueue={surfaceProps.onAddAllToQueue}
                            onSelectAlbum={handlePushAlbumCollection}
                            onSelectArtist={handlePushArtistCollection}
                            currentUserId={surfaceProps.user?.id}
                            onPlaylistMutated={surfaceProps.onRefreshUser}
                            onStatusMessage={surfaceProps.onStatusMessage}
                            externalTracks={externalTracks}
                            externalTracksLoading={externalTracksLoading}
                            localSongs={surfaceProps.localSongs}
                            sourceActions={sourceActions}
                            theme={surfaceProps.theme}
                            isDaylight={isDaylight}
                            isInteractive={isInteractive}
                        />
                    )
                )}
            </AnimatePresence>
            {editingEntity && (
                <LocalLibraryEntityPanel
                    entity={editingEntity}
                    sameKindEntities={localLibraryCatalog.entities.filter(entity => entity.kind === editingEntity.kind)}
                    memberSongs={editingEntitySongs}
                    isDaylight={isDaylight}
                    onClose={() => setEditingEntityId(null)}
                    onChanged={async () => {
                        await localLibraryCatalog.reload();
                        await surfaceProps.onRefreshLocalSongs();
                    }}
                />
            )}
            {organizingFolder && (
                <LocalFolderSongInfoPanel
                    folderName={organizingFolder.name}
                    songs={organizingFolderSongs}
                    assignments={localLibraryCatalog.assignments}
                    isDaylight={isDaylight}
                    onClose={() => setOrganizingFolder(null)}
                    onChanged={async () => {
                        await localLibraryCatalog.reload();
                        await surfaceProps.onRefreshLocalSongs();
                    }}
                />
            )}
            {matchingSong && (
                <LocalSongMetadataMatchDialog
                    song={matchingSong}
                    assignment={matchingSongAssignment}
                    isDaylight={isDaylight}
                    onClose={() => setMatchingSongId(null)}
                    onChanged={async () => {
                        await localLibraryCatalog.reload();
                        await surfaceProps.onRefreshLocalSongs();
                    }}
                />
            )}
        </>
    );
};

export default GridViewOverlayHost;
