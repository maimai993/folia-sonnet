import { describe, expect, it } from 'vitest';
import {
    DEFAULT_LIBRARY_SUITE_ID,
    getLibrarySuite,
    hasLibrarySuite,
    listLibrarySuiteOverlays,
    listLibrarySuites,
    resolveLibrarySurface,
    resolveLibrarySurfaceActions,
} from '@/library/registry';
import { LIBRARY_ACTION_IDS } from '@/library/core/model/librarySuites';

// test/unit/library/registry.test.ts
// 真实的 suite 注册表（eager glob 发现 suites/*/entry.ts）。vitest 里 import.meta.env.DEV 为 true，
// 所以开发版专用的 TUI 也在。纯规则的边界情况在 core/librarySuites.test.ts。

describe('library suite registry', () => {
    it('discovers the grid (default, first) and the dev-only TUI', () => {
        expect(listLibrarySuites().map(suite => suite.id)).toEqual(['grid', 'tui']);
        expect(DEFAULT_LIBRARY_SUITE_ID).toBe('grid');
        expect(hasLibrarySuite('tui')).toBe(true);
        expect(hasLibrarySuite('renderer')).toBe(false);
        expect(getLibrarySuite('tui')?.labelKey).toBe('libraryTui.rendererTui');
    });

    it('renders the TUI collection itself and falls back to the grid for home and the artist page', () => {
        expect(resolveLibrarySurface('collection', 'tui')).toMatchObject({ suiteId: 'tui', isFallback: false });
        expect(resolveLibrarySurface('home', 'tui')).toMatchObject({ suiteId: 'grid', isFallback: true });
        expect(resolveLibrarySurface('artist', 'tui')).toMatchObject({ suiteId: 'grid', isFallback: true });
        expect(resolveLibrarySurface('artist', 'tui').component).toBe(resolveLibrarySurface('artist', 'grid').component);
        expect(resolveLibrarySurface('collection', 'nope').suiteId).toBe('grid');
    });

    it('hands out stable results so the host can pass them as props', () => {
        expect(resolveLibrarySurface('collection', 'grid')).toBe(resolveLibrarySurface('collection', 'grid'));
        expect(resolveLibrarySurfaceActions('home', 'tui')).toBe(resolveLibrarySurfaceActions('home', 'grid'));
    });

    it('declares what each suite implements today', () => {
        expect([...resolveLibrarySurfaceActions('collection', 'grid').actions].sort()).toEqual([...LIBRARY_ACTION_IDS].sort());
        expect(resolveLibrarySurfaceActions('collection', 'grid').extraActions)
            .toEqual(['toggle-info-panel', 'toggle-track-list', 'toggle-edit-mode']);
        // TUI 实现了除 Navidrome「加入歌单 / 新建歌单」以外的全部集合动作（那两个需要歌单选择器，只在网格里）。
        expect(resolveLibrarySurfaceActions('collection', 'tui')).toEqual({
            actions: [
                'play', 'enqueue', 'play-scope', 'enqueue-scope', 'filter', 'sort', 'reload', 'resume-sync',
                'remove-entry', 'subscribe', 'rename', 'delete-collection', 'resync-folder', 'resync-all-folders',
                'export-playlist', 'edit-entity', 'organize-song-info', 'match-song', 'daily-date',
            ],
            extraActions: [],
        });
        expect(LIBRARY_ACTION_IDS.filter(action => !resolveLibrarySurfaceActions('collection', 'tui').actions.includes(action)))
            .toEqual(['add-to-playlist', 'create-playlist']);
    });

    it('only the grid brings a transition layer', () => {
        expect(listLibrarySuiteOverlays().map(overlay => overlay.suiteId)).toEqual(['grid']);
        expect(resolveLibrarySurface('collection', 'tui').transitions).toBeUndefined();
        expect(resolveLibrarySurface('artist', 'tui').transitions?.beforeBack).toBeTypeOf('function');
    });
});
