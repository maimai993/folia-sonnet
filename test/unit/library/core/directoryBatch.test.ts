import { describe, expect, it } from 'vitest';
import { compactDirectoryTrees, filterDirectoryTreesByItems, flattenExpandedDirectoryNodes, resolveDirectoryBatchActions, resolveDirectoryBatchContext, resolveDirectoryNodeSelection, resolveNextDirectoryNodeSelectionTarget } from '@/library/core/model/directoryBatch';
import type { LibraryDirectoryBatchConfig, LibraryDirectoryItem, LibraryDirectoryNode } from '@/library/core/contracts/directory';

// test/unit/library/core/directoryBatch.test.ts

describe('directory batch scope', () => {
    it('defaults filtered cards to selected and deduplicates track ids in display order', () => {
        const items: LibraryDirectoryItem[] = [
            { id: 'a', name: 'A', trackIds: ['1', '2'] },
            { id: 'b', name: 'B', trackIds: ['2', '3'] },
        ];

        expect(resolveDirectoryBatchContext(items, new Set())).toEqual({
            items,
            trackIds: ['1', '2', '3'],
        });
    });

    it('excludes cards without changing the filtered display set', () => {
        const items: LibraryDirectoryItem[] = [
            { id: 'a', name: 'A', trackIds: ['1'] },
            { id: 'b', name: 'B', trackIds: ['2'] },
        ];

        expect(resolveDirectoryBatchContext(items, new Set(['a']))).toEqual({
            items: [items[1]],
            trackIds: ['2'],
        });
    });
});

