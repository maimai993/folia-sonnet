import { describe, expect, it, vi } from 'vitest';
import { buildCoreSurfaceParams, buildGridSurfaceState, runGridSurfaceAction } from '@/utils/libraryUi/collectionSurface';
import { resolveCollectionSyncCounts } from '@/utils/libraryUi/collectionProgress';

// test/unit/libraryUi/collectionSurface.test.ts
// 只有核心动作的 renderer（没有信息面板、侧栏、编辑模式）注册到命令面板时，
// 面板只能给出它真能做到的那几件事。

const core = (overrides: Partial<Parameters<typeof buildCoreSurfaceParams>[0]> = {}) => buildCoreSurfaceParams({
    supportsLocalTrackSorting: false,
    canReloadOnlineCollection: true,
    filteredTrackCount: 3,
    isFilterActive: false,
    sortField: 'fileName',
    sortDirection: 'asc',
    playFiltered: vi.fn(),
    enqueueFiltered: vi.fn(),
    setSortField: vi.fn(),
    setSortDirection: vi.fn(),
    reloadOnlineCollection: vi.fn(),
    ...overrides,
});

describe('core collection surface', () => {
    it('offers only play, enqueue and reload for an online collection', () => {
        expect(buildGridSurfaceState(core()).availableActions).toEqual([
            'play-filtered',
            'enqueue-filtered',
            'reload-online-collection',
        ]);
    });

    it('adds the local sort actions when the collection supports them', () => {
        expect(buildGridSurfaceState(core({ supportsLocalTrackSorting: true, canReloadOnlineCollection: false })).availableActions)
            .toEqual(['play-filtered', 'enqueue-filtered', 'sort-file-name', 'sort-modified-date', 'sort-album-track', 'sort-toggle-direction']);
    });

    it('refuses renderer-only actions and dispatches core ones', () => {
        const params = core();
        runGridSurfaceAction('toggle-info-panel', params);
        runGridSurfaceAction('toggle-edit-mode', params);
        runGridSurfaceAction('play-filtered', params);
        expect(params.playFiltered).toHaveBeenCalledTimes(1);
    });
});

describe('collection sync counts', () => {
    it('reports loaded / total only when the total is known', () => {
        expect(resolveCollectionSyncCounts(1500, 3000)).toEqual({ loaded: (1500).toLocaleString(), total: (3000).toLocaleString() });
        expect(resolveCollectionSyncCounts(10, undefined)).toBeNull();
        expect(resolveCollectionSyncCounts(10, 0)).toBeNull();
    });
});
