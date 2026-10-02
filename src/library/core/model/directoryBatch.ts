import type {
    LibraryDirectoryBatchActionId,
    LibraryDirectoryBatchConfig,
    LibraryDirectoryBatchContext,
    LibraryDirectoryItem,
    LibraryDirectoryNode,
    LibraryDirectoryNodeSelection,
    LibraryDirectoryNodeSelectionTarget,
} from '../contracts/directory';
import { matchesDirectorySearch } from './directorySearch';

// src/library/core/model/directoryBatch.ts
// 目录批量的纯规则（原网格的 gridMapBatch）：批量范围、目录树的展开 / 压缩 / 筛选、树节点的三态选择、
// 一个 section 提供哪些批量动作。

/** 条目路径的比较形式：统一斜杠、去掉首尾斜杠、不区分大小写；没有 path 的条目用名称。 */
const normalizeItemPath = (item: Pick<LibraryDirectoryItem, 'path' | 'name'>) => (item.path || item.name)
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .toLocaleLowerCase();

const normalizeNodePath = (path: string) => path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLocaleLowerCase();

// Resolves the filtered-by-query batch scope while preserving card and track order.
export const resolveDirectoryBatchContext = <TItem extends LibraryDirectoryItem>(
    displayItems: TItem[],
    excludedItemIds: ReadonlySet<string>,
): LibraryDirectoryBatchContext<TItem> => {
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

export const flattenExpandedDirectoryNodes = (
    roots: LibraryDirectoryNode[],
    expandedIds: ReadonlySet<string>,
): LibraryDirectoryNode[] => {
    const flattened: LibraryDirectoryNode[] = [];

    const visit = (node: LibraryDirectoryNode) => {
        flattened.push(node);
        if (!expandedIds.has(node.id)) return;
        node.children.forEach(visit);
    };

    roots.forEach(visit);
    return flattened;
};

// Compacts single-child folder chains like VS Code while preserving actionable path identity.
export const compactDirectoryTrees = (
    roots: LibraryDirectoryNode[],
): LibraryDirectoryNode[] => {
    const compactNode = (
        source: LibraryDirectoryNode,
        visualDepth: number,
        preserveNode: boolean,
    ): LibraryDirectoryNode => {
        let terminal = source;
        const names = [source.name];

        if (!preserveNode) {
            while (!terminal.ignored && terminal.directTrackCount === 0 && terminal.children.length === 1 && !terminal.children[0].ignored) {
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
export const filterDirectoryTreesByItems = (
    roots: LibraryDirectoryNode[],
    items: readonly LibraryDirectoryItem[],
    query = '',
): LibraryDirectoryNode[] => {
    const itemPaths = items.map(normalizeItemPath);

    const filterNode = (node: LibraryDirectoryNode): LibraryDirectoryNode | null => {
        const nodePath = normalizeNodePath(node.path);
        const children = node.children
            .map(filterNode)
            .filter((child): child is LibraryDirectoryNode => Boolean(child));
        const isContextOrMatch = itemPaths.some(path => (
            path === nodePath || path.startsWith(`${nodePath}/`)
        ));
        const matchesIgnoredFolder = node.ignored && query.trim() && matchesDirectorySearch(node, query);
        return isContextOrMatch || matchesIgnoredFolder || children.length > 0 ? { ...node, children } : null;
    };

    return roots.map(filterNode).filter((root): root is LibraryDirectoryNode => Boolean(root));
};

// Resolves one tree node against the currently filtered directory items.
export const resolveDirectoryNodeSelection = (
    nodePath: string,
    displayItems: readonly LibraryDirectoryItem[],
    excludedItemIds: ReadonlySet<string>,
): LibraryDirectoryNodeSelection => {
    const normalizedPath = normalizeNodePath(nodePath);
    const itemIds = displayItems
        .filter(item => {
            const itemPath = normalizeItemPath(item);
            return itemPath === normalizedPath || itemPath.startsWith(`${normalizedPath}/`);
        })
        .map(item => String(item.id));
    const directItemIds = displayItems
        .filter(item => normalizeItemPath(item) === normalizedPath)
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
export const resolveNextDirectoryNodeSelectionTarget = (
    selection: LibraryDirectoryNodeSelection,
): LibraryDirectoryNodeSelectionTarget => {
    if (selection.state === 'all') return 'none';
    if (selection.state === 'none' && selection.directItemIds.length > 0 && selection.directItemIds.length < selection.itemIds.length) {
        return 'direct';
    }
    return 'all';
};

/** 一个批量配置实际提供的动作，按固定顺序（面板按钮与命令都按这个顺序）。 */
export const resolveDirectoryBatchActions = (
    config: LibraryDirectoryBatchConfig,
): LibraryDirectoryBatchActionId[] => [
    'play',
    'enqueue',
    'create-playlist',
    ...(config.onRemove ? ['remove' as const] : []),
    ...(config.onRescanRoot ? ['rescan-root' as const] : []),
    ...(config.onRemoveRoot ? ['remove-root' as const] : []),
    ...(config.onClearFolderIgnore ? ['clear-ignore' as const] : []),
];
