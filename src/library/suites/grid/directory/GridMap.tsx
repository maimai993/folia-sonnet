import { useWindowButtonsAtTopLeft } from '../../../../hooks/useWindowButtonsAtTopLeft';
import React, { useCallback, useEffect, useMemo, useRef, useState, useDeferredValue } from 'react';
import { motion, AnimatePresence, useDragControls } from 'framer-motion';
import { ChevronLeft, Eye, EyeOff, ListFilter } from 'lucide-react';
import GridPanelToggleIndicator from '../shared/GridPanelToggleIndicator';
import { useTranslation } from 'react-i18next';
import { Theme } from '../../../../types';
import { SidePanelList, CollectionListItem } from '../../../../components/shared/SidePanelList';
import { GridListSearchButton } from '../../../../components/shared/GridListSearchButton';
import { useGridCommandFilter } from '../../../../hooks/useGridCommandFilter';
import GridMapBatchPanel from './GridMapBatchPanel';
import { useGridMapCards } from './useGridMapCards';
import { useGridMapViewport } from './useGridMapViewport';
import type { LibraryDirectoryBatchConfig, LibraryDirectoryBatchContext, LibraryDirectoryItem } from '../../../core/directory/directory.contract';
import { DEFAULT_DIRECTORY_SESSION_ID } from '../../../core/directory/directorySession';
import { getLibraryDirectorySession } from '../../../core/directory/useLibraryDirectorySessionStore';
import { useLibraryDirectoryQuery } from '../../../core/directory/useLibraryDirectoryQuery';
import { useLibraryDirectorySelection } from '../../../core/directory/useLibraryDirectorySelection';
import { useLibraryDirectoryVisibility } from '../../../core/directory/useLibraryDirectoryVisibility';
import { useLibraryDirectoryScope } from '../../../core/directory/useLibraryDirectoryScope';
import { useLibraryDirectoryActions } from '../../../core/directory/useLibraryDirectoryActions';
import { useLibraryDirectorySurfaceRegistration } from '../../../core/directory/useLibraryDirectorySurfaceRegistration';
import { filterDeclaredDirectorySurfaceActions, resolveDirectorySurfaceActions } from '../../../core/directory/directorySurface';
import type { LibraryDeclaredActions } from '../../../core/suite/suite.contract';
import {
    resolveGridMapEscapeAction,
    resolveGridMapSourceIndex,
    shouldSuppressGridMapSelection,
} from './gridMapNavigation';
import { isHideableDirectoryItem } from '../../../core/directory/directoryVisibility';
import { useSidePanelBottomPx } from '../../../../hooks/usePlayerBottomBarBottomPx';
import { hasBlockingWindow, isTextEntryTarget } from '../../../../utils/keyboardTargets';
import { Button } from '../../../../components/ui';

// src/library/suites/grid/directory/GridMap.tsx
// Hexagonal honeycomb layout showing all collections (playlists, albums, radios).
// Click on any collection card to select it and jump/center to it in Grid3D view.

/**
 * GridMap 的一张卡：目录条目的契约（core/directory/directory.contract）加上网格自己随卡带回的原对象。
 * rawCollection 只在网格内部流转（点卡时原样交回 onSelectCollection），core 不认识它。
 */
export interface GridMapItem extends LibraryDirectoryItem {
    rawCollection?: unknown;
}

/** 旧名：批量配置与批量范围的契约在 core/directory/directory.contract。 */
export type GridMapBatchConfig = LibraryDirectoryBatchConfig;
export type GridMapBatchContext = LibraryDirectoryBatchContext<GridMapItem>;

interface GridMapProps {
    /** 目录会话 key（core/directory/directorySession 的 directoryKey）：筛选词、批选、隐藏视图都存在会话里。 */
    directoryKey?: string;
    /**
     * 网格 suite 在 entry 里声明的首页动作。目录 surface 发布的命令 = core 判定 ∩ 声明（与 TUI 的目录相同）；
     * 不给时（单独挂 GridMap 的地方）只按 core 判定。
     */
    declaredHomeActions?: LibraryDeclaredActions;
    title: string;
    subtitle?: string;
    items: GridMapItem[];
    initialFocusedIndex?: number;
    onBack: () => void;
    onSelectCollection: (collection: any, index: number) => void;
    onActivateCollection?: (collection: any, index: number) => void;
    theme: Theme;
    isDaylight: boolean;
    isInteractive?: boolean;
    /** 当前作用域里隐藏的条目 id（来自 core 的隐藏 store，由外层按作用域取好）。 */
    hiddenIds?: ReadonlySet<string>;
    onTogglePlaylistHidden?: (item: GridMapItem) => void;
    batchConfig?: GridMapBatchConfig;
    ponderPageScope?: 'grid-page' | 'local-grid-map-page';
}

