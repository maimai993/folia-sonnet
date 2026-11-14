import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocalLibraryGroup, LocalPlaylist, LocalSong } from '../../../types';
import type { LibraryDirectoryBatchConfig, LibraryDirectoryBatchController, LibraryDirectoryNode, LibraryDirectorySelectionType } from '../directory/directory.contract';
import type { LibraryLocalCatalogSnapshot } from './home.contract';
import type { LibraryHomeCard, LibraryLocalDirectoryTreesResource, LibraryLocalDirectoryTreesSnapshot } from './homeModel.contract';
import {
    buildLocalHomeCards,
    buildLocalHomeGroups,
    localBatchSelectionType,
    localHomeSectionOfRow,
    LOCAL_HOME_SECTIONS,
    type LocalHomeRow,
    type LocalHomeSectionKey,
} from './localHomeModel';
import { getLocalCoverAssetUrl } from '../../../services/localCoverAssetUrl';
import { applyLocalCollectionCoverOverrides } from '../collection/cover/localCollectionCover';
import { useLocalCollectionCoverUrls } from '../collection/cover/useLocalCollectionCoverUrls';
import { backfillLocalCovers } from '../../../services/localCoverBackfill';

// src/library/core/home/useLibraryHomeLocal.ts
// 本地页签的模型：四组条目（core/home/localHomeModel，曲库实体用宿主那份 catalog）、四个 section 的文案与卡片、
// 当前 section 与它的批量类型；以及本地文件夹树（首页宿主持有的 core/directory/localDirectoryTrees.service，跟着曲库重读）。
// 文件夹、专辑、歌单设了自定义封面的（core/collection/cover），分组与卡片带的是那张封面。

/** 一次补多少首歌的封面。开屏时不该对着一整屏卡片发几十个请求。 */
const COVER_BACKFILL_LIMIT = 12;
/** 一次最多给多少首歌去联网要封面 —— 本地抽封面是便宜的 IO，联网不是。 */
const ONLINE_COVER_FETCH_LIMIT = 8;

export type LibraryHomeLocalSection = {
    key: LocalHomeSectionKey;
    row: LocalHomeRow;
    label: string;
    emptyMessage: string;
    /** 这个 section 的分组（打开集合时用）。 */
    groups: LocalLibraryGroup[];
    cards: LibraryHomeCard[];
};

export type LibraryHomeLocal = {
    sections: LibraryHomeLocalSection[];
    activeSection: LibraryHomeLocalSection;
    batchSelectionType: LibraryDirectorySelectionType | null;
};

export const useLibraryHomeLocal = ({
    localSongs,
    localPlaylists,
    catalog,
    activeRow,
}: {
    localSongs: LocalSong[];
    localPlaylists: LocalPlaylist[];
    /** 宿主的曲库实体快照（与应用其它地方同一份；没读好时按歌曲的原始标签分组）。 */
    catalog: LibraryLocalCatalogSnapshot;
    activeRow: number;
}): LibraryHomeLocal => {
    const { t } = useTranslation();
    const { ready, entities, assignments } = catalog;
    const builtGroups = useMemo(() => buildLocalHomeGroups(
        localSongs,
        localPlaylists,
        t,
        ready ? { entities, assignments } : undefined,
        getLocalCoverAssetUrl,
    ), [assignments, entities, localPlaylists, localSongs, ready, t]);
    // 自定义封面盖在自动封面上：分组本身照旧按歌推出来，换封面不必重新分组。
    const coverOverrides = useLocalCollectionCoverUrls();
    const groups = useMemo(() => ({
        folders: applyLocalCollectionCoverOverrides(builtGroups.folders, coverOverrides),
        albums: applyLocalCollectionCoverOverrides(builtGroups.albums, coverOverrides),
        artists: builtGroups.artists,
        playlists: applyLocalCollectionCoverOverrides(builtGroups.playlists, coverOverrides),
    }), [builtGroups, coverOverrides]);

    const sections = useMemo<LibraryHomeLocalSection[]>(() => LOCAL_HOME_SECTIONS.map(section => {
        const sectionGroups = groups[section.key];
        return {
            key: section.key,
            row: section.row,
            label: t(section.labelKey) || (section.fallbackLabelKey ? t(section.fallbackLabelKey) : ''),
            emptyMessage: t(section.emptyKey),
            groups: sectionGroups,
            cards: buildLocalHomeCards(sectionGroups),
        };
    }), [groups, t]);

    const activeKey = localHomeSectionOfRow(activeRow).key;
    const activeSection = sections.find(section => section.key === activeKey) ?? sections[0];

    /*
     * 补封面：本地歌的内嵌封面原本只在导入和播放那一刻抽，从没打开过的歌单因此一直是空白
     * 卡片 —— 点开一次才有。这里从当前分组里挑几首还没有封面的排进队列，抽到之后界面自己
     * 会重建（见 services/localCoverBackfill）。只在首页本地页签做，别的地方不付这份 IO。
     *
     * 两件事原来都收得太紧，于是「占位色」补不完：
     *
     * 1. **每组只取前 2 首**。一个专辑 / 歌单里几十首歌，只有开头两首会被考虑，
     *    剩下的不管等多久都不会自动有封面。改成整组摊平，由 limit 决定碰多少首。
     * 2. **只抽内嵌、不联网**。文件里压根没有内嵌封面的歌，`ensureLocalSongCoverAsset`
     *    对它就到头了，而联网那条路只挂在导入 / 扫描上 —— 平时打开资料库根本不跑。
     *    这里开 `fallbackToOnline`，让本地抽不出来那部分继续走在线匹配。
     *
     * 候选是「看上去还没封面」的歌：已经有在线封面的不占名额，否则一次 12 个名额
     * 全被「有在线封面、只是文件里没内嵌图」的歌吃掉，真正空白的那些排不上。
     */
    useEffect(() => {
        const candidates = sections
            .flatMap(section => section.groups)
            .flatMap(group => group.songs)
            .filter(song => !song.localCoverAssetId && !song.onlineMetadata?.coverUrl);
        backfillLocalCovers(candidates, COVER_BACKFILL_LIMIT, {
            fallbackToOnline: true,
            onlineLimit: ONLINE_COVER_FETCH_LIMIT,
        });
    }, [sections]);

    return {
        sections,
        activeSection,
        batchSelectionType: localBatchSelectionType(activeSection.key),
    };
};

