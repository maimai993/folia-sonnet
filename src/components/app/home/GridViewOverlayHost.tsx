import React, { useCallback, useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import LegacyHome from '../../Home';
import GridView from '../../GridView';
import { useSearchNavigationStore } from '../../../stores/useSearchNavigationStore';
import { useSettingsUiStore } from '../../../stores/useSettingsUiStore';
import { SongResult, UnifiedSong } from '../../../types';
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
            return;
        }

        if (isLocalGridViewCollection(selectedCollection)) {
            setExternalTracks(resolveLocalGridViewTracks(selectedCollection, legacyProps.localSongs));
            setExternalTracksLoading(false);
            return;
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

    const handleSelectTrack = useCallback((track: SongResult, queue: SongResult[]) => {
        const unifiedTrack = track as UnifiedSong;
        if (unifiedTrack.isNavidrome) {
            legacyProps.onPlayNavidromeSong?.(unifiedTrack as any, queue as any);
            return;
        }
        if (unifiedTrack.isLocal) {
            legacyProps.onPlayLocalSong?.(unifiedTrack as any, queue as any);
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

    return (
        <>
            {children(openGridView)}
            <AnimatePresence>
                {selectedCollection && (
                    <GridView
                        title={selectedCollection.name}
                        subtitle={selectedCollection.creator?.nickname || selectedCollection.artists?.[0]?.name || selectedCollection.description || ''}
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
                        theme={legacyProps.theme}
                        isDaylight={isDaylight}
                    />
                )}
            </AnimatePresence>
        </>
    );
};

export default GridViewOverlayHost;
