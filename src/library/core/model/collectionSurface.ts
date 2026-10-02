import type { GridSurfaceActionId, GridSurfaceState } from '../../../types/gridCommandSurface';
import type { LocalSongFolderSortDirection, LocalSongFolderSortField } from '../../../utils/localSongSorting';
import type { LibraryActionId, LibraryDeclaredActions } from '../contracts/suite';

// src/library/core/model/collectionSurface.ts
// Turns a collection view's branch flags and handlers into the flat contract the command palette reads.
// (Moved from components/folia-grid/gridSurfaceHandle.ts: a list renderer publishes the same handle.)
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
    /** Online collection that can be fetched again past its cache; false while a load is running. */
    canReloadOnlineCollection: boolean;
    /** A source action is in flight; the disk and network actions grey out, exactly as the buttons do. */
    isSourceActionPending: boolean;
    /**
     * 渲染这个 surface 的 suite 声明的动作（见 core/contracts/suite）。给了就只发布声明过的——
     * 分支规则判定「这个集合能不能做」，声明决定「这套 UI 做不做」，命令面板看到的是两者的交集。
     * 不给（直接挂组件的探针与单测）时不过滤。
     */
    declaredActions?: LibraryDeclaredActions;

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
    reloadOnlineCollection: () => void;
};

/** 与渲染形态无关的那一部分：播放 / 入队筛选结果、本地排序、重新拉取在线集合。 */
export type CoreSurfaceParams = Pick<
    GridSurfaceParams,
    | 'supportsLocalTrackSorting'
    | 'canReloadOnlineCollection'
    | 'filteredTrackCount'
    | 'isFilterActive'
    | 'sortField'
    | 'sortDirection'
    | 'playFiltered'
    | 'enqueueFiltered'
    | 'setSortField'
    | 'setSortDirection'
    | 'reloadOnlineCollection'
    | 'declaredActions'
>;

const noop = () => {};

/**
 * 只有核心动作的 surface 参数：信息面板、曲目侧栏、编辑模式和来源维护动作一律不提供。
 * 没有这些面板的 renderer 用它注册，命令面板就只会给出它真能做到的事。
 */
export const buildCoreSurfaceParams = (core: CoreSurfaceParams): GridSurfaceParams => ({
    hasInfoPanel: false,
    hasTrackList: false,
    canResyncFolder: false,
    canResyncAllFolders: false,
    canOrganizeSongInfo: false,
    canExportPlaylist: false,
    canEditEntity: false,
    canEditPlaylist: false,
    isSourceActionPending: false,
    isInfoPanelOpen: false,
    isTrackListOpen: false,
    isEditMode: false,
    toggleInfoPanel: noop,
    toggleTrackList: noop,
    resyncFolder: noop,
    resyncAllFolders: noop,
    organizeSongInfo: noop,
    exportPlaylist: noop,
    editEntity: noop,
    toggleEditMode: noop,
    ...core,
});

/**
 * 每个命令面板动作来自哪里：core 的语义动作（LibraryActionId），或 suite 自己的局部动作。
 * 既有命令 ID 不变；这张表只决定「suite 没声明时不发布」。
 */
export const GRID_SURFACE_ACTION_SOURCES: Readonly<Record<GridSurfaceActionId, { action: LibraryActionId } | { extra: string }>> = {
    'play-filtered': { action: 'play-scope' },
    'enqueue-filtered': { action: 'enqueue-scope' },
    'sort-file-name': { action: 'sort' },
    'sort-modified-date': { action: 'sort' },
    'sort-album-track': { action: 'sort' },
    'sort-toggle-direction': { action: 'sort' },
    'toggle-info-panel': { extra: 'toggle-info-panel' },
    'toggle-track-list': { extra: 'toggle-track-list' },
    'resync-folder': { action: 'resync-folder' },
    'resync-all-folders': { action: 'resync-all-folders' },
    'organize-song-info': { action: 'organize-song-info' },
    'export-playlist': { action: 'export-playlist' },
    'edit-entity': { action: 'edit-entity' },
    'toggle-edit-mode': { extra: 'toggle-edit-mode' },
    'reload-online-collection': { action: 'reload' },
};

/** 这个命令面板动作是否在 suite 的声明里。 */
export const isGridSurfaceActionDeclared = (action: GridSurfaceActionId, declared: LibraryDeclaredActions): boolean => {
    const source = GRID_SURFACE_ACTION_SOURCES[action];
    return 'action' in source ? declared.actions.includes(source.action) : declared.extraActions.includes(source.extra);
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
    if (params.canReloadOnlineCollection) {
        availableActions.push('reload-online-collection');
    }
    const declared = params.declaredActions;

    return {
        availableActions: declared
            ? availableActions.filter(action => isGridSurfaceActionDeclared(action, declared))
            : availableActions,
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
        case 'reload-online-collection': return params.reloadOnlineCollection();
        default: return;
    }
};
