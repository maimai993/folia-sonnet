import type { LibraryDirectoryItem } from '../contracts/directory';

// src/library/core/model/directoryVisibility.ts
// 目录条目能否隐藏（原网格的 gridItemVisibility）。

const HIDEABLE_DIRECTORY_ITEM_TYPES = new Set([
    'playlist',
    'cloud',
    'radio',
    'daily_recommendations',
]);

export type DirectoryVisibilityTarget = Pick<LibraryDirectoryItem, 'type' | 'hideable'>;

/** 只有歌单类条目可隐藏；条目显式给了 `hideable` 时以它为准。 */
export const isHideableDirectoryItem = (item: DirectoryVisibilityTarget): boolean => (
    item.hideable ?? Boolean(item.type && HIDEABLE_DIRECTORY_ITEM_TYPES.has(item.type))
);
