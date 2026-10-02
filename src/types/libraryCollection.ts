import type { LocalLibraryGroup } from '../types';
import type {
    OnlineProviderId,
    ProviderArtistSummary,
    ProviderCollection,
    ProviderUser,
} from './onlineMusic';

// src/types/libraryCollection.ts
// 集合描述的契约：首页、搜索、播放器面板打开集合时交给导航栈和集合视图的那份数据。
// 原先定义在 components/app/home/gridViewCollectionAdapters.ts，store 为了拿类型不得不反向依赖组件目录；
// 放到 types 之后，组件、store、以后的 Library Core 都从这里取。

export type GridViewCollectionSource = 'online' | 'local' | 'navidrome';
export type NavidromeGridViewCollectionType = 'album' | 'playlist' | 'artist' | 'random' | 'favorites';

export interface BaseGridViewCollectionDescriptor {
    source: GridViewCollectionSource;
    id: string | number;
    name: string;
    type: string;
    coverUrl?: string;
    description?: string;
    trackCount?: number;
    albumCount?: number;
    isOwned?: boolean;
    artists?: ProviderArtistSummary[];
    aliases?: string[];
    publishedAt?: number;
    publisher?: string;
    playCount?: number;
    updatedAt?: number;
    tracksUpdatedAt?: number;
    isLiked?: boolean;
    providerData?: ProviderCollection['providerData'];
    creator?: ProviderUser;
    albumArtist?: string;
    albumYear?: number;
    albumGenre?: string;
    albumDuration?: number;
    albumCompany?: string;
    albumPublishTime?: number;
}

export interface LocalGridViewCollectionDescriptor extends BaseGridViewCollectionDescriptor {
    source: 'local';
    type: LocalLibraryGroup['type'];
    id: string;
    songIds: string[];
    entityId?: string;
    playlistId?: string;
    isVirtual?: boolean;
}

export interface NavidromeGridViewCollectionDescriptor extends BaseGridViewCollectionDescriptor {
    source: 'navidrome';
    type: NavidromeGridViewCollectionType;
    id: string;
    editable?: boolean;
}

export interface OnlineGridViewCollectionDescriptor extends BaseGridViewCollectionDescriptor {
    source: 'online';
    providerId: OnlineProviderId;
    raw?: any;
}

export type GridViewCollectionDescriptor =
    | OnlineGridViewCollectionDescriptor
    | LocalGridViewCollectionDescriptor
    | NavidromeGridViewCollectionDescriptor;

/** 与渲染形态无关的名字；新代码用它，旧的 GridView* 名字保留作兼容。 */
export type LibraryCollectionDescriptor = GridViewCollectionDescriptor;

/** 判定集合身份需要的最少字段：在线集合必须带 provider。 */
export type LibraryCollectionIdentity =
    | Pick<OnlineGridViewCollectionDescriptor, 'source' | 'providerId' | 'type' | 'id'>
    | Pick<LocalGridViewCollectionDescriptor | NavidromeGridViewCollectionDescriptor, 'source' | 'type' | 'id'>;