describe('directory tree', () => {
    const child: LibraryDirectoryNode = {
        id: 'root:root/child', name: 'child', path: 'root/child', rootPath: 'root', depth: 1,
        directTrackCount: 1, totalTrackCount: 1, children: [],
    };
    const root: LibraryDirectoryNode = {
        id: 'root:root', name: 'root', path: 'root', rootPath: 'root', depth: 0,
        directTrackCount: 0, totalTrackCount: 1, children: [child],
    };

    it('only exposes descendants of expanded nodes', () => {
        expect(flattenExpandedDirectoryNodes([root], new Set()).map(node => node.path)).toEqual(['root']);
        expect(flattenExpandedDirectoryNodes([root], new Set([root.id])).map(node => node.path)).toEqual(['root', 'root/child']);
    });

    it('resolves parent checkbox state from filtered descendant cards', () => {
        const items: LibraryDirectoryItem[] = [
            { id: 'root', name: 'root', path: 'root', trackIds: ['1'] },
            { id: 'child', name: 'child', path: 'root/child', trackIds: ['2'] },
            { id: 'other', name: 'other', path: 'other', trackIds: ['3'] },
        ];

        expect(resolveDirectoryNodeSelection('root', items, new Set(['child']))).toEqual({
            itemIds: ['root', 'child'],
            directItemIds: ['root'],
            selectedCount: 1,
            state: 'direct',
        });
        expect(resolveDirectoryNodeSelection('root/child', items, new Set())).toEqual({
            itemIds: ['child'],
            directItemIds: ['child'],
            selectedCount: 1,
            state: 'all',
        });
    });

    it('cycles subtree selection through none and direct-folder-only states', () => {
        const items: LibraryDirectoryItem[] = [
            { id: 'root', name: 'root', path: 'root', trackIds: ['1'] },
            { id: 'child', name: 'child', path: 'root/child', trackIds: ['2'] },
        ];
        const all = resolveDirectoryNodeSelection('root', items, new Set());
        const none = resolveDirectoryNodeSelection('root', items, new Set(['root', 'child']));
        const direct = resolveDirectoryNodeSelection('root', items, new Set(['child']));

        expect(resolveNextDirectoryNodeSelectionTarget(all)).toBe('none');
        expect(resolveNextDirectoryNodeSelectionTarget(none)).toBe('direct');
        expect(resolveNextDirectoryNodeSelectionTarget(direct)).toBe('all');
    });

    it('keeps leaf folders on a two-state selection cycle', () => {
        const items: LibraryDirectoryItem[] = [{ id: 'leaf', name: 'leaf', path: 'root/leaf', trackIds: ['1'] }];
        const none = resolveDirectoryNodeSelection('root/leaf', items, new Set(['leaf']));

        expect(resolveNextDirectoryNodeSelectionTarget(none)).toBe('all');
    });

    it('compacts deep single-child chains but keeps roots and branching nodes separate', () => {
        const leaf: LibraryDirectoryNode = {
            id: 'root:a/b/c', name: 'c', path: 'root/a/b/c', rootPath: 'root', depth: 3,
            directTrackCount: 1, totalTrackCount: 1, children: [],
        };
        const middleB: LibraryDirectoryNode = {
            ...leaf, id: 'root:a/b', name: 'b', path: 'root/a/b', depth: 2,
            directTrackCount: 0, children: [leaf],
        };
        const middleA: LibraryDirectoryNode = {
            ...middleB, id: 'root:a', name: 'a', path: 'root/a', depth: 1,
            children: [middleB],
        };
        const deepRoot: LibraryDirectoryNode = {
            ...middleA, id: 'root:root', name: 'root', path: 'root', depth: 0,
            children: [middleA],
        };

        const [compactedRoot] = compactDirectoryTrees([deepRoot]);

        expect(compactedRoot.name).toBe('root');
        expect(compactedRoot.children[0]).toMatchObject({
            id: leaf.id,
            name: 'a / b / c',
            path: leaf.path,
            depth: 1,
        });
    });

    it('stops compacting when an intermediate folder contains direct tracks', () => {
        const trackedParent: LibraryDirectoryNode = {
            id: 'root:a', name: 'a', path: 'root/a', rootPath: 'root', depth: 1,
            directTrackCount: 1, totalTrackCount: 2, children: [{
                id: 'root:a/b', name: 'b', path: 'root/a/b', rootPath: 'root', depth: 2,
                directTrackCount: 1, totalTrackCount: 1, children: [],
            }],
        };
        const deepRoot: LibraryDirectoryNode = {
            id: 'root:root', name: 'root', path: 'root', rootPath: 'root', depth: 0,
            directTrackCount: 0, totalTrackCount: 2, children: [trackedParent],
        };

        const [compactedRoot] = compactDirectoryTrees([deepRoot]);
        expect(compactedRoot.children[0].name).toBe('a');
        expect(compactedRoot.children[0].children[0].name).toBe('b');
    });

    it('keeps matching folders and their ancestors when filtering the tree', () => {
        const album: LibraryDirectoryNode = {
            id: 'root:music/album', name: 'album', path: 'music/album', rootPath: 'music', depth: 1,
            directTrackCount: 1, totalTrackCount: 1, children: [],
        };
        const other: LibraryDirectoryNode = {
            id: 'root:music/other', name: 'other', path: 'music/other', rootPath: 'music', depth: 1,
            directTrackCount: 1, totalTrackCount: 1, children: [],
        };
        const root: LibraryDirectoryNode = {
            id: 'root:music', name: 'music', path: 'music', rootPath: 'music', depth: 0,
            directTrackCount: 0, totalTrackCount: 2, children: [album, other],
        };

        const [filteredRoot] = filterDirectoryTreesByItems([root], [
            { id: 'album', name: 'album', path: 'music/album' },
        ]);

        expect(filteredRoot.path).toBe('music');
        expect(filteredRoot.children.map(node => node.path)).toEqual(['music/album']);
    });
});

describe('directory batch actions', () => {
    const noop = () => undefined;
    const base: LibraryDirectoryBatchConfig = {
        selectionType: 'albums',
        onPlay: noop,
        onAddToQueue: noop,
        onCreatePlaylist: noop,
    };

    it('always offers play, enqueue and create-playlist', () => {
        expect(resolveDirectoryBatchActions(base)).toEqual(['play', 'enqueue', 'create-playlist']);
    });

    it('adds the folder actions the config implements, in a fixed order', () => {
        expect(resolveDirectoryBatchActions({
            ...base,
            selectionType: 'folders',
            onClearFolderIgnore: noop,
            onRemoveRoot: noop,
            onRemove: noop,
            onRescanRoot: noop,
        })).toEqual(['play', 'enqueue', 'create-playlist', 'remove', 'rescan-root', 'remove-root', 'clear-ignore']);
        expect(resolveDirectoryBatchActions({ ...base, onRemoveRoot: noop })).toEqual(['play', 'enqueue', 'create-playlist', 'remove-root']);
    });
});
