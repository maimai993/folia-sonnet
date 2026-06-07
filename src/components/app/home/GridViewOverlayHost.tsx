import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import LegacyHome from '../../Home';
import GridView, { GridViewSourceActions } from '../../GridView';
import { useSearchNavigationStore } from '../../../stores/useSearchNavigationStore';
import { useSettingsUiStore } from '../../../stores/useSettingsUiStore';
import { LocalSong, SongResult, UnifiedSong } from '../../../types';
import { NavidromeSong } from '../../../types/navidrome';
import { deleteFolderSongs, resyncFolder } from '../../../services/localMusicService';
import { deleteLocalPlaylist, removeSongsFromLocalPlaylist, updateLocalPlaylist } from '../../../services/localPlaylistService';
import { getNavidromeConfig, navidromeApi } from '../../../services/navidromeService';
import {
    GridViewCollectionDescriptor,
    isLocalGridViewCollection,
    isNavidromeGridViewCollection,
    resolveLocalGridViewTracks,
    resolveNavidromeGridViewTracks,
} from './gridViewCollectionAdapters';

// src/components/app/home/GridViewOverlayHost.tsx
// Hosts the GridView overlay outside Grid3D so it can be opened/restored independently.

type LegacyHomeProps = React.ComponentProps<typeof LegacyHome>;

type GridViewOverlayHostProps = {
    legacyProps: LegacyHomeProps;
    children: (openGridView: (collection: GridViewCollectionDescriptor) => void) => React.ReactNode;
};

type StoredGridViewCollection = {
    collection: GridViewCollectionDescriptor;
    homeViewTab: string;
};

export const GRID_VIEW_ACTIVE_COLLECTION_KEY = 'folia_gridview_active_collection';

