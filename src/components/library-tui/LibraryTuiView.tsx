import React, { useEffect, useMemo, useRef } from 'react';
import { useIsPresent } from 'framer-motion';
import { List, useListRef } from 'react-window';
import { useTranslation } from 'react-i18next';
import type { LocalSong, Theme } from '../../types';
import type { LibraryCollectionDescriptor } from '../../types/libraryCollection';
import type { CollectionResource, LibraryPlaybackPort } from '../../types/libraryUi';
import { collectionKey } from '../../utils/libraryUi/collectionIdentity';
import { buildCoreSurfaceParams, buildGridSurfaceState, runGridSurfaceAction } from '../../utils/libraryUi/collectionSurface';
import { useCollectionResourceState } from '../../hooks/libraryUi/useCollectionResourceState';
import { useCollectionView } from '../../hooks/libraryUi/useCollectionView';
import { useCollectionActions } from '../../hooks/libraryUi/useCollectionActions';
import { useCommittedQuery } from '../../hooks/libraryUi/useCommittedQuery';
import { useLibrarySessionFilter } from '../../hooks/libraryUi/useLibrarySessionFilter';
import { useGridSurfaceRegistration } from '../../hooks/useGridSurfaceRegistration';
import { useLocalTrackSortStore } from '../../stores/useLocalTrackSortStore';
import { colorWithAlpha } from '../visualizer/colorMix';
import LibraryTuiHeader from './LibraryTuiHeader';
import LibraryTuiRow, { LIBRARY_TUI_ROW_HEIGHT, type LibraryTuiRowProps } from './LibraryTuiRow';
import { useLibraryTuiFocus } from './useLibraryTuiFocus';
import { useLibraryTuiKeyboard } from './useLibraryTuiKeyboard';

// src/components/library-tui/LibraryTuiView.tsx
// 集合详情的第二个 renderer：终端风格的等宽列表。它只做展示和按键映射——曲目、筛选、排序、
// 播放范围与动作全部来自与网格相同的 Library Core（资源、浏览会话、useCollectionView、
// useCollectionActions），并向命令面板注册同一个 surface，只是没有信息面板、侧栏与编辑模式。
// 这里不引用网格、六边形视口或转场的任何实现。

type LibraryTuiViewProps = {
    collection: LibraryCollectionDescriptor;
    resource: CollectionResource | null;
    port: LibraryPlaybackPort;
    localSongs?: LocalSong[];
    theme: Theme;
    isDaylight: boolean;
    isInteractive: boolean;
    onBack: () => void;
};

