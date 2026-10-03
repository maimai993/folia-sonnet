import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { NavidromeConfig } from '../../../types/navidrome';
import type { LibraryHomeCard, LibraryHomeListAction } from '../contracts/homeModel';
import {
    buildNavidromeSectionCards,
    NAVIDROME_HOME_SECTIONS,
    navidromeSectionEmptyKey,
    navidromeSectionLabelKey,
    resolveNavidromeHomeActions,
    type NavidromeHomeSection,
} from '../model/navidromeHomeModel';
import { createNavidromeHomeLibrary } from '../services/navidromeHomeLibrary';
import { navidromeHomeLibraryDeps } from '../services/navidromeHomeLibraryDeps';
import { useNavidromeHomeSectionStore } from '../state/useNavidromeHomeSectionStore';
import { navidromeApi } from '../../../services/navidromeService';

// src/library/core/bindings/useLibraryHomeNavidrome.ts
// Navidrome 页签的模型：概览资源（core/services/navidromeHomeLibrary，挂载时读一次——与原先每次进页签都重新请求
// 一致）、当前 section（store 记忆）、各 section 的文案、当前 section 的卡片与刷新动作。

export type LibraryHomeNavidrome = {
    /** 没有配置时为 null（显示「去设置」）。 */
    config: NavidromeConfig | null;
    section: NavidromeHomeSection;
    setSection: (section: NavidromeHomeSection) => void;
    sections: { key: NavidromeHomeSection; label: string; active: boolean }[];
    title: string;
    items: LibraryHomeCard[];
    isLoading: boolean;
    emptyMessage: string;
    actions: LibraryHomeListAction[];
    refresh: () => Promise<void>;
};

export const useLibraryHomeNavidrome = (): LibraryHomeNavidrome => {
    const { t } = useTranslation();
    const [resource] = useState(() => createNavidromeHomeLibrary(navidromeHomeLibraryDeps));
    useEffect(() => {
        void resource.load();
    }, [resource]);
    const { config, isLoading, data } = useSyncExternalStore(resource.subscribe, resource.getSnapshot);
    const section = useNavidromeHomeSectionStore(state => state.section);
    const setSection = useNavidromeHomeSectionStore(state => state.setSection);

    // 五个 section 的卡片一起组装、只随数据变（与原先各自 memo 一样）：切 section 不重挑虚拟歌单的随机封面。
    const cardsBySection = useMemo(() => {
        const cards = { albums: [], 'recently-added': [], 'recently-played': [], playlists: [], artists: [] } as Record<NavidromeHomeSection, LibraryHomeCard[]>;
        if (!config) return cards;
        const coverArtUrl = (coverArtId: string, size?: number) => navidromeApi.getCoverArtUrl(config, coverArtId, size);
        for (const entry of NAVIDROME_HOME_SECTIONS) {
            cards[entry.key] = buildNavidromeSectionCards(entry.key, data, { t, coverArtUrl });
        }
        return cards;
    }, [config, data, t]);
    const items = cardsBySection[section];

    const sections = useMemo(() => NAVIDROME_HOME_SECTIONS.map(entry => ({
        key: entry.key,
        label: t(entry.labelKey),
        active: entry.key === section,
    })), [section, t]);

    const refresh = useCallback(() => resource.load(), [resource]);

    return {
        config,
        section,
        setSection,
        sections,
        title: t(navidromeSectionLabelKey(section)),
        items,
        isLoading,
        emptyMessage: t(navidromeSectionEmptyKey(section)),
        actions: resolveNavidromeHomeActions(isLoading),
        refresh,
    };
};
