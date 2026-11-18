import { useEffect, useSyncExternalStore } from 'react';
import type { HomeViewTab } from '../../../../types';
import type { MediaId } from '../../../../types/onlineMusic';
import type {
    LibraryHomeFeedOwner,
    LibraryHomeFeedResource,
    LibraryHomeFeedSnapshot,
    LibraryHomeResources,
} from '../homeModel.contract';

// src/library/core/home/online/useLibraryHomeOnlineFeeds.ts
// 在线首页数据的绑定：把当前 provider / 账户（「全部」时是各家已登录的 provider / 账户）设成两份资源的归属，
// 看着哪个页签就让哪份资源读一次，并订阅它们的快照。归属与读取在同一个 effect 里按顺序做（先换归属、再 ensure），
// 所以切 provider 之后新 provider 的收藏专辑 / 电台一定会读——原先两个 effect 的先后让它永远不读。
// 这里不在卸载时放掉归属：资源属于首页宿主，换 suite（旧 surface 卸载、新 surface 挂载）时新 surface 设的是
// 同一个归属、ensure 也不再读；首页真的离开时由宿主放掉（core/home/libraryHomeLifetime.service）。

export const useLibraryHomeFeed = <TData>(resource: LibraryHomeFeedResource<TData>): LibraryHomeFeedSnapshot<TData> => (
    useSyncExternalStore(resource.subscribe, resource.getSnapshot)
);

/** 一家「平台 + 账户」能不能做这份数据的归属：这家得支持这件事，而且真的有个账户。 */
const ownerOf = (providerId: string, userId: MediaId | null | undefined, capable: boolean): LibraryHomeFeedOwner | null => (
    capable && userId !== null && userId !== undefined ? { providerId, userId } : null
);

const ownersOf = (
    feedOwners: readonly LibraryHomeFeedOwner[] | undefined,
    providerId: string,
    userId: MediaId | null | undefined,
    capable: boolean,
): LibraryHomeFeedOwner[] => {
    // 「全部」视图：归属已经由来源那一层算好（各家已登录、且真的支持这一项的），直接用。
    if (feedOwners && feedOwners.length > 0) return [...feedOwners];
    const single = ownerOf(providerId, userId, capable);
    return single ? [single] : [];
};

type OnlineHomeFeedsAttachment = {
    tab: HomeViewTab;
    providerId: string;
    userId: MediaId | null | undefined;
    canUseAlbums: boolean;
    canUseRadio: boolean;
    /** 「全部」视图里收藏专辑 / 电台的归属（各家已登录平台）；没有时按当前 provider 单个归属。 */
    feedOwners?: {
        albums?: readonly LibraryHomeFeedOwner[];
        radio?: readonly LibraryHomeFeedOwner[];
    };
};

/**
 * 正在显示的首页 surface 认领两份在线数据：先把归属设成当前 provider / 账户（或「全部」时的各家），
 * 再让当前页签的那份读一次。同一个归属、已经读过时什么都不做——换 suite 后新 surface 认领同一份数据不会再请求。
 */
export const attachOnlineHomeFeeds = (
    resources: Pick<LibraryHomeResources, 'favoriteAlbums' | 'radioFeed'>,
    { tab, providerId, userId, canUseAlbums, canUseRadio, feedOwners }: OnlineHomeFeedsAttachment,
): void => {
    resources.favoriteAlbums.setOwners(ownersOf(feedOwners?.albums, providerId, userId, canUseAlbums));
    resources.radioFeed.setOwners(ownersOf(feedOwners?.radio, providerId, userId, canUseRadio));
    if (tab === 'albums') void resources.favoriteAlbums.ensure();
    if (tab === 'radio') void resources.radioFeed.ensure();
};

export const useLibraryHomeOnlineFeeds = ({
    resources,
    tab,
    providerId,
    userId,
    canUseAlbums,
    canUseRadio,
    feedOwners,
}: {
    resources: Pick<LibraryHomeResources, 'favoriteAlbums' | 'radioFeed'>;
    tab: HomeViewTab;
    providerId: string;
    /** 当前 provider 的已登录账户（没有账户时为 null：两份数据都没有归属）。 */
    userId: MediaId | null | undefined;
    canUseAlbums: boolean;
    canUseRadio: boolean;
    /** 「全部」视图里两份数据的归属；不给就按当前 provider 单个归属。 */
    feedOwners?: {
        albums?: readonly LibraryHomeFeedOwner[];
        radio?: readonly LibraryHomeFeedOwner[];
    };
}) => {
    const { favoriteAlbums, radioFeed } = resources;
    // 归属按内容比较（资源内部自己判「同一组归属就不重置」），所以这里可以每次渲染都设；
    // effect 依赖里放的是能决定归属的那几项，别的 store 写入不会重复跑。
    const albumOwners = feedOwners?.albums;
    const radioOwners = feedOwners?.radio;
    useEffect(() => {
        attachOnlineHomeFeeds({ favoriteAlbums, radioFeed }, {
            tab, providerId, userId, canUseAlbums, canUseRadio, feedOwners,
        });
    }, [
        albumOwners, canUseAlbums, canUseRadio, favoriteAlbums, providerId, radioFeed, radioOwners, tab, userId,
        feedOwners,
    ]);

    return {
        favoriteAlbums: useLibraryHomeFeed(favoriteAlbums),
        radioFeed: useLibraryHomeFeed(radioFeed),
    };
};
