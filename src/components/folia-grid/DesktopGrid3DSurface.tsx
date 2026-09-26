import React, { useMemo, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Map as MapIcon } from 'lucide-react';
import GridMap from '../GridMap';
import { Theme } from '../../types';
import { Grid3DSlider, Grid3DSliderItem } from './Grid3DSlider';
import { GridViewTabs, gridChromeClassesFor } from './GridViewTabs';
import type { GridMapBatchConfig } from './gridMapBatch';
import { isHideableGridItem } from './gridItemVisibility';
import { useHomeCardPosition } from '../../hooks/useHomeCardPosition';

// src/components/folia-grid/DesktopGrid3DSurface.tsx
// Shared desktop home surface that keeps Grid3D slider and GridMap controls visually consistent.

export interface DesktopGrid3DAction {
    id: string;
    label: React.ReactNode;
    icon?: React.ReactNode;
    onClick: () => void;
    active?: boolean;
    disabled?: boolean;
    title?: string;
}

const HIDDEN_GRID_PLAYLISTS_STORAGE_KEY = 'hidden_grid_playlists';

const readHiddenGridPlaylists = (): Record<string, string[]> => {
    if (typeof window === 'undefined') return {};

    try {
        const stored = localStorage.getItem(HIDDEN_GRID_PLAYLISTS_STORAGE_KEY);
        const parsed = stored ? JSON.parse(stored) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

        return Object.fromEntries(
            Object.entries(parsed).map(([scope, ids]) => [
                scope,
                Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [],
            ]),
        );
    } catch {
        return {};
    }
};

interface DesktopGrid3DSurfaceProps {
    focusMemoryScope?: string;
    title: string;
    mapButtonLabel: string;
    items: Grid3DSliderItem[];
    focusedIndex: number;
    onFocusedIndexChange: (index: number) => void;
    onSelect: (item: Grid3DSliderItem, index: number) => void;
    tabs?: DesktopGrid3DAction[];
    actions?: DesktopGrid3DAction[];
    isInteractive?: boolean;
    isLoading?: boolean;
    emptyMessage?: string;
    theme: Theme;
    isDaylight: boolean;
    hasFloatingPlayer?: boolean;
    playlistVisibilityScope?: string;
    batchConfig?: GridMapBatchConfig;
    ponderControls?: 'local-grid-controls';
    gridMapPonderScope?: 'local-grid-map-page';
}