const LibraryTuiView: React.FC<LibraryTuiViewProps> = ({
    collection,
    resource,
    port,
    localSongs,
    theme,
    isDaylight,
    isInteractive,
    onBack,
}) => {
    const { t } = useTranslation();
    const isPresent = useIsPresent();
    const isActive = isInteractive && isPresent;
    const listRegionRef = useRef<HTMLDivElement>(null);
    const listRef = useListRef(null);
    const sessionKey = collectionKey(collection);

    const { snapshot } = useCollectionResourceState(resource);
    const tracks = useMemo(() => snapshot?.tracks ?? [], [snapshot?.tracks]);
    const { query, setQuery, isFiltering } = useLibrarySessionFilter({ sessionKey, isInteractive: isActive, anchorRef: listRegionRef });
    const committedQuery = useCommittedQuery(query);

    // 与网格同一条规则：只有本地文件夹（含「全部歌曲」）按本地排序。
    const supportsLocalTrackSorting = collection.source === 'local' && collection.type === 'folder';
    const sortField = useLocalTrackSortStore(state => state.field);
    const sortDirection = useLocalTrackSortStore(state => state.direction);
    const setSortField = useLocalTrackSortStore(state => state.setField);
    const setSortDirection = useLocalTrackSortStore(state => state.setDirection);
    const localSongsById = useMemo(() => new Map(localSongs?.map(song => [song.id, song])), [localSongs]);
    const localSort = useMemo(() => (
        supportsLocalTrackSorting ? { songsById: localSongsById, field: sortField, direction: sortDirection } : null
    ), [localSongsById, sortDirection, sortField, supportsLocalTrackSorting]);

    const view = useCollectionView({ tracks, committedQuery, localSort });
    const actions = useCollectionActions({ resource, snapshot, view, port, collectionType: collection.type });
    const focus = useLibraryTuiFocus(sessionKey, view);
    const trackAtRow = (row: number) => {
        const displayIndex = focus.rowDisplayIndexes[row];
        return displayIndex === undefined ? undefined : view.displayTracks[displayIndex];
    };

    // 命令面板能对这个集合做的事：只有核心动作（播放 / 入队范围、重新拉取、本地排序）。
    const surfaceParams = buildCoreSurfaceParams({
        supportsLocalTrackSorting,
        canReloadOnlineCollection: actions.capabilities.reload.enabled,
        filteredTrackCount: view.contextTracks.length,
        isFilterActive: view.isFilterActive,
        sortField,
        sortDirection,
        playFiltered: actions.playScope,
        enqueueFiltered: actions.enqueueScope,
        setSortField,
        setSortDirection,
        reloadOnlineCollection: actions.reload,
    });
    useGridSurfaceRegistration({
        isInteractive: isActive,
        getState: () => buildGridSurfaceState(surfaceParams),
        run: action => runGridSurfaceAction(action, surfaceParams),
    });

    const playRow = (row: number) => {
        const track = trackAtRow(row);
        if (!track) return;
        focus.focusRow(row);
        focus.persistFocus(row);
        actions.playTrack(track);
    };
    const enqueueRow = (row: number) => {
        const track = trackAtRow(row);
        if (track) actions.enqueueTrack(track);
    };

    useLibraryTuiKeyboard({
        isActive,
        isFiltering,
        rowCount: focus.rowDisplayIndexes.length,
        pageSize: Math.max(1, Math.floor((listRegionRef.current?.clientHeight ?? 560) / LIBRARY_TUI_ROW_HEIGHT) - 1),
        moveFocus: focus.moveFocus,
        onPlayFocused: () => playRow(focus.focusedRow),
        onEnqueueFocused: () => enqueueRow(focus.focusedRow),
        onPlayScope: actions.playScope,
        onEnqueueScope: actions.enqueueScope,
        // 与网格一致：先撤掉筛选，再离开。
        onEscape: () => (query ? setQuery('') : onBack()),
    });

    useEffect(() => {
        if (focus.focusedRow < 0) return;
        listRef.current?.scrollToRow({ index: focus.focusedRow, align: 'smart', behavior: 'instant' });
    }, [focus.focusedRow, listRef]);

    const accentColor = theme.accentColor || 'currentColor';
    const rowProps = useMemo<LibraryTuiRowProps>(() => ({
        tracks: view.displayTracks,
        rowDisplayIndexes: focus.rowDisplayIndexes,
        focusedRow: focus.focusedRow,
        accentBackground: colorWithAlpha(accentColor, isDaylight ? 0.16 : 0.22),
        accentColor,
        enqueueLabel: t('libraryTui.enqueue'),
        unavailableLabel: t('status.songUnavailableTag'),
        onFocusRow: focus.focusRow,
        onPlayRow: playRow,
        onEnqueueRow: enqueueRow,
    // playRow / enqueueRow 每次渲染都是新函数，但它们只读当前的 focus 与 view。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [accentColor, focus.focusRow, focus.focusedRow, focus.rowDisplayIndexes, isDaylight, t, view.displayTracks]);

    const isEmpty = focus.rowDisplayIndexes.length === 0;
    const isLoading = !snapshot || snapshot.status === 'idle' || snapshot.status === 'loading';
    const emptyText = snapshot?.error && !view.isFilterActive
        ? (snapshot.error.kind === 'not-public' ? t('playlist.loadNotPublic') : t('playlist.loadFailed', { error: snapshot.error.message }))
        : isLoading
            ? t('playlist.loading')
            : view.isFilterActive ? t('home.gridSearchNoResults') : t('home.loadingLibrary');

    return (
        <div
            data-library-renderer="tui"
            className="fixed inset-0 z-[110] flex flex-col overflow-hidden font-mono"
            style={{ backgroundColor: 'var(--bg-color)', color: 'var(--text-primary)' }}
        >
            <LibraryTuiHeader
                collection={collection}
                snapshot={snapshot}
                query={query}
                scopeCount={view.contextTracks.length}
                reload={actions.capabilities.reload}
                accentColor={accentColor}
                onBack={onBack}
                onReload={actions.reload}
                onResumeSync={actions.resumeSync}
            />
            <div className="grid shrink-0 grid-cols-[2ch_6ch_minmax(0,3fr)_minmax(0,2fr)_minmax(0,2fr)_6ch_4ch] gap-x-3 border-b border-current/10 px-4 py-1 text-[11px] uppercase tracking-wider opacity-45">
                <span />
                <span>{t('libraryTui.columnIndex')}</span>
                <span>{t('libraryTui.columnTitle')}</span>
                <span>{t('libraryTui.columnArtist')}</span>
                <span>{t('libraryTui.columnAlbum')}</span>
                <span>{t('libraryTui.columnTime')}</span>
                <span />
            </div>
            <div ref={listRegionRef} role="listbox" aria-label={collection.name} className="relative min-h-0 flex-1">
                {isEmpty ? (
                    <div className="px-4 py-6 text-[13px] opacity-50" data-tui-empty>{emptyText}</div>
                ) : (
                    <List
                        listRef={listRef}
                        rowCount={focus.rowDisplayIndexes.length}
                        rowHeight={LIBRARY_TUI_ROW_HEIGHT}
                        rowComponent={LibraryTuiRow}
                        rowProps={rowProps}
                        overscanCount={6}
                        className="custom-scrollbar"
                        style={{ height: '100%', width: '100%' }}
                    />
                )}
            </div>
            <footer className="shrink-0 border-t border-current/10 px-4 py-1.5 text-[11px] opacity-50">
                {t('libraryTui.hints')}
            </footer>
        </div>
    );
};

export default LibraryTuiView;
