import { describe, expect, it, vi } from 'vitest';
import { buildGridSurfaceState, runGridSurfaceAction, type GridSurfaceParams } from '../../../src/components/folia-grid/gridSurfaceHandle';

// test/unit/command-palette/gridSurfaceHandle.test.ts
// 分支规则只写在这里一处，命令侧只问 availableActions。所以「哪个分支给哪些动作」必须由测试兜住：
// 写歪了不会报错，只会让某条命令在不该出现的地方出现，或者在该出现的地方消失。

const params = (overrides: Partial<GridSurfaceParams> = {}): GridSurfaceParams => ({
    hasInfoPanel: false,
    hasTrackList: false,
    supportsLocalTrackSorting: false,
    canResyncFolder: false,
    canResyncAllFolders: false,
    canOrganizeSongInfo: false,
    canExportPlaylist: false,
    canEditEntity: false,
    canEditPlaylist: false,
    isSourceActionPending: false,
    filteredTrackCount: 0,
    isFilterActive: false,
    sortField: 'fileName',
    sortDirection: 'asc',
    isInfoPanelOpen: false,
    isTrackListOpen: false,
    isEditMode: false,
    playFiltered: vi.fn(),
    enqueueFiltered: vi.fn(),
    setSortField: vi.fn(),
    setSortDirection: vi.fn(),
    toggleInfoPanel: vi.fn(),
    toggleTrackList: vi.fn(),
    resyncFolder: vi.fn(),
    resyncAllFolders: vi.fn(),
    organizeSongInfo: vi.fn(),
    exportPlaylist: vi.fn(),
    editEntity: vi.fn(),
    toggleEditMode: vi.fn(),
    ...overrides,
});

describe('grid surface state', () => {
    it('offers nothing on a grid with no tracks and no branch', () => {
        expect(buildGridSurfaceState(params()).availableActions).toEqual([]);
    });

    it('offers the two playback actions only once something is left to act on', () => {
        expect(buildGridSurfaceState(params({ filteredTrackCount: 3 })).availableActions)
            .toEqual(['play-filtered', 'enqueue-filtered']);
    });

    it('offers sorting only where local track sorting applies', () => {
        const sorting = buildGridSurfaceState(params({ supportsLocalTrackSorting: true })).availableActions;

        expect(sorting).toContain('sort-file-name');
        expect(sorting).toContain('sort-toggle-direction');
        expect(buildGridSurfaceState(params()).availableActions).not.toContain('sort-file-name');
    });

    // 按钮在 isSourceActionPending 时是 disabled 的，命令必须跟着一起退场，
    // 否则可以在重扫进行中再触发一次重扫。
    it('withdraws the disk and network actions while a source action is running', () => {
        const busy = buildGridSurfaceState(params({
            canResyncFolder: true,
            canExportPlaylist: true,
            canEditPlaylist: true,
            isSourceActionPending: true,
        })).availableActions;

        expect(busy).toEqual([]);
    });
});

describe('grid surface dispatch', () => {
    it('maps each sort command to its field', () => {
        const sorting = params({ supportsLocalTrackSorting: true });

        runGridSurfaceAction('sort-album-track', sorting);

        expect(sorting.setSortField).toHaveBeenCalledWith('albumTrack');
    });

    it('flips the direction rather than setting a fixed one', () => {
        const descending = params({ supportsLocalTrackSorting: true, sortDirection: 'desc' });

        runGridSurfaceAction('sort-toggle-direction', descending);

        expect(descending.setSortDirection).toHaveBeenCalledWith('asc');
    });

    // 快捷键、固定槽位和一个开着没关的面板都能打到已经消失的分支上。
    it('refuses an action the current branch does not offer', () => {
        const noSorting = params();

        runGridSurfaceAction('sort-file-name', noSorting);
        runGridSurfaceAction('play-filtered', noSorting);

        expect(noSorting.setSortField).not.toHaveBeenCalled();
        expect(noSorting.playFiltered).not.toHaveBeenCalled();
    });
});