const GridViewOverlayHost: React.FC<GridViewOverlayHostProps> = ({ legacyProps, children }) => {
    const isDaylight = useSettingsUiStore(state => state.isDaylight);
    const { homeViewTab, setHomeViewTab } = useSearchNavigationStore(useShallow(state => ({
        homeViewTab: state.homeViewTab,
        setHomeViewTab: state.setHomeViewTab,
    })));
    const [selectedCollection, setSelectedCollection] = useState<GridViewCollectionDescriptor | null>(null);
    const [externalTracks, setExternalTracks] = useState<SongResult[] | undefined>(undefined);
    const [externalTracksLoading, setExternalTracksLoading] = useState(false);
    const [navidromePlaylistItems, setNavidromePlaylistItems] = useState<Array<{ id: string | number; name: string; description?: string; }>>([]);

    useEffect(() => {
        if (selectedCollection) return;

        try {
            const saved = sessionStorage.getItem(GRID_VIEW_ACTIVE_COLLECTION_KEY);
            if (!saved) return;

            const parsed = JSON.parse(saved) as StoredGridViewCollection;
            if (parsed?.collection?.id === undefined || parsed.collection.id === null || !parsed.collection.name) return;

            setSelectedCollection(parsed.collection);
            if (parsed.homeViewTab) {
                setHomeViewTab(parsed.homeViewTab as any);
            }
        } catch {
            sessionStorage.removeItem(GRID_VIEW_ACTIVE_COLLECTION_KEY);
        }
    }, [selectedCollection, setHomeViewTab]);

    const openGridView = useCallback((collection: GridViewCollectionDescriptor) => {
        setSelectedCollection(collection);
        sessionStorage.setItem(
            GRID_VIEW_ACTIVE_COLLECTION_KEY,
            JSON.stringify({ collection, homeViewTab })
        );
    }, [homeViewTab]);

    const closeGridView = useCallback(() => {
        sessionStorage.removeItem(GRID_VIEW_ACTIVE_COLLECTION_KEY);
        setSelectedCollection(null);
    }, []);

    useEffect(() => {
        if (!selectedCollection) {
            setExternalTracks(undefined);
            setExternalTracksLoading(false);
            setNavidromePlaylistItems([]);
            return;
        }

        if (isLocalGridViewCollection(selectedCollection)) {
            const resolvedTracks = resolveLocalGridViewTracks(selectedCollection, legacyProps.localSongs) as UnifiedSong[];
            const createdUrls: string[] = [];
            const processedTracks = resolvedTracks.map(track => {
                const localData = track.localData;
                if (!localData) return track;

                const preferOnlineCover = localData.useOnlineCover === true;
                if (preferOnlineCover && localData.matchedCoverUrl) {
                    return track;
                }

                if (localData.embeddedCover) {
                    const url = URL.createObjectURL(localData.embeddedCover);
                    createdUrls.push(url);
                    return {
                        ...track,
                        al: track.al ? { ...track.al, picUrl: url } : { id: 0, name: '', picUrl: url },
                        album: track.album ? { ...track.album, picUrl: url } : { id: 0, name: '', picUrl: url },
                    };
                }

                return track;
            });

            setExternalTracks(processedTracks);
            setExternalTracksLoading(false);

            return () => {
                createdUrls.forEach(url => URL.revokeObjectURL(url));
            };
        }

        if (!isNavidromeGridViewCollection(selectedCollection)) {
            setExternalTracks(undefined);
            setExternalTracksLoading(false);
            return;
        }

        let cancelled = false;
        setExternalTracks([]);
        setExternalTracksLoading(true);

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
    }, [legacyProps.localSongs, selectedCollection]);

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
        const unifiedTrack = track as UnifiedSong;
        if (unifiedTrack.isNavidrome && unifiedTrack.navidromeData) {
            const naviQueue = queue
                .map(t => t as UnifiedSong)
                .filter(t => t.isNavidrome) as any as NavidromeSong[];
            legacyProps.onPlayNavidromeSong?.(unifiedTrack as any as NavidromeSong, naviQueue);
            return;
        }
        if (unifiedTrack.isLocal && unifiedTrack.localData) {
            const localQueue = queue
                .map(t => (t as UnifiedSong).localData)
                .filter((song): song is LocalSong => Boolean(song));
            legacyProps.onPlayLocalSong?.(unifiedTrack.localData, localQueue);
            return;
        }
        legacyProps.onPlaySong(track, queue);
    }, [legacyProps]);

    const handleAddTrackToQueue = useCallback((track: SongResult) => {
        const unifiedTrack = track as UnifiedSong;
        if (unifiedTrack.isLocal && unifiedTrack.localData) {
            legacyProps.onAddLocalSongToQueue?.(unifiedTrack.localData);
            return;
        }
        if (unifiedTrack.isNavidrome) {
            legacyProps.onAddNavidromeSongsToQueue?.([unifiedTrack as any]);
            return;
        }
        legacyProps.onAddSongToQueue?.(track);
    }, [legacyProps]);

    const sourceActions = useMemo<GridViewSourceActions>(() => ({
        local: {
            onRefresh: legacyProps.onRefreshLocalSongs,
            onResyncFolder: async (collection) => {
                const importedSongs = await resyncFolder(collection.name);
                if (importedSongs !== null) {
                    legacyProps.onRefreshLocalSongs();
                }
            },
            onDeleteFolder: async (collection) => {
                await deleteFolderSongs(collection.name);
                legacyProps.onRefreshLocalSongs();
            },
            onRenamePlaylist: async (playlistId, name) => {
                await updateLocalPlaylist(playlistId, playlist => ({
                    ...playlist,
                    name: name.trim(),
                }));
                legacyProps.onRefreshLocalSongs();
            },
            onDeletePlaylist: async (playlistId) => {
                await deleteLocalPlaylist(playlistId);
                legacyProps.onRefreshLocalSongs();
            },
            onRemovePlaylistSongs: async (playlistId, songIds) => {
                await removeSongsFromLocalPlaylist(playlistId, songIds);
                legacyProps.onRefreshLocalSongs();
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
    }), [legacyProps, navidromePlaylistItems, refreshNavidromePlaylists]);

    return (
        <>
            {children(openGridView)}
            <AnimatePresence>
                {selectedCollection && (
                    <GridView
                        title={selectedCollection.name}
                        subtitle={(selectedCollection as any).creator?.nickname || (selectedCollection as any).artists?.[0]?.name || selectedCollection.description || ''}
                        collection={selectedCollection}
                        mode="tracks"
                        onBack={closeGridView}
                        onSelectTrack={handleSelectTrack}
                        onAddTrackToQueue={handleAddTrackToQueue}
                        onPlayAll={legacyProps.onPlayAll}
                        onAddAllToQueue={legacyProps.onAddAllToQueue}
                        onSelectAlbum={legacyProps.onSelectAlbum}
                        onSelectArtist={legacyProps.onSelectArtist}
                        currentUserId={legacyProps.user?.userId}
                        onPlaylistMutated={legacyProps.onRefreshUser}
                        externalTracks={externalTracks}
                        externalTracksLoading={externalTracksLoading}
                        sourceActions={sourceActions}
                        theme={legacyProps.theme}
                        isDaylight={isDaylight}
                    />
                )}
            </AnimatePresence>
        </>
    );
};

export default GridViewOverlayHost;
