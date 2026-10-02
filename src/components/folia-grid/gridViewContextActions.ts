import type { SongResult } from '../../types';
import { isSongUnavailable } from '../../services/onlineMusic/songAvailability';
import { resolveContextTracks } from '../../utils/libraryUi/collectionView';

// src/components/folia-grid/gridViewContextActions.ts

export type GridViewContextItem = {
    rawTrack?: SongResult;
};

// Resolves the exact playable track set represented by the current GridView context.
// The rule itself lives in utils/libraryUi/collectionView, shared with every other renderer.
export const resolveGridViewContextTracks = (
    visibleItems: readonly GridViewContextItem[],
    allPlayableTracks: SongResult[],
    isFilterActive: boolean
): SongResult[] => resolveContextTracks(
    isFilterActive ? visibleItems.flatMap(item => (item.rawTrack ? [item.rawTrack] : [])) : null,
    allPlayableTracks,
    isSongUnavailable,
);
