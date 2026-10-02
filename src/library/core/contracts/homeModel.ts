import type { MediaId, ProviderCollection } from '../../../types/onlineMusic';

// src/library/core/contracts/homeModel.ts
// 首页模型的契约（P3.3 从网格的 Grid3D 里提出来）：在线首页数据（收藏专辑、电台 feed）的资源、
// 首页卡片的视图模型。任何一套 suite 的首页都按这些类型拿数据，不依赖网格。只有类型。

/** 在线首页数据的归属：哪个 provider 的哪个账户。换了归属，旧数据与还在路上的应答都作废。 */
export type LibraryHomeFeedOwner = {
    providerId: string;
    userId: MediaId;
};

export type LibraryHomeFeedStatus = 'idle' | 'loading' | 'ready' | 'error';

export type LibraryHomeFeedSnapshot<TData> = {
    owner: LibraryHomeFeedOwner | null;
    status: LibraryHomeFeedStatus;
    /** 这个归属下至少成功读到过一次（ensure 据此决定要不要读）。 */
    loaded: boolean;
    data: TData;
};

/**
 * 一份在线首页数据（收藏专辑、电台 feed）。实现在 core/services/onlineHomeFeeds：每次读取领一个 generation，
 * 换归属或重新读取都会让旧的读取作废——晚到的应答直接丢掉，不会落进新 provider / 新账户的列表。
 */
export interface LibraryHomeFeedResource<TData> {
    getSnapshot(): LibraryHomeFeedSnapshot<TData>;
    subscribe(listener: () => void): () => void;
    /** 换归属（null：没有账户或 provider 不支持）：清空数据、作废进行中的读取。同一归属重复设置不起作用。 */
    setOwner(owner: LibraryHomeFeedOwner | null): void;
    /** 这个归属下还没读到过就读一次；正在读或已读到时什么都不做。 */
    ensure(): Promise<void>;
    /** 不管读没读过都重新读（旧数据保留到新数据到达）；没有归属时什么都不做。 */
    reload(): Promise<void>;
}

/** 电台页签的数据（omni.getHomeFeed 的结果；封面在读取时就按 provider 解析好）。 */
export type LibraryHomeRadioFeed = {
    personalFmCoverUrl?: string;
    dailyCoverUrl: string;
    dailyCount: number;
    recommended: ProviderCollection[];
};

/** 宿主（library/app）为首页创建、交给任何 suite 的资源与控制器。一个首页一份，切 suite 不重建。 */
export type LibraryHomeResources = {
    favoriteAlbums: LibraryHomeFeedResource<ProviderCollection[]>;
    radioFeed: LibraryHomeFeedResource<LibraryHomeRadioFeed | null>;
};

/**
 * 首页的一张卡（网格滑条与 GridMap、TUI 的一行共用的视图模型）。目录条目的业务字段之外，
 * `raw` 是卡片背后的来源对象（打开集合时用），Navidrome 专辑另带几项展示字段。
 */
export type LibraryHomeCard = {
    id: string | number;
    name: string;
    type?: string;
    coverUrl?: string;
    description?: string;
    summary?: string;
    trackCount?: number;
    trackIds?: string[];
    isVirtual?: boolean;
    raw?: unknown;
};