const NO_HIDDEN_IDS: ReadonlySet<string> = new Set();

export const GridMap: React.FC<GridMapProps> = ({
    directoryKey = DEFAULT_DIRECTORY_SESSION_ID,
    declaredHomeActions,
    title,
    subtitle,
    items = [],
    initialFocusedIndex = 0,
    onBack,
    onSelectCollection,
    onActivateCollection,
    theme,
    isDaylight,
    isInteractive = true,
    hiddenIds = NO_HIDDEN_IDS,
    onTogglePlaylistHidden,
    batchConfig,
    ponderPageScope = 'grid-page',
}) => {
    const { t } = useTranslation();
    const lowerBackButton = useWindowButtonsAtTopLeft();
    const bottomBarPanelBottomPx = useSidePanelBottomPx();
    const containerRef = useRef<HTMLDivElement>(null);
    const dragControls = useDragControls();
    const initialFocusedItemRef = useRef<GridMapItem | undefined>(items[initialFocusedIndex]);
    const lastUpdateRef = useRef(0);
    const pendingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const suppressSelectionRef = useRef(false);

    // 筛选词、批选与隐藏视图在 core 的目录会话里（换 suite 不丢；关地图时由外层清掉）。
    const { query: searchQuery, setQuery: setSearchQuery, port: queryPort } = useLibraryDirectoryQuery(directoryKey);
    // The filter box is the command palette now; this grid only says who owns typing and where the
    // box belongs. See useGridCommandFilter for why all three grids stopped carrying their own.
    const isFiltering = useGridCommandFilter({
        isInteractive,
        port: queryPort,
        // The box was an absolutely positioned child of the canvas; it still is.
        anchorRef: containerRef,
    });
    const deferredSearchQuery = useDeferredValue(searchQuery);

    const [showSidePanel, setShowSidePanel] = useState(false);
    // 侧面板（批量面板或隐藏管理面板）一般从关着开始；但目录会话跨 suite 保留：会话里已经有选择或管理隐藏视图时
    // （例如刚从 TUI 切过来），挂载时面板直接开着把它们显示出来——不是「打开面板」，所以不清选择。
    // 用户自己打开 / 关闭面板时清掉选择与隐藏视图仍是网格的规则（openCutInPanel / closeCutInPanel）。
    const [showCutInPanel, setShowCutInPanel] = useState(() => {
        const session = getLibraryDirectorySession(directoryKey);
        const restorable = session.selectedIds.length > 0 || session.visibilityMode !== 'browse';
        return restorable && (Boolean(batchConfig) || items.some(isHideableDirectoryItem));
    });
    // 批量面板「从曲库删除」的确认框；放在这里而不是面板里，命令面板的删除命令也只是把它打开。
    const [isRemoveConfirmOpen, setRemoveConfirmOpen] = useState(false);
    const {
        selectedIds: selectedBatchItemIds,
        setSelected: setBatchItemsSelected,
        toggleSelected: toggleBatchItemSelected,
        replaceSelection: replaceBatchSelection,
        resetSelection: resetBatchSelection,
    } = useLibraryDirectorySelection(directoryKey);
    // 隐藏编辑模式就是「管理隐藏」视图：显示全部并标出隐藏的（manage），或只看隐藏的（manage-hidden-only）。
    const {
        visibilityMode,
        setVisibilityMode,
        toggleManageHidden: togglePlaylistEditMode,
        toggleHiddenOnly,
    } = useLibraryDirectoryVisibility(directoryKey);
    const isPlaylistEditMode = visibilityMode !== 'browse';
    const showHiddenPlaylistsOnly = visibilityMode === 'manage-hidden-only';
    const hasHideableItems = useMemo(() => items.some(isHideableDirectoryItem), [items]);
    const hasCutInPanel = hasHideableItems || Boolean(batchConfig);

    const selectDisplayedItem = useCallback((item: GridMapItem, displayIndex: number) => {
        const sourceIndex = resolveGridMapSourceIndex(items, item, displayIndex);
        onSelectCollection(item.rawCollection || item, sourceIndex);
    }, [items, onSelectCollection]);
    const activateDisplayedItem = useCallback((item: GridMapItem, displayIndex: number) => {
        const sourceIndex = resolveGridMapSourceIndex(items, item, displayIndex);
        (onActivateCollection || onSelectCollection)(item.rawCollection || item, sourceIndex);
    }, [items, onActivateCollection, onSelectCollection]);

    // 范围 = 可见（隐藏视图）→ 筛选 → 选中；选中的按卡片顺序排（core/directory/directoryBatch）。
    const { displayItems, context: batchContext } = useLibraryDirectoryScope({
        items,
        hiddenIds,
        visibilityMode,
        query: deferredSearchQuery,
        selectedIds: selectedBatchItemIds,
    });

    // 打开与关闭侧面板都从空选择、浏览视图开始（原先的组件状态语义）。
    const openCutInPanel = useCallback(() => {
        resetBatchSelection();
        setRemoveConfirmOpen(false);
        setShowCutInPanel(true);
    }, [resetBatchSelection]);
    const closeCutInPanel = useCallback(() => {
        setShowCutInPanel(false);
        setRemoveConfirmOpen(false);
        resetBatchSelection();
    }, [resetBatchSelection]);

    // 命令面板的目录 surface：只在地图可交互时注册；动作能不能做读 core 的批量能力（与面板按钮同源），
    // 再与网格 suite 声明的首页动作取交集（与 TUI 的目录同一条规则：没声明的动作不出现在命令面板里）。
    const { capabilities: batchCapabilities, run: runBatchAction } = useLibraryDirectoryActions(batchConfig, batchContext);
    useLibraryDirectorySurfaceRegistration({
        isInteractive,
        getState: () => {
            const coreActions = resolveDirectorySurfaceActions({
                capabilities: batchCapabilities,
                context: batchContext,
                displayItemCount: displayItems.length,
                selectedItemCount: selectedBatchItemIds.size,
                hasHideableItems,
            });
            return {
                directoryKey,
                availableActions: declaredHomeActions
                    ? filterDeclaredDirectorySurfaceActions(coreActions, declaredHomeActions)
                    : coreActions,
                displayItemCount: displayItems.length,
                selectedItemCount: selectedBatchItemIds.size,
                selectedTrackCount: batchContext.trackIds.length,
                visibilityMode,
            };
        },
        run: (action, input) => {
            switch (action) {
                case 'play-selection':
                    void runBatchAction('play');
                    return true;
                case 'enqueue-selection':
                    void runBatchAction('enqueue');
                    return true;
                case 'create-playlist': {
                    const name = input?.trim();
                    if (!name) return false;
                    void runBatchAction('create-playlist', name);
                    return true;
                }
                case 'remove-selection':
                    // 与面板按钮一样先确认；确认框在批量面板里（有选中时面板一定开着）。
                    setRemoveConfirmOpen(true);
                    return true;
                case 'select-all':
                    if (!showCutInPanel) openCutInPanel();
                    replaceBatchSelection(displayItems.map(item => String(item.id)));
                    return true;
                case 'clear-selection':
                    replaceBatchSelection([]);
                    return true;
                case 'manage-hidden':
                    if (!showCutInPanel) {
                        openCutInPanel();
                        setVisibilityMode('manage');
                    } else {
                        togglePlaylistEditMode();
                    }
                    return true;
            }
            return false;
        },
    });


    const {
        containerSize,
        layoutConfig,
        clipRadius,
        dragX,
        dragY,
        dragBounds,
        focusedIndex,
        setFocusedIndex,
        focusedIndexRef,
        baseCoords,
        renderedIndexes,
        renderedIndexesRef,
        updateRenderedIndexesForViewport,
        centerOnIndex,
    } = useGridMapViewport({
        containerRef,
        itemCount: items.length,
        displayItems,
        deferredSearchQuery,
        initialFocusedItem: initialFocusedItemRef.current,
        pendingTimeoutRef,
        lastUpdateRef,
    });
    const { cards: memoizedCards, cardWrapperRefs } = useGridMapCards({
        displayItems,
        renderedIndexes,
        renderedIndexesRef,
        baseCoords,
        dragX,
        dragY,
        layoutConfig,
        clipRadius,
        focusedIndexRef,
        setFocusedIndex,
        pendingTimeoutRef,
        lastUpdateRef,
        updateRenderedIndexesForViewport,
        isDaylight,
        isPlaylistEditMode,
        hiddenIds,
        batchConfig,
        showCutInPanel,
        selectedBatchItemIds,
        toggleBatchItemSelected,
        onTogglePlaylistHidden,
        selectDisplayedItem,
        suppressSelectionRef,
    });


    useEffect(() => {
        if (!isInteractive) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            const target = e.target;
            if (
                target instanceof HTMLElement
                && (target.isContentEditable || Boolean(target.closest('button, input, select, textarea, a[href]')))
            ) return;

            if (e.key === 'Enter') {
                if (
                    e.repeat
                    || isFiltering
                    || showSidePanel
                    || showCutInPanel
                    || isPlaylistEditMode
                ) return;

                const focusedItem = displayItems[focusedIndex];
                if (!focusedItem) return;
                e.preventDefault();
                activateDisplayedItem(focusedItem, focusedIndex);
                return;
            }

            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
                e.preventDefault();
                if (displayItems.length === 0) return;

                const curr = baseCoords[focusedIndex];
                let bestNextIdx = focusedIndex;
                let minDist = Infinity;

                baseCoords.forEach((coord, idx) => {
                    if (idx === focusedIndex) return;

                    const dx = coord.baseX - curr.baseX;
                    const dy = coord.baseY - curr.baseY;

                    let isMatch = false;
                    if (e.key === 'ArrowLeft' && dx < -50 && Math.abs(dy) < 180) isMatch = true;
                    if (e.key === 'ArrowRight' && dx > 50 && Math.abs(dy) < 180) isMatch = true;
                    if (e.key === 'ArrowUp' && dy < -50 && Math.abs(dx) < 200) isMatch = true;
                    if (e.key === 'ArrowDown' && dy > 50 && Math.abs(dx) < 200) isMatch = true;

                    if (isMatch) {
                        const dist = dx * dx + dy * dy;
                        if (dist < minDist) {
                            minDist = dist;
                            bestNextIdx = idx;
                        }
                    }
                });

                if (bestNextIdx !== focusedIndex) {
                    centerOnIndex(bestNextIdx, true);
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [
        baseCoords,
        activateDisplayedItem,
        displayItems,
        focusedIndex,
        isFiltering,
        isInteractive,
        isPlaylistEditMode,
        showCutInPanel,
        showSidePanel,
    ]);

    // Automatically focus the grid map container on mount / when becoming interactive,
    // and when closing child panels, so keyboard navigation works immediately
    // without requiring a pointer click after opening from a trigger button.
    // A panel toggle clicked with the mouse keeps focus on itself, and the keydown guard ignores
    // buttons, so focus is taken back from anything except typing and windows that own the keyboard.
    useEffect(() => {
        if (!isInteractive || showSidePanel || showCutInPanel) return;

        const focusContainer = () => {
            const active = document.activeElement;
            if (
                active instanceof HTMLElement
                && (isTextEntryTarget(active) || Boolean(active.closest('[data-folia-keyboard-window="true"]')))
            ) return;
            containerRef.current?.focus({ preventScroll: true });
        };

        const rafId = requestAnimationFrame(focusContainer);
        return () => {
            cancelAnimationFrame(rafId);
        };
    }, [isInteractive, showCutInPanel, showSidePanel]);

    useEffect(() => {
        if (!isInteractive) return;

        const handleEscape = (event: KeyboardEvent) => {
            const target = event.target;
            if (
                target instanceof HTMLInputElement ||
                target instanceof HTMLTextAreaElement ||
                (target instanceof HTMLElement && target.isContentEditable)
            ) {
                return;
            }

            // Auto-repeat would walk the whole ladder and drop out of the map; a window above
            // (settings, dialogs, the palette overlay) owns its own Escape.
            if (event.key !== 'Escape' || event.repeat || hasBlockingWindow()) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            const action = resolveGridMapEscapeAction({
                searchQuery,
                showSidePanel,
                showCutInPanel,
                isPlaylistEditMode,
            });
            switch (action) {
                case 'clear-search':
                    setSearchQuery('');
                    break;
                case 'close-side-panel':
                    setShowSidePanel(false);
                    break;
                case 'close-cut-in-panel':
                    closeCutInPanel();
                    break;
                case 'exit-playlist-edit':
                    setVisibilityMode('browse');
                    break;
                case 'navigate-back':
                    onBack();
                    break;
            }
        };

        window.addEventListener('keydown', handleEscape);
        return () => window.removeEventListener('keydown', handleEscape);
    }, [closeCutInPanel, isInteractive, isPlaylistEditMode, onBack, searchQuery, setSearchQuery, setVisibilityMode, showCutInPanel, showSidePanel]);

    return (
        <motion.div
            data-ponder-page-scope={ponderPageScope}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[110] overflow-hidden select-none"
            style={{
                backgroundColor: isDaylight ? 'rgba(250, 249, 246, 0.95)' : 'rgba(9, 9, 11, 0.95)',
                color: 'var(--text-primary)',
                backdropFilter: 'blur(24px)'
            }}
        >
            {/* Top Floating Glass Header */}
            <div
                data-folia-gridmap-header="true"
                className="absolute top-0 left-0 right-0 flex items-center justify-between px-6 py-5 z-[70] bg-gradient-to-b from-black/10 to-transparent"
            >
                <Button
                    onClick={onBack}
                    tip={t('ui.back')}
                    className={`relative ${lowerBackButton ? 'top-7' : ''} w-10 h-10 rounded-full flex items-center justify-center transition-all pointer-events-auto shadow-lg hover:scale-105 active:scale-95`}
                    style={{
                        backgroundColor: isDaylight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.08)',
                        backdropFilter: 'blur(8px)',
                    }}
                >
                    <ChevronLeft size={20} />
                </Button>

                <Button
                    disabled={!hasCutInPanel}
                    onClick={() => {
                        if (showCutInPanel) {
                            closeCutInPanel();
                        } else {
                            openCutInPanel();
                        }
                    }}
                    className="group/grid-title text-center flex flex-col items-center select-none pointer-events-auto cursor-pointer hover:scale-[1.01] active:scale-98 transition-all px-5 py-2 rounded-2xl backdrop-blur-md disabled:cursor-default disabled:hover:scale-100"
                    style={{
                        backgroundColor: 'color-mix(in srgb, var(--bg-color) 20%, transparent)',
                        color: 'var(--text-primary)',
                    }}
                >
                    <h2 className="flex items-center justify-center gap-1.5 text-lg font-bold tracking-tight">
                        {title}
                        {hasCutInPanel && <GridPanelToggleIndicator isOpen={showCutInPanel} />}
                    </h2>
                    {subtitle && <p className="text-xs opacity-50 mt-0.5">{subtitle}</p>}
                </Button>

                <div className="w-10 h-10" />
            </div>

            {/* Honeycomb Drag/Viewport Canvas Area */}
            <div
                ref={containerRef}
                onPointerDown={(event) => {
                    if (event.button !== 0) return; // 仅限鼠标左键或主要指针拖动

                    const target = event.target as HTMLElement;
                    // 如果点击了按钮、输入框、链接等，则不触发拖动
                    if (
                        target.closest('button') ||
                        target.closest('input') ||
                        target.closest('a') ||
                        target.closest('textarea') ||
                        target.closest('.theme-glass-panel')
                    ) {
                        return;
                    }

                    suppressSelectionRef.current = false;
                    dragControls.start(event);
                }}
                tabIndex={-1}
                className="absolute inset-0 flex items-center justify-center cursor-grab active:cursor-grabbing overflow-hidden focus:outline-none"
                style={{ touchAction: 'none' }}
            >

                {displayItems.length === 0 ? (
                    <div className="opacity-40 text-sm font-sans">
                        {deferredSearchQuery.trim().length > 0 
                            ? (t('home.gridSearchNoResults') || 'No matching cards') 
                            : (t('home.loadingLibrary') || 'No items found')}
                    </div>
                ) : (
                    <motion.div
                        drag
                        dragListener={false}
                        dragControls={dragControls}
                        dragConstraints={dragBounds}
                        dragElastic={0.05}
                        dragTransition={{ power: 0.16, timeConstant: 220 }}
                        onDragStart={() => {
                            suppressSelectionRef.current = false;
                        }}
                        onDrag={(_, info) => {
                            if (shouldSuppressGridMapSelection(info.offset.x, info.offset.y)) {
                                suppressSelectionRef.current = true;
                            }
                        }}
                        onDragEnd={(_, info) => {
                            suppressSelectionRef.current = shouldSuppressGridMapSelection(
                                info.offset.x,
                                info.offset.y,
                            );
                        }}
                        style={{ x: dragX, y: dragY, background: 'rgba(0,0,0,0)', touchAction: 'none' }}
                        className="absolute inset-0 flex items-center justify-center cursor-grab active:cursor-grabbing bg-transparent"
                    >
                        {memoizedCards}
                    </motion.div>
                )}
            </div>

            <AnimatePresence>
                {showCutInPanel && hasCutInPanel && (
                    <motion.div
                        initial={{ opacity: 0, x: -60, scale: 0.95 }}
                        animate={{ opacity: 1, x: 0, scale: 1 }}
                        exit={{ opacity: 0, x: -60, scale: 0.95 }}
                        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                        data-folia-cut-in-panel="true"
                        className="absolute left-6 top-24 w-80 rounded-3xl z-[80] flex flex-col p-6 shadow-2xl border backdrop-blur-2xl pointer-events-auto theme-glass-panel"
                        style={{ bottom: bottomBarPanelBottomPx }}
                    >
                        {batchConfig ? (
                            <GridMapBatchPanel
                                title={title}
                                context={batchContext}
                                totalItemCount={displayItems.length}
                                searchQuery={deferredSearchQuery}
                                displayItems={displayItems}
                                selectedItemIds={selectedBatchItemIds}
                                config={batchConfig}
                                isDaylight={isDaylight}
                                onToggleSelectAll={(selected) => replaceBatchSelection(
                                    selected ? displayItems.map(item => String(item.id)) : [],
                                )}
                                onSetItemsSelected={setBatchItemsSelected}
                                isRemoveConfirmOpen={isRemoveConfirmOpen}
                                onRemoveConfirmOpenChange={setRemoveConfirmOpen}
                            />
                        ) : (
                            <>
                                <div
                                    data-folia-cut-in-cover="true"
                                    className="relative mb-4 aspect-square shrink-0 overflow-hidden rounded-2xl shadow-lg"
                                    style={{
                                        background: `linear-gradient(145deg, ${theme.primaryColor}, ${theme.accentColor})`,
                                    }}
                                >
                                    <div
                                        className="absolute inset-0 opacity-60"
                                        style={{
                                            background: `radial-gradient(circle at 20% 15%, ${theme.secondaryColor}, transparent 58%)`,
                                        }}
                                    />
                                    <div className="absolute inset-0 bg-black/15" />
                                </div>
                                <div className="min-w-0">
                                    <h3 className="line-clamp-2 text-xl font-bold leading-snug">{title}</h3>
                                    <p className="mt-1.5 text-[10px] opacity-40">{t('home.playlists')}</p>
                                </div>
                                <div
                                    data-folia-cut-in-actions="true"
                                    className="mt-auto space-y-2 border-t pt-4"
                                    style={{ borderTopColor: 'color-mix(in srgb, var(--text-primary) 12%, transparent)' }}
                                >
                            {isPlaylistEditMode && (
                                <Button
                                    onClick={toggleHiddenOnly}
                                    className={`w-full rounded-full py-2.5 text-xs font-semibold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                                        showHiddenPlaylistsOnly
                                            ? 'bg-black/10 dark:bg-white/10'
                                            : 'bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-900 hover:text-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900'
                                    }`}
                                >
                                    <ListFilter size={14} />
                                    {showHiddenPlaylistsOnly ? t('home.showAllPlaylists') : t('home.showHiddenPlaylistsOnly')}
                                </Button>
                            )}
                            <Button
                                onClick={togglePlaylistEditMode}
                                className={`w-full rounded-full py-2.5 text-xs font-semibold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                                    isPlaylistEditMode
                                        ? 'bg-red-500/20 text-red-500 border border-red-500/30'
                                        : 'bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-900 hover:text-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900'
                                }`}
                            >
                                {isPlaylistEditMode ? <EyeOff size={14} /> : <Eye size={14} />}
                                {isPlaylistEditMode ? t('home.finishHidingPlaylists') : t('home.hidePlaylists')}
                            </Button>
                                </div>
                            </>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Bottom Right Floating Button */}
            {items.length > 0 && (
                <GridListSearchButton
                    isDaylight={isDaylight}
                    accentColor={theme.accentColor}
                    listTitle={t('playlist.viewCollections') || 'View Collections'}
                    searchTitle={t('home.gridSearchPlaceholder')}
                    onOpenList={() => setShowSidePanel(true)}
                />
            )}

            {/* Collections Cut-in Side Panel */}
            <SidePanelList
                isOpen={showSidePanel}
                onClose={() => setShowSidePanel(false)}
                title={title || 'Collections'}
                items={displayItems}
                itemHeight={60}
                isDaylight={isDaylight}
                focusedIndex={focusedIndex}
                renderItem={(item, index, style) => (
                    <CollectionListItem
                        key={`${item.id}-${index}`}
                        item={item}
                        index={index}
                        style={style}
                        isActive={index === focusedIndex}
                        onClick={() => {
                            selectDisplayedItem(item, index);
                            setShowSidePanel(false);
                        }}
                    />
                )}
            />
        </motion.div>
    );
};

export default GridMap;
