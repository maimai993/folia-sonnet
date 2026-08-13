import { describe, expect, it } from 'vitest';
import { compactGridMapDirectoryTrees, filterGridMapDirectoryTreesByItems, flattenExpandedGridMapDirectories, resolveGridMapBatchContext, resolveGridMapDirectorySelection, resolveNextGridMapDirectorySelectionTarget, type GridMapDirectoryNode } from '@/components/folia-grid/gridMapBatch';
import type { GridMapItem } from '@/components/GridMap';

// test/unit/gridView/gridMapBatch.test.ts

describe('GridMap batch selection', () => {
    it('defaults filtered cards to selected and deduplicates track ids in display order', () => {
        const items: GridMapItem[] = [
            { id: 'a', name: 'A', trackIds: ['1', '2'] },
            { id: 'b', name: 'B', trackIds: ['2', '3'] },
        ];

        expect(resolveGridMapBatchContext(items, new Set())).toEqual({
            items,
            trackIds: ['1', '2', '3'],
        });
    });

    it('excludes cards without changing the filtered display set', () => {
        const items: GridMapItem[] = [
            { id: 'a', name: 'A', trackIds: ['1'] },
            { id: 'b', name: 'B', trackIds: ['2'] },
        ];

        expect(resolveGridMapBatchContext(items, new Set(['a']))).toEqual({
            items: [items[1]],
            trackIds: ['2'],
        });
    });
});

describe('GridMap directory flattening', () => {
    const child: GridMapDirectoryNode = {
        id: 'root:root/child', name: 'child', path: 'root/child', rootPath: 'root', depth: 1,
        directTrackCount: 1, totalTrackCount: 1, children: [],
    };
    const root: GridMapDirectoryNode = {
        id: 'root:root', name: 'root', path: 'root', rootPath: 'root', depth: 0,
        directTrackCount: 0, totalTrackCount: 1, children: [child],
    };

    it('only exposes descendants of expanded nodes', () => {
        expect(flattenExpandedGridMapDirectories([root], new Set()).map(node => node.path)).toEqual(['root']);
        expect(flattenExpandedGridMapDirectories([root], new Set([root.id])).map(node => node.path)).toEqual(['root', 'root/child']);
    });

    it('resolves parent checkbox state from filtered descendant cards', () => {
        const items: GridMapItem[] = [
            { id: 'root', name: 'root', path: 'root', trackIds: ['1'] },
            { id: 'child', name: 'child', path: 'root/child', trackIds: ['2'] },
            { id: 'other', name: 'other', path: 'other', trackIds: ['3'] },
        ];

        expect(resolveGridMapDirectorySelection('root', items, new Set(['child']))).toEqual({
            itemIds: ['root', 'child'],
            directItemIds: ['root'],
            selectedCount: 1,
            state: 'direct',
        });
        expect(resolveGridMapDirectorySelection('root/child', items, new Set())).toEqual({
            itemIds: ['child'],
            directItemIds: ['child'],
            selectedCount: 1,
            state: 'all',
        });
    });

    it('cycles subtree selection through none and direct-folder-only states', () => {
        const items: GridMapItem[] = [
            { id: 'root', name: 'root', path: 'root', trackIds: ['1'] },
            { id: 'child', name: 'child', path: 'root/child', trackIds: ['2'] },
        ];
        const all = resolveGridMapDirectorySelection('root', items, new Set());
        const none = resolveGridMapDirectorySelection('root', items, new Set(['root', 'child']));
        const direct = resolveGridMapDirectorySelection('root', items, new Set(['child']));

        expect(resolveNextGridMapDirectorySelectionTarget(all)).toBe('none');
        expect(resolveNextGridMapDirectorySelectionTarget(none)).toBe('direct');
        expect(resolveNextGridMapDirectorySelectionTarget(direct)).toBe('all');
    });

    it('keeps leaf folders on a two-state selection cycle', () => {
        const items: GridMapItem[] = [{ id: 'leaf', name: 'leaf', path: 'root/leaf', trackIds: ['1'] }];
        const none = resolveGridMapDirectorySelection('root/leaf', items, new Set(['leaf']));

        expect(resolveNextGridMapDirectorySelectionTarget(none)).toBe('all');
    });

    it('compacts deep single-child chains but keeps roots and branching nodes separate', () => {
        const leaf: GridMapDirectoryNode = {
            id: 'root:a/b/c', name: 'c', path: 'root/a/b/c', rootPath: 'root', depth: 3,
            directTrackCount: 1, totalTrackCount: 1, children: [],
        };
        const middleB: GridMapDirectoryNode = {
            ...leaf, id: 'root:a/b', name: 'b', path: 'root/a/b', depth: 2,
            directTrackCount: 0, children: [leaf],
        };
        const middleA: GridMapDirectoryNode = {
            ...middleB, id: 'root:a', name: 'a', path: 'root/a', depth: 1,
            children: [middleB],
        };
        const deepRoot: GridMapDirectoryNode = {
            ...middleA, id: 'root:root', name: 'root', path: 'root', depth: 0,
            children: [middleA],
        };

        const [compactedRoot] = compactGridMapDirectoryTrees([deepRoot]);

        expect(compactedRoot.name).toBe('root');
        expect(compactedRoot.children[0]).toMatchObject({
            id: leaf.id,
            name: 'a / b / c',
            path: leaf.path,
            depth: 1,
        });
    });

    it('stops compacting when an intermediate folder contains direct tracks', () => {
        const trackedParent: GridMapDirectoryNode = {
            id: 'root:a', name: 'a', path: 'root/a', rootPath: 'root', depth: 1,
            directTrackCount: 1, totalTrackCount: 2, children: [{
                id: 'root:a/b', name: 'b', path: 'root/a/b', rootPath: 'root', depth: 2,
                directTrackCount: 1, totalTrackCount: 1, children: [],
            }],
        };
        const deepRoot: GridMapDirectoryNode = {
            id: 'root:root', name: 'root', path: 'root', rootPath: 'root', depth: 0,
            directTrackCount: 0, totalTrackCount: 2, children: [trackedParent],
        };

        const [compactedRoot] = compactGridMapDirectoryTrees([deepRoot]);
        expect(compactedRoot.children[0].name).toBe('a');
        expect(compactedRoot.children[0].children[0].name).toBe('b');
    });

    it('keeps matching folders and their ancestors when filtering the tree', () => {
        const album: GridMapDirectoryNode = {
            id: 'root:music/album', name: 'album', path: 'music/album', rootPath: 'music', depth: 1,
            directTrackCount: 1, totalTrackCount: 1, children: [],
        };
        const other: GridMapDirectoryNode = {
            id: 'root:music/other', name: 'other', path: 'music/other', rootPath: 'music', depth: 1,
            directTrackCount: 1, totalTrackCount: 1, children: [],
        };
        const root: GridMapDirectoryNode = {
            id: 'root:music', name: 'music', path: 'music', rootPath: 'music', depth: 0,
            directTrackCount: 0, totalTrackCount: 2, children: [album, other],
        };

        const [filteredRoot] = filterGridMapDirectoryTreesByItems([root], [
            { id: 'album', name: 'album', path: 'music/album' },
        ]);

        expect(filteredRoot.path).toBe('music');
        expect(filteredRoot.children.map(node => node.path)).toEqual(['music/album']);
    });
});
