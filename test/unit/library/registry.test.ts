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
import { buildLibrarySuiteIndex, LIBRARY_ACTION_IDS, LIBRARY_ARTIST_ACTION_IDS, LIBRARY_HOME_ACTION_IDS } from '@/library/core/model/librarySuites';
import type { LibrarySuiteManifest } from '@/library/core/contracts/suite';

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

    it('renders every TUI surface itself, the artist page included (P4.3)', () => {
        for (const surface of ['home', 'collection', 'artist'] as const) {
            expect(resolveLibrarySurface(surface, 'tui')).toMatchObject({ suiteId: 'tui', isFallback: false });
            expect(resolveLibrarySurface(surface, 'tui').component).not.toBe(resolveLibrarySurface(surface, 'grid').component);
        }
        expect(resolveLibrarySurface('collection', 'nope').suiteId).toBe('grid');
    });

    it('still falls back to the grid artist page for a suite that does not implement it', () => {
        // TUI 实现歌手页之后，真实注册表里已经没有回退的例子：用真实的网格清单加一套只有集合页的假 suite 验证同一条规则。
        const grid = getLibrarySuite('grid')!;
        const listOnly: LibrarySuiteManifest = {
            id: 'list-only',
            labelKey: 'list-only',
            surfaces: { collection: { component: () => null, actions: ['play'] } },
        };
        const index = buildLibrarySuiteIndex([grid, listOnly]);
        const artist = index.resolve('artist', 'list-only');
        expect(artist).toMatchObject({ isFallback: true });
        expect(artist.suite.id).toBe('grid');
        expect(artist.declaration.component).toBe(grid.surfaces.artist!.component);
        expect(artist.declaredActions).toBe(index.resolve('artist', 'grid').declaredActions);
    });

    it('hands out stable results so the host can pass them as props', () => {
        expect(resolveLibrarySurface('collection', 'grid')).toBe(resolveLibrarySurface('collection', 'grid'));
        expect(resolveLibrarySurfaceActions('home', 'tui')).toBe(resolveLibrarySurfaceActions('home', 'tui'));
        expect(resolveLibrarySurfaceActions('artist', 'tui')).toBe(resolveLibrarySurfaceActions('artist', 'tui'));
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
        // 歌手页（P4.2 / P4.3）：两套都实现了全部歌手页动作（网格的播放全部只经命令面板，TUI 还有 Ctrl+Enter）。
        expect([...resolveLibrarySurfaceActions('artist', 'grid').actions].sort()).toEqual([...LIBRARY_ARTIST_ACTION_IDS].sort());
        expect([...resolveLibrarySurfaceActions('artist', 'tui').actions].sort()).toEqual([...LIBRARY_ARTIST_ACTION_IDS].sort());
        // 首页：两套都实现了全部首页动作（网格的焦点类动作在卡片与目录树的按钮上，TUI 的在命令面板与键盘上）。
        expect([...resolveLibrarySurfaceActions('home', 'grid').actions].sort()).toEqual([...LIBRARY_HOME_ACTION_IDS].sort());
        expect([...resolveLibrarySurfaceActions('home', 'tui').actions].sort()).toEqual([...LIBRARY_HOME_ACTION_IDS].sort());
    });

    it('only the grid brings a transition layer', () => {
        expect(listLibrarySuiteOverlays().map(overlay => overlay.suiteId)).toEqual(['grid']);
        expect(resolveLibrarySurface('collection', 'tui').transitions).toBeUndefined();
        expect(resolveLibrarySurface('artist', 'tui').transitions).toBeUndefined();
        expect(resolveLibrarySurface('artist', 'grid').transitions?.beforeBack).toBeTypeOf('function');
    });
});
