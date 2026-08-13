import type { GridMapItem } from '../GridMap';

// src/components/folia-grid/gridMapBatch.ts

export interface GridMapDirectoryNode {
    id: string;
    name: string;
    path: string;
    rootPath: string;
    depth: number;
    directTrackCount: number;
    totalTrackCount: number;
    children: GridMapDirectoryNode[];
}

export interface GridMapBatchContext {
    items: GridMapItem[];
    trackIds: string[];
}

export interface GridMapBatchConfig {
    selectionType: 'folders' | 'albums' | 'artists';
    directoryTrees?: GridMapDirectoryNode[];
    onPlay: (context: GridMapBatchContext) => Promise<void> | void;
    onAddToQueue: (context: GridMapBatchContext) => Promise<void> | void;
    onCreatePlaylist: (name: string, context: GridMapBatchContext) => Promise<void> | void;
    onRemove?: (context: GridMapBatchContext) => Promise<void> | void;
    onRescanRoot?: (rootPath: string) => Promise<void> | void;
    onRemoveRoot?: (rootPath: string) => Promise<void> | void;
}

export interface GridMapDirectorySelection {
    itemIds: string[];
    directItemIds: string[];
    selectedCount: number;
    state: 'none' | 'partial' | 'direct' | 'all';
}

export type GridMapDirectorySelectionTarget = 'none' | 'direct' | 'all';

// Resolves the filtered-by-query batch scope while preserving card and track order.
export const resolveGridMapBatchContext = (
    displayItems: GridMapItem[],
    excludedItemIds: ReadonlySet<string>,
): GridMapBatchContext => {
    const items = displayItems.filter(item => !excludedItemIds.has(String(item.id)));
    const seenTrackIds = new Set<string>();
    const trackIds: string[] = [];

    for (const item of items) {
        for (const trackId of item.trackIds || []) {
            if (seenTrackIds.has(trackId)) continue;
            seenTrackIds.add(trackId);
            trackIds.push(trackId);
        }
    }

    return { items, trackIds };
};

export const flattenExpandedGridMapDirectories = (
    roots: GridMapDirectoryNode[],
    expandedIds: ReadonlySet<string>,
): GridMapDirectoryNode[] => {
    const flattened: GridMapDirectoryNode[] = [];

    const visit = (node: GridMapDirectoryNode) => {
        flattened.push(node);
        if (!expandedIds.has(node.id)) return;
        node.children.forEach(visit);
    };

    roots.forEach(visit);
    return flattened;
};

// Compacts single-child folder chains like VS Code while preserving actionable path identity.
export const compactGridMapDirectoryTrees = (
    roots: GridMapDirectoryNode[],
): GridMapDirectoryNode[] => {
    const compactNode = (
        source: GridMapDirectoryNode,
        visualDepth: number,
        preserveNode: boolean,
    ): GridMapDirectoryNode => {
        let terminal = source;
        const names = [source.name];

        if (!preserveNode) {
            while (terminal.directTrackCount === 0 && terminal.children.length === 1) {
                terminal = terminal.children[0];
                names.push(terminal.name);
            }
        }

        return {
            ...terminal,
            name: names.join(' / '),
            depth: visualDepth,
            children: terminal.children.map(child => compactNode(child, visualDepth + 1, false)),
        };
    };

    return roots.map(root => compactNode(root, 0, true));
};

// Keeps search-matching folders and their ancestors so tree context is never lost.
export const filterGridMapDirectoryTreesByItems = (
    roots: GridMapDirectoryNode[],
    items: readonly GridMapItem[],
): GridMapDirectoryNode[] => {
    const itemPaths = items.map(item => (item.path || item.name)
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '')
        .toLocaleLowerCase());

    const filterNode = (node: GridMapDirectoryNode): GridMapDirectoryNode | null => {
        const nodePath = node.path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLocaleLowerCase();
        const children = node.children
            .map(filterNode)
            .filter((child): child is GridMapDirectoryNode => Boolean(child));
        const isContextOrMatch = itemPaths.some(path => (
            path === nodePath || path.startsWith(`${nodePath}/`)
        ));
        return isContextOrMatch || children.length > 0 ? { ...node, children } : null;
    };

    return roots.map(filterNode).filter((root): root is GridMapDirectoryNode => Boolean(root));
};

// Resolves one tree node against the currently filtered GridMap cards.
export const resolveGridMapDirectorySelection = (
    nodePath: string,
    displayItems: readonly GridMapItem[],
    excludedItemIds: ReadonlySet<string>,
): GridMapDirectorySelection => {
    const normalizedPath = nodePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLocaleLowerCase();
    const itemIds = displayItems
        .filter(item => {
            const itemPath = (item.path || item.name)
                .replace(/\\/g, '/')
                .replace(/^\/+|\/+$/g, '')
                .toLocaleLowerCase();
            return itemPath === normalizedPath || itemPath.startsWith(`${normalizedPath}/`);
        })
        .map(item => String(item.id));
    const directItemIds = displayItems
        .filter(item => {
            const itemPath = (item.path || item.name)
                .replace(/\\/g, '/')
                .replace(/^\/+|\/+$/g, '')
                .toLocaleLowerCase();
            return itemPath === normalizedPath;
        })
        .map(item => String(item.id));
    const selectedCount = itemIds.reduce(
        (count, itemId) => count + (excludedItemIds.has(itemId) ? 0 : 1),
        0,
    );
    const directSelectedCount = directItemIds.reduce(
        (count, itemId) => count + (excludedItemIds.has(itemId) ? 0 : 1),
        0,
    );
    const hasOnlyDirectItemsSelected = directItemIds.length > 0
        && directSelectedCount === directItemIds.length
        && selectedCount === directSelectedCount;

    return {
        itemIds,
        directItemIds,
        selectedCount,
        state: selectedCount === 0
            ? 'none'
            : selectedCount === itemIds.length
                ? 'all'
                : hasOnlyDirectItemsSelected
                    ? 'direct'
                    : 'partial',
    };
};

// Cycles a directory between subtree selection, no selection, and direct tracks only.
export const resolveNextGridMapDirectorySelectionTarget = (
    selection: GridMapDirectorySelection,
): GridMapDirectorySelectionTarget => {
    if (selection.state === 'all') return 'none';
    if (selection.state === 'none' && selection.directItemIds.length > 0 && selection.directItemIds.length < selection.itemIds.length) {
        return 'direct';
    }
    return 'all';
};
