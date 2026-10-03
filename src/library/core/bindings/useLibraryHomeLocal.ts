import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocalLibraryGroup, LocalPlaylist, LocalSong } from '../../../types';
import type { LibraryDirectorySelectionType } from '../contracts/directory';
import type { LibraryLocalCatalogSnapshot } from '../contracts/home';
import type { LibraryHomeCard, LibraryLocalDirectoryTreesSnapshot } from '../contracts/homeModel';
import {
    buildLocalHomeCards,
    buildLocalHomeGroups,
    localBatchSelectionType,
    localHomeSectionOfRow,
    LOCAL_HOME_SECTIONS,
    type LocalHomeRow,
    type LocalHomeSectionKey,
} from '../model/localHomeModel';
import { createLocalDirectoryTrees } from '../services/localDirectoryTrees';
import { localDirectoryTreesDeps } from '../services/localDirectoryTreesDeps';
import { getLocalCoverAssetUrl } from '../../../services/localCoverAssetUrl';

// src/library/core/bindings/useLibraryHomeLocal.ts
// 本地页签的模型：四组条目（core/model/localHomeModel，曲库实体用宿主那份 catalog）、四个 section 的文案与卡片、
// 当前 section 与它的批量类型；以及本地文件夹树（core/services/localDirectoryTrees，跟着曲库重读）。

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
    const groups = useMemo(() => buildLocalHomeGroups(
        localSongs,
        localPlaylists,
        t,
        ready ? { entities, assignments } : undefined,
        getLocalCoverAssetUrl,
    ), [assignments, entities, localPlaylists, localSongs, ready, t]);

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
    return {
        sections,
        activeSection,
        batchSelectionType: localBatchSelectionType(activeSection.key),
    };
};

/**
 * 本地文件夹树：挂载时与曲库变化时按当前曲库重读；reload 按当前曲库、reloadAll 让服务自己读曲库
 * （恢复忽略目录之后用，与原先一致）。一个调用方一份（原先是 LocalGrid3DView 的组件状态）。
 */
export const useLocalDirectoryTrees = (localSongs: LocalSong[]): LibraryLocalDirectoryTreesSnapshot & {
    reload: () => Promise<void>;
    reloadAll: () => Promise<void>;
} => {
    const [resource] = useState(() => createLocalDirectoryTrees(localDirectoryTreesDeps));
    // reload 读最近一次渲染的曲库（不是动作发起那一刻闭包里的）：同时发起的读取里后发起的生效。
    const songsRef = useRef(localSongs);
    songsRef.current = localSongs;
    useEffect(() => {
        void resource.load(localSongs);
    }, [localSongs, resource]);
    const snapshot = useSyncExternalStore(resource.subscribe, resource.getSnapshot);
    return useMemo(() => ({
        ...snapshot,
        reload: () => resource.load(songsRef.current),
        reloadAll: () => resource.load(),
    }), [resource, snapshot]);
};
