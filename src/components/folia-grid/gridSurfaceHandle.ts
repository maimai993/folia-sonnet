import type { GridSurfaceActionId, GridSurfaceState } from '../../types/gridCommandSurface';
import type { LocalSongFolderSortDirection, LocalSongFolderSortField } from '../../utils/localSongSorting';

// src/components/folia-grid/gridSurfaceHandle.ts
// Turns GridView's branch flags and handlers into the flat contract the command palette reads.
//
// Pure on purpose: the branch rules are the same booleans the buttons are already gated on
// (GridView's isLocalFolderCollection, supportsLocalTrackSorting, canEditPlaylist ...), so keeping
// them here rather than in a second set of `isAvailable` predicates is what stops a command from
// offering something the panel would refuse.

export type GridSurfaceParams = {
    /** Branch gating — mirrors the conditions the matching buttons render under. */
    hasInfoPanel: boolean;
    hasTrackList: boolean;
    supportsLocalTrackSorting: boolean;
    canResyncFolder: boolean;
    canResyncAllFolders: boolean;
    canOrganizeSongInfo: boolean;
    canExportPlaylist: boolean;
    canEditEntity: boolean;
    canEditPlaylist: boolean;
    /** A source action is in flight; the disk and network actions grey out, exactly as the buttons do. */
    isSourceActionPending: boolean;

    filteredTrackCount: number;
    isFilterActive: boolean;
    sortField: LocalSongFolderSortField;
    sortDirection: LocalSongFolderSortDirection;
    isInfoPanelOpen: boolean;
    isTrackListOpen: boolean;
    isEditMode: boolean;

    playFiltered: () => void;
    enqueueFiltered: () => void;
    setSortField: (field: LocalSongFolderSortField) => void;
    setSortDirection: (direction: LocalSongFolderSortDirection) => void;
    toggleInfoPanel: () => void;
    toggleTrackList: () => void;
    resyncFolder: () => void;
    resyncAllFolders: () => void;
    organizeSongInfo: () => void;
    exportPlaylist: () => void;
    editEntity: () => void;
    toggleEditMode: () => void;
};

const SORT_FIELD_BY_ACTION: Partial<Record<GridSurfaceActionId, LocalSongFolderSortField>> = {
    'sort-file-name': 'fileName',
    'sort-modified-date': 'fileLastModified',
    'sort-album-track': 'albumTrack',
};

export const buildGridSurfaceState = (params: GridSurfaceParams): GridSurfaceState => {
    const hasTracks = params.filteredTrackCount > 0;
    const canRunSourceAction = !params.isSourceActionPending;

    const availableActions: GridSurfaceActionId[] = [];
    if (hasTracks) {
        availableActions.push('play-filtered', 'enqueue-filtered');
    }
    if (params.supportsLocalTrackSorting) {
        availableActions.push('sort-file-name', 'sort-modified-date', 'sort-album-track', 'sort-toggle-direction');
    }
    if (params.hasInfoPanel) {
        availableActions.push('toggle-info-panel');
    }
    if (params.hasTrackList) {
        availableActions.push('toggle-track-list');
    }
    if (params.canResyncFolder && canRunSourceAction) {
        availableActions.push('resync-folder');
    }
    if (params.canResyncAllFolders && canRunSourceAction) {
        availableActions.push('resync-all-folders');
    }
    if (params.canOrganizeSongInfo) {
        availableActions.push('organize-song-info');
    }
    if (params.canExportPlaylist && canRunSourceAction) {
        availableActions.push('export-playlist');
    }
    if (params.canEditEntity) {
        availableActions.push('edit-entity');
    }
    if (params.canEditPlaylist && canRunSourceAction) {
        availableActions.push('toggle-edit-mode');
    }

    return {
        availableActions,
        filteredTrackCount: params.filteredTrackCount,
        isFilterActive: params.isFilterActive,
        sortField: params.sortField,
        sortDirection: params.sortDirection,
        isInfoPanelOpen: params.isInfoPanelOpen,
        isTrackListOpen: params.isTrackListOpen,
        isEditMode: params.isEditMode,
    };
};

/**
 * Runs one published action, refusing anything the current branch does not offer.
 *
 * The guard is not redundant with the palette's gating: `executeShortcut`, a pinned slot and a
 * stale open palette can all reach a command whose branch has since gone away.
 */
export const runGridSurfaceAction = (action: GridSurfaceActionId, params: GridSurfaceParams): void => {
    if (!buildGridSurfaceState(params).availableActions.includes(action)) {
        return;
    }

    const sortField = SORT_FIELD_BY_ACTION[action];
    if (sortField) {
        params.setSortField(sortField);
        return;
    }

    switch (action) {
        case 'play-filtered': return params.playFiltered();
        case 'enqueue-filtered': return params.enqueueFiltered();
        case 'sort-toggle-direction': return params.setSortDirection(params.sortDirection === 'asc' ? 'desc' : 'asc');
        case 'toggle-info-panel': return params.toggleInfoPanel();
        case 'toggle-track-list': return params.toggleTrackList();
        case 'resync-folder': return params.resyncFolder();
        case 'resync-all-folders': return params.resyncAllFolders();
        case 'organize-song-info': return params.organizeSongInfo();
        case 'export-playlist': return params.exportPlaylist();
        case 'edit-entity': return params.editEntity();
        case 'toggle-edit-mode': return params.toggleEditMode();
        default: return;
    }
};