/**
 * 本地文件夹树：挂载时与曲库变化时按当前曲库 ensure（同一份曲库读过就不再读）；reload 按当前曲库、reloadAll
 * 让服务自己读曲库（恢复忽略目录之后用，与原先一致）。资源是首页宿主的那一份（homeResources.localDirectoryTrees），
 * 换 suite 不重新读；离开本地页签或首页时宿主让它作废，回来重读（原先是 LocalGrid3DView 的组件状态）。
 */
export const useLocalDirectoryTrees = (
    resource: LibraryLocalDirectoryTreesResource,
    localSongs: LocalSong[],
): LibraryLocalDirectoryTreesSnapshot & {
    reload: () => Promise<void>;
    reloadAll: () => Promise<void>;
} => {
    // reload 读最近一次渲染的曲库（不是动作发起那一刻闭包里的）：同时发起的读取里后发起的生效。
    const songsRef = useRef(localSongs);
    songsRef.current = localSongs;
    useEffect(() => {
        void resource.ensure(localSongs);
    }, [localSongs, resource]);
    const snapshot = useSyncExternalStore(resource.subscribe, resource.getSnapshot);
    return useMemo(() => ({
        ...snapshot,
        reload: () => resource.load(songsRef.current),
        reloadAll: () => resource.load(),
    }), [resource, snapshot]);
};

/**
 * 本地 section 的批量配置（网格的 GridMap 与 TUI 的目录列表共用）：只装配 section 类型、文件夹树与动作控制器；
 * 动作的规则（路径规则、刷新顺序、pending 与重复提交）在 core 的控制器里。删除与恢复忽略目录之后重读文件夹树
 * （树是首页资源，在动作的 pending 期间补上）。没有控制器或 section 不支持批量时为 undefined。
 */
export const useLocalHomeBatchConfig = ({
    controller,
    selectionType,
    trees,
    reloadTrees,
    reloadAllTrees,
}: {
    controller: LibraryDirectoryBatchController | undefined;
    selectionType: LibraryDirectorySelectionType | null;
    trees: LibraryDirectoryNode[];
    reloadTrees: () => Promise<void>;
    reloadAllTrees: () => Promise<void>;
}): LibraryDirectoryBatchConfig | undefined => useMemo(() => {
    if (!controller || !selectionType) return undefined;
    if (selectionType !== 'folders') return { selectionType, controller };
    return {
        selectionType,
        directoryTrees: trees,
        controller,
        afterAction: async action => {
            if (action === 'remove') {
                await reloadTrees();
            } else if (action === 'clear-ignore') {
                await reloadAllTrees();
            }
        },
    };
}, [controller, reloadAllTrees, reloadTrees, selectionType, trees]);
