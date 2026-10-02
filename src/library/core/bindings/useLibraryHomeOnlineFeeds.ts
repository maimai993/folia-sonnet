import { useEffect, useSyncExternalStore } from 'react';
import type { HomeViewTab } from '../../../types';
import type { MediaId } from '../../../types/onlineMusic';
import type {
    LibraryHomeFeedOwner,
    LibraryHomeFeedResource,
    LibraryHomeFeedSnapshot,
    LibraryHomeResources,
} from '../contracts/homeModel';

// src/library/core/bindings/useLibraryHomeOnlineFeeds.ts
// 在线首页数据的绑定：把当前 provider / 账户设成两份资源的归属，看着哪个页签就让哪份资源读一次，
// 并订阅它们的快照。归属与读取在同一个 effect 里按顺序做（先换归属、再 ensure），所以切 provider 之后
// 新 provider 的收藏专辑 / 电台一定会读——原先两个 effect 的先后让它永远不读。

export const useLibraryHomeFeed = <TData>(resource: LibraryHomeFeedResource<TData>): LibraryHomeFeedSnapshot<TData> => (
    useSyncExternalStore(resource.subscribe, resource.getSnapshot)
);

const ownerOf = (providerId: string, userId: MediaId | null | undefined, capable: boolean): LibraryHomeFeedOwner | null => (
    capable && userId !== null && userId !== undefined ? { providerId, userId } : null
);

export const useLibraryHomeOnlineFeeds = ({
    resources,
    tab,
    providerId,
    userId,
    canUseAlbums,
    canUseRadio,
}: {
    resources: Pick<LibraryHomeResources, 'favoriteAlbums' | 'radioFeed'>;
    tab: HomeViewTab;
    providerId: string;
    /** 当前 provider 的已登录账户（没有账户时为 null：两份数据都没有归属）。 */
    userId: MediaId | null | undefined;
    canUseAlbums: boolean;
    canUseRadio: boolean;
}) => {
    const { favoriteAlbums, radioFeed } = resources;
    // 首页 surface 卸载（切到播放页、换 suite）时放掉归属：数据清空、进行中的读取作废，回到首页时重新读。
    // 与原先「组件状态随 Grid3D 卸载而丢、回首页重新请求」一致（test/ui/homeCardPosition 的延迟专辑用例锁着它）。
    useEffect(() => () => {
        favoriteAlbums.setOwner(null);
        radioFeed.setOwner(null);
    }, [favoriteAlbums, radioFeed]);
    useEffect(() => {
        favoriteAlbums.setOwner(ownerOf(providerId, userId, canUseAlbums));
        radioFeed.setOwner(ownerOf(providerId, userId, canUseRadio));
        if (tab === 'albums') void favoriteAlbums.ensure();
        if (tab === 'radio') void radioFeed.ensure();
    }, [canUseAlbums, canUseRadio, favoriteAlbums, providerId, radioFeed, tab, userId]);

    return {
        favoriteAlbums: useLibraryHomeFeed(favoriteAlbums),
        radioFeed: useLibraryHomeFeed(radioFeed),
    };
};
