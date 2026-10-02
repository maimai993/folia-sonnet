import { useEffect, useState } from 'react';
import type { LibraryHomeResources } from '../core/contracts/homeModel';
import { createFavoriteAlbumsFeed, createRadioFeed } from '../core/services/onlineHomeFeeds';
import { onlineHomeFeedDeps } from '../core/services/onlineHomeFeedDeps';

// src/library/app/useLibraryHomeResources.ts
// 首页外壳持有的首页资源（与 useLibraryDirectoryBatchController 同一个做法）：一个首页一份，生命周期跟着首页，
// 不随渲染重建——任何 suite 的首页都订阅同一份。数据的归属由正在显示的首页 surface 经绑定设置，surface 卸载时放掉
// （回到首页重新读，与原先一致；见 core/bindings/useLibraryHomeOnlineFeeds）。
//
// 「收藏专辑变了」的通知仍是窗口事件 `folia-refresh-favorite-albums`（变更端口在订阅 / 取消订阅专辑后派发，
// 应用里别处与探针也派发它）：在这里保留一个兼容的监听，收到就让收藏专辑资源重新读。监听放在宿主而不是某个
// suite 的首页里，换 suite 不会漏掉通知；资源本身不碰 window，单测不需要 DOM 事件。

export const FAVORITE_ALBUMS_CHANGED_EVENT = 'folia-refresh-favorite-albums';

export const useLibraryHomeResources = (): LibraryHomeResources => {
    const [resources] = useState<LibraryHomeResources>(() => ({
        favoriteAlbums: createFavoriteAlbumsFeed(onlineHomeFeedDeps),
        radioFeed: createRadioFeed(onlineHomeFeedDeps),
    }));

    useEffect(() => {
        const reloadFavoriteAlbums = () => {
            void resources.favoriteAlbums.reload();
        };
        window.addEventListener(FAVORITE_ALBUMS_CHANGED_EVENT, reloadFavoriteAlbums);
        return () => window.removeEventListener(FAVORITE_ALBUMS_CHANGED_EVENT, reloadFavoriteAlbums);
    }, [resources]);

    return resources;
};
