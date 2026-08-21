// src/components/folia-grid/gridItemVisibility.ts

const HIDEABLE_GRID_ITEM_TYPES = new Set([
    'playlist',
    'cloud',
    'radio',
    'daily_recommendations',
]);

export interface GridItemVisibilityTarget {
    type?: string;
}

export const isHideableGridItem = (item: GridItemVisibilityTarget): boolean => (
    Boolean(item.type && HIDEABLE_GRID_ITEM_TYPES.has(item.type))
);
