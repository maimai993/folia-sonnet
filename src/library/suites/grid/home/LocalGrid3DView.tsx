import React, { useMemo, useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { FileUp, FolderOpen, Loader2, Music, ListMusic, User, Disc3, RefreshCw } from 'lucide-react';
import DesktopGrid3DSurface, { DesktopGrid3DAction } from './DesktopGrid3DSurface';
import { LocalLibraryGroup, LocalPlaylist, LocalSong, Theme } from '../../../../types';
import { GridViewCollectionDescriptor, createLocalGridViewCollection } from '../../../../components/app/home/gridViewCollectionAdapters';
import { buildLocalGrid3DGroups } from './localGrid3DModel';
import { useDebouncedFocusSync } from '../../../../hooks/useDebouncedFocusSync';
import { useLocalLibraryCatalog } from '../../../../hooks/useLocalLibraryCatalog';
import { loadLocalLibraryDirectoryTrees } from '../../../../services/localLibraryDirectoryTree';
import type { GridMapBatchConfig } from '../directory/GridMap';
import type { LibraryDirectoryBatchController, LibraryDirectoryNode, LibraryDirectorySelectionType } from '../../../core/contracts/directory';
import { directoryKey } from '../../../core/model/directorySession';

// src/library/suites/grid/home/LocalGrid3DView.tsx
// Desktop-only local music Grid3D overview that opens GridView instead of legacy carousel details.

type LocalRow = 0 | 1 | 2 | 3;

interface LocalGrid3DViewProps {
    localSongs: LocalSong[];
    localPlaylists: LocalPlaylist[];
    activeRow: LocalRow;
    setActiveRow: (row: LocalRow) => void;
    focusedFolderIndex: number;
    setFocusedFolderIndex: (index: number) => void;
    focusedAlbumIndex: number;
    setFocusedAlbumIndex: (index: number) => void;
    focusedArtistIndex: number;
    setFocusedArtistIndex: (index: number) => void;
    focusedPlaylistIndex: number;
    setFocusedPlaylistIndex: (index: number) => void;
    onImportFolder: () => void;
    onImportPlaylistFile?: (file: File) => Promise<void> | void;
    onRefreshFolders?: () => void;
    importButtonDisabled?: boolean;
    isImporting?: boolean;
    isRefreshing?: boolean;
    isScanInProgress?: boolean;
    isImportingPlaylist?: boolean;
    onOpenGridView?: (collection: GridViewCollectionDescriptor) => void;
    /** 批量动作控制器（宿主创建；规则在 core/services/localDirectoryActions）。没有时 GridMap 不提供批量。 */
    directoryActions?: LibraryDirectoryBatchController;
    theme: Theme;
    isDaylight: boolean;
    hasFloatingPlayer?: boolean;
    isInteractive?: boolean;
}

export const LocalGrid3DView: React.FC<LocalGrid3DViewProps> = ({
    localSongs,
    localPlaylists,
    activeRow,
    setActiveRow,
    focusedFolderIndex,
    setFocusedFolderIndex,
    focusedAlbumIndex,
    setFocusedAlbumIndex,
    focusedArtistIndex,
    setFocusedArtistIndex,
    focusedPlaylistIndex,
    setFocusedPlaylistIndex,
    onImportFolder,
    onImportPlaylistFile,
    onRefreshFolders,
    importButtonDisabled = false,
    isImporting = false,
    isRefreshing = false,
    isScanInProgress = false,
    isImportingPlaylist = false,
    onOpenGridView,
    directoryActions,
    theme,
    isDaylight,
    hasFloatingPlayer = false,
    isInteractive = true,
}) => {
    const { t } = useTranslation();
    const playlistFileInputRef = useRef<HTMLInputElement>(null);
    const [directoryTrees, setDirectoryTrees] = useState<LibraryDirectoryNode[]>([]);
    const [directoryTreesLoaded, setDirectoryTreesLoaded] = useState(false);
    const catalog = useLocalLibraryCatalog(localSongs);

    const refreshDirectoryTrees = React.useCallback(async () => {
        try {
            const trees = await loadLocalLibraryDirectoryTrees(localSongs);
            setDirectoryTrees(trees);
        } catch (error) {
            console.warn('[LocalGrid3DView] Failed to load directory snapshots:', error);
            setDirectoryTrees([]);
        } finally {
            setDirectoryTreesLoaded(true);
        }
    }, [localSongs]);

    useEffect(() => {
        void refreshDirectoryTrees();
    }, [refreshDirectoryTrees]);
    const groups = useMemo(() => buildLocalGrid3DGroups(
        localSongs,
        localPlaylists,
        t,
        catalog.ready ? catalog : undefined,
    ), [catalog.assignments, catalog.entities, catalog.ready, localPlaylists, localSongs, t]);

    const [localFolderIndex, setLocalFolderIndex] = useDebouncedFocusSync(focusedFolderIndex, setFocusedFolderIndex);
    const [localAlbumIndex, setLocalAlbumIndex] = useDebouncedFocusSync(focusedAlbumIndex, setFocusedAlbumIndex);
    const [localArtistIndex, setLocalArtistIndex] = useDebouncedFocusSync(focusedArtistIndex, setFocusedArtistIndex);
    const [localPlaylistIndex, setLocalPlaylistIndex] = useDebouncedFocusSync(focusedPlaylistIndex, setFocusedPlaylistIndex);

    const sections = useMemo(() => [
        {
            key: 'folders',
            row: 0 as LocalRow,
            label: t('localMusic.foldersAndPlaylists'),
            icon: <FolderOpen size={13} />,
            items: groups.folders,
            focusedIndex: localFolderIndex,
            setFocusedIndex: setLocalFolderIndex,
            emptyMessage: t('localMusic.noFoldersFound'),
        },
        {
            key: 'albums',
            row: 1 as LocalRow,
            label: t('localMusic.albums'),
            icon: <Disc3 size={13} />,
            items: groups.albums,
            focusedIndex: localAlbumIndex,
            setFocusedIndex: setLocalAlbumIndex,
            emptyMessage: t('localMusic.noAlbumsFound'),
        },
        {
            key: 'artists',
            row: 2 as LocalRow,
            label: t('localMusic.artists'),
            icon: <User size={13} />,
            items: groups.artists,
            focusedIndex: localArtistIndex,
            setFocusedIndex: setLocalArtistIndex,
            emptyMessage: t('localMusic.noArtistsFound'),
        },
        {
            key: 'playlists',
            row: 3 as LocalRow,
            label: t('localMusic.customPlaylists') || t('home.playlists'),
            icon: <ListMusic size={13} />,
            items: groups.playlists,
            focusedIndex: localPlaylistIndex,
            setFocusedIndex: setLocalPlaylistIndex,
            emptyMessage: t('localMusic.noPlaylistsFound'),
        },
    ], [
        localAlbumIndex,
        localArtistIndex,
        localFolderIndex,
        localPlaylistIndex,
        groups,
        setLocalAlbumIndex,
        setLocalArtistIndex,
        setLocalFolderIndex,
        setLocalPlaylistIndex,
        t,
    ]);

    const activeSection = sections.find(section => section.row === activeRow) ?? sections[0];

    // 批量配置只装配 section 与目录树；动作的规则（路径规则、刷新顺序、pending 与重复提交）在 core 的控制器里。
    // 删除与恢复忽略目录之后重读目录树：目录树是这个视图的状态，所以由它在动作的 pending 期间补上。
    const localBatchConfig = useMemo<GridMapBatchConfig | undefined>(() => {
        if (!directoryActions || !['folders', 'albums', 'artists'].includes(activeSection.key)) return undefined;
        const selectionType = activeSection.key as LibraryDirectorySelectionType;
        if (selectionType !== 'folders') return { selectionType, controller: directoryActions };

        return {
            selectionType,
            directoryTrees,
            controller: directoryActions,
            afterAction: async action => {
                if (action === 'remove') {
                    await refreshDirectoryTrees();
                } else if (action === 'clear-ignore') {
                    setDirectoryTrees(await loadLocalLibraryDirectoryTrees());
                }
            },
        };
    }, [activeSection.key, directoryActions, directoryTrees, refreshDirectoryTrees]);

    const tabs: DesktopGrid3DAction[] = sections.map(section => ({
        id: section.key,
        label: section.label,
        icon: section.icon,
        active: activeSection.row === section.row,
        onClick: () => setActiveRow(section.row),
    }));

    const actions: DesktopGrid3DAction[] = [
        {
            id: 'import-folder',
            label: isImporting ? t('localMusic.importing') : t('localMusic.importFolder'),
            icon: isImporting ? <Loader2 size={13} className="animate-spin" /> : <FolderOpen size={13} />,
            disabled: importButtonDisabled,
            onClick: onImportFolder,
            title: t('localMusic.importFolder'),
        },
        {
            id: 'refresh-folders',
            label: (isScanInProgress || isRefreshing) ? t('options.scanning') : t('options.refresh'),
            icon: (isScanInProgress || isRefreshing) ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />,
            disabled: importButtonDisabled,
            onClick: onRefreshFolders || (() => {}),
            title: t('options.refresh'),
        },
        {
            id: 'import-playlist',
            label: isImportingPlaylist ? t('localMusic.importingPlaylist') : t('localMusic.importPlaylist'),
            icon: isImportingPlaylist ? <Loader2 size={13} className="animate-spin" /> : <FileUp size={13} />,
            disabled: importButtonDisabled || isImportingPlaylist,
            onClick: () => playlistFileInputRef.current?.click(),
            title: t('localMusic.importPlaylist'),
        },
    ];

    if (directoryTreesLoaded && localSongs.length === 0 && directoryTrees.length === 0) {
        return (
            <div className="w-full h-full flex flex-col items-center justify-center gap-4 opacity-60">
                <Music size={64} />
                <p className="text-lg">{t('localMusic.noLocalMusic')}</p>
                <button
                    onClick={onImportFolder}
                    disabled={importButtonDisabled}
                    className="px-6 py-3 rounded-full transition-colors text-sm flex items-center gap-2 bg-white/10 hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {importButtonDisabled ? <Loader2 size={16} className="animate-spin" /> : <FolderOpen size={16} />}
                    {isScanInProgress ? t('options.scanning') : isImporting ? t('localMusic.importing') : t('localMusic.importFolder')}
                </button>
            </div>
        );
    }

    return (
        <>
            <input
                ref={playlistFileInputRef}
                type="file"
                accept=".m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl"
                className="hidden"
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) void onImportPlaylistFile?.(file);
                }}
            />
            <DesktopGrid3DSurface
                focusMemoryScope={JSON.stringify(['local', activeSection.key])}
                title={String(activeSection.label)}
                mapButtonLabel={t('home.allAlbums')}
                items={activeSection.items.map((item: any) => ({
                    id: item.id,
                    name: item.name,
                    coverUrl: item.coverUrl,
                    description: item.description,
                    trackCount: item.trackCount,
                    type: item.type,
                    isVirtual: item.isVirtual,
                    trackIds: item.songs.map((song: LocalSong) => song.id),
                }))}
                focusedIndex={activeSection.focusedIndex}
                onFocusedIndexChange={activeSection.setFocusedIndex}
                onSelect={(_, index) => {
                    const group = activeSection.items[index];
                    if (group) {
                        onOpenGridView?.(createLocalGridViewCollection(group));
                    }
                }}
                tabs={tabs}
                actions={actions}
                emptyMessage={activeSection.emptyMessage}
                theme={theme}
                isDaylight={isDaylight}
                isInteractive={isInteractive}
                hasFloatingPlayer={hasFloatingPlayer}
                playlistVisibilityScope="local"
                directoryKey={directoryKey({ source: 'local', section: activeSection.key })}
                batchConfig={localBatchConfig}
                ponderControls="local-grid-controls"
                gridMapPonderScope="local-grid-map-page"
            />
        </>
    );
};

export default LocalGrid3DView;
