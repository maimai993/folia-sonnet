import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import type { HomeViewTab } from '../../../types';
import type { ProviderCollection, ProviderUser } from '../../../types/onlineMusic';
import type { LibraryHomeOnlineSource, LibraryHomeTabView } from '../contracts/homeModel';
import type { LibraryOnlineProviderPlatform } from '../contracts/home';
import { isOnlineHomeTab, resolveHomeOnlineSource, resolveHomeTabs, translateHomeTabs } from '../model/homeSources';
import { readOnlineProviderCapabilities, readOnlineProviderLabel } from '../services/onlineHomeProvider';
import { useSearchNavigationStore } from '../../../stores/useSearchNavigationStore';
import { useHomeLayoutSettingsStore } from '../../../stores/useHomeLayoutSettingsStore';
import { usePersonalFmModeStore } from '../../../stores/usePersonalFmModeStore';
import { getLocalLibraryAvailability } from '../../../services/localLibraryAvailability';
import { getPersonalFmSelectionLabel } from '../../../services/onlineMusic/fmModes';

// src/library/core/bindings/useLibraryHomeSources.ts
// 首页的来源与一级页签：当前页签（搜索导航 store 持有）、当前在线来源（provider、账户、能力）、
// 页签列表与不可用原因（规则在 core/model/homeSources，这里翻译）、私人 FM 卡上显示的当前模式。
// 只订阅这几样（页签、页签显示开关、FM 模式），别的 store 写入不会让首页重渲染。

export type LibraryHomeSources = {
    tab: HomeViewTab;
    setTab: (tab: HomeViewTab) => void;
    isOnlineTab: boolean;
    online: LibraryHomeOnlineSource;
    tabs: LibraryHomeTabView[];
    /** FM 卡上的当前模式（provider 不支持模式时为空）。 */
    personalFmModeLabel: string;
};

export const useLibraryHomeSources = ({
    platform,
    user,
    playlists,
    cloudPlaylist = null,
    navidromeEnabled = false,
}: {
    platform?: LibraryOnlineProviderPlatform;
    /** 应用传入的旧账户与歌单（只有网易云在平台还没给出摘要时用）。 */
    user: ProviderUser | null;
    playlists: ProviderCollection[];
    cloudPlaylist?: ProviderCollection | null;
    navidromeEnabled?: boolean;
}): LibraryHomeSources => {
    const { t } = useTranslation();
    const { tab, setTab } = useSearchNavigationStore(useShallow(state => ({
        tab: state.homeViewTab,
        setTab: state.setHomeViewTab,
    })));
    const visibility = useHomeLayoutSettingsStore(useShallow(state => ({
        playlist: state.showHomeTabPlaylist,
        radio: state.showHomeTabRadio,
        albums: state.showHomeTabAlbums,
        local: state.showHomeTabLocal,
    })));
    // The FM card doubles as the mode readout: the card is the only place the current mode shows
    // up outside the player, and the picker can change it while this grid stays mounted.
    const personalFmSelection = usePersonalFmModeStore(state => state.selection);

    const providerId = platform?.activeProviderId || 'netease';
    const provider = platform?.activeProvider;
    const capabilities = readOnlineProviderCapabilities(providerId);
    const { userLibrary, playlists: canListPlaylists, userAlbums, recommendations, personalFmModes } = capabilities;
    const online = useMemo(() => resolveHomeOnlineSource({
        providerId,
        provider,
        capabilities: { ...capabilities, userLibrary, playlists: canListPlaylists, userAlbums, recommendations, personalFmModes },
        fallbackLabel: readOnlineProviderLabel(providerId),
        fallbackUser: user,
        fallbackPlaylists: playlists,
        fallbackCloud: cloudPlaylist,
        platformAvailable: Boolean(platform),
    }), [
        // capabilities 每次读都是新对象：按用到的几个开关比较。
        // eslint-disable-next-line react-hooks/exhaustive-deps
        canListPlaylists, cloudPlaylist, personalFmModes, platform, playlists, provider, providerId, recommendations, user, userAlbums, userLibrary,
    ]);

    const localAvailability = getLocalLibraryAvailability();
    const tabs = useMemo(() => translateHomeTabs(resolveHomeTabs({
        visibility,
        navidromeEnabled,
        online,
        localAvailability: { supported: localAvailability.supported, reason: localAvailability.reason },
    }), t), [localAvailability.reason, localAvailability.supported, navidromeEnabled, online, t, visibility]);

    const personalFmModeLabel = online.hasPersonalFmModes
        ? getPersonalFmSelectionLabel(personalFmSelection, (key, fallback) => t(key, fallback ?? ''))
        : '';

    return {
        tab,
        setTab,
        isOnlineTab: isOnlineHomeTab(tab),
        online,
        tabs,
        personalFmModeLabel,
    };
};