export const DesktopGrid3DSurface: React.FC<DesktopGrid3DSurfaceProps> = ({
    focusMemoryScope,
    title,
    mapButtonLabel,
    items,
    focusedIndex: legacyFocusedIndex,
    onFocusedIndexChange: onLegacyFocusedIndexChange,
    onSelect,
    tabs = [],
    actions = [],
    isInteractive = true,
    isLoading = false,
    emptyMessage,
    theme,
    isDaylight,
    hasFloatingPlayer = false,
    playlistVisibilityScope = 'default',
    batchConfig,
    ponderControls,
    gridMapPonderScope,
}) => {
    const [showGridMap, setShowGridMap] = useState(false);
    const chrome = gridChromeClassesFor(isDaylight);
    const [hiddenPlaylistsByScope, setHiddenPlaylistsByScope] = useState(readHiddenGridPlaylists);
    const { focusedIndex, onFocusedIndexChange } = useHomeCardPosition(
        focusMemoryScope, items, legacyFocusedIndex, onLegacyFocusedIndexChange, isLoading,
    );

    const hiddenPlaylistIds = useMemo(
        () => new Set(hiddenPlaylistsByScope[playlistVisibilityScope] || []),
        [hiddenPlaylistsByScope, playlistVisibilityScope],
    );
    const visibleItems = useMemo(
        () => items.filter(item => !isHideableGridItem(item) || !hiddenPlaylistIds.has(String(item.id))),
        [hiddenPlaylistIds, items],
    );
    const visibleFocusedIndex = useMemo(() => {
        const focusedItem = items[focusedIndex];
        const nextIndex = focusedItem ? visibleItems.indexOf(focusedItem) : -1;
        return nextIndex >= 0 ? nextIndex : 0;
    }, [focusedIndex, items, visibleItems]);

    const handleVisibleFocusedIndexChange = (index: number) => {
        const sourceIndex = items.indexOf(visibleItems[index]);
        if (sourceIndex >= 0) onFocusedIndexChange(sourceIndex);
    };

    const handleVisibleSelect = (item: Grid3DSliderItem, index: number) => {
        const sourceIndex = items.indexOf(item);
        if (sourceIndex >= 0) onFocusedIndexChange(sourceIndex);
        onSelect(item, sourceIndex >= 0 ? sourceIndex : index);
    };

    const togglePlaylistHidden = (item: Grid3DSliderItem) => {
        if (!isHideableGridItem(item)) return;

        const id = String(item.id);
        setHiddenPlaylistsByScope(previous => {
            const current = new Set(previous[playlistVisibilityScope] || []);
            if (current.has(id)) {
                current.delete(id);
            } else {
                current.add(id);
            }

            const next = { ...previous, [playlistVisibilityScope]: [...current] };
            try {
                localStorage.setItem(HIDDEN_GRID_PLAYLISTS_STORAGE_KEY, JSON.stringify(next));
            } catch {
                // Keep the visibility change for this session when storage is unavailable.
            }
            return next;
        });
    };

    return (
        <div data-ponder-page-scope="grid-page" className="w-full h-full min-h-0 flex flex-col justify-center relative">
            {/* One row under the home header, on the header's own max-w-7xl grid so it shares its
                centre line: the second-level capsule (the map of all cards, then the collection
                types) sits right under the header's view capsule, the library actions on the right
                under the search box. The row itself lets clicks through to the grid; only the
                controls take them. */}
            <div className="pointer-events-none absolute inset-x-0 top-2 z-10">
                <div className="mx-auto grid w-full max-w-7xl grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 md:px-8">
                    <div />
                    <div className="flex justify-center">
                        {(!isLoading || tabs.length > 0) && (
                            <GridViewTabs
                                tabs={tabs}
                                isDaylight={isDaylight}
                                onOpenMap={isLoading ? undefined : () => setShowGridMap(true)}
                                mapLabel={mapButtonLabel}
                                mapIcon={<MapIcon size={13} />}
                                ponderId={ponderControls}
                            />
                        )}
                    </div>

                    <div className="flex min-w-0 justify-end">
                        {actions.length > 0 && (
                            <div data-ponder={ponderControls} className="pointer-events-auto flex flex-wrap items-center justify-end gap-2">
                                {actions.map(action => (
                                    <button
                                        key={action.id}
                                        onClick={action.onClick}
                                        disabled={action.disabled}
                                        title={action.title}
                                        className={`flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-medium backdrop-blur-md transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${chrome.pill} ${
                                            action.active ? chrome.strongText : chrome.softText
                                        }`}
                                    >
                                        {action.icon}
                                        <span className="whitespace-nowrap">{action.label}</span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <Grid3DSlider
                key={focusMemoryScope}
                items={visibleItems}
                focusedIndex={visibleFocusedIndex}
                onFocusedIndexChange={handleVisibleFocusedIndexChange}
                onSelect={handleVisibleSelect}
                isInteractive={isInteractive && !showGridMap}
                isLoading={isLoading}
                emptyMessage={emptyMessage}
                isDaylight={isDaylight}
                hasFloatingPlayer={hasFloatingPlayer}
            />

            <AnimatePresence>
                {showGridMap && (
                    <GridMap
                        title={title}
                        items={items.map(item => ({
                            id: item.id,
                            name: typeof item.name === 'string' || typeof item.name === 'number' ? String(item.name) : '',
                            coverUrl: item.coverUrl,
                            description: item.type === 'folder' && !item.isVirtual
                                ? String(item.name)
                                : item.description,
                            summary: item.summary,
                            trackCount: item.trackCount,
                            type: item.type,
                            path: item.type === 'folder' && !item.isVirtual ? String(item.name) : undefined,
                            trackIds: item.trackIds,
                            rawCollection: item,
                        }))}
                        initialFocusedIndex={focusedIndex}
                        onBack={() => setShowGridMap(false)}
                        onSelectCollection={(_, index) => {
                            setShowGridMap(false);
                            onFocusedIndexChange(index);
                        }}
                        onActivateCollection={(collection, index) => {
                            setShowGridMap(false);
                            onFocusedIndexChange(index);
                            onSelect(collection, index);
                        }}
                        isInteractive={isInteractive}
                        theme={theme}
                        isDaylight={isDaylight}
                        isPlaylistHidden={(item) => hiddenPlaylistIds.has(String(item.id))}
                        onTogglePlaylistHidden={togglePlaylistHidden}
                        batchConfig={batchConfig}
                        ponderPageScope={gridMapPonderScope}
                    />
                )}
            </AnimatePresence>
        </div>
    );
};

export default DesktopGrid3DSurface;
