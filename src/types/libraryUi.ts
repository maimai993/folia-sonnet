import type { SongResult, StatusMessage } from '../types';
import type { MediaId, ProviderCollection } from './onlineMusic';
import type { LibraryCollectionDescriptor, LocalGridViewCollectionDescriptor } from './libraryCollection';

// src/types/libraryUi.ts
// Library Core 的公共契约：集合资源（加载状态与已取得的曲目）、播放端口、浏览会话和 renderer 标识。
// 这里只有数据与语义标记，不出现 ReactNode、DOM 几何或动画值；任何 renderer 都按同一份契约消费。

export type CollectionResourceKind = 'online' | 'navidrome' | 'static';

/** idle：还没开始；loading：首屏或重新加载中（已有曲目会保留）；ready / error：本轮结束。 */
export type CollectionLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** 存判别式而不是成品文案：翻译在渲染时做，切换语言才能跟着变。 */
export type CollectionLoadError = { kind: 'not-public' } | { kind: 'generic'; message: string };

/** 后台补页：没有 / 进行中 / 在某个上游 offset 处中断（可续传）。 */
export type CollectionSyncState =
    | { status: 'none' }
    | { status: 'syncing' }
    | { status: 'interrupted'; message: string; offset: number };

/**
 * 这次更新该怎么渲染：urgent 立即提交；background 是可打断的整表更新（大歌单的分页），
 * renderer 应放进 transition，必要时（例如拖拽中）可以暂存到合适的时机再提交。
 */
export type CollectionUpdateHint = 'urgent' | 'background';

export interface CollectionResourceSnapshot {
    readonly key: string;
    readonly kind: CollectionResourceKind;
    /** 当前加载所对应的集合版本（见 collectionRevision）。 */
    readonly revision: string;
    readonly status: CollectionLoadStatus;
    /** 已取得的曲目；每次变化都是新数组，从不原地修改。 */
    readonly tracks: SongResult[];
    readonly error: CollectionLoadError | null;
    readonly sync: CollectionSyncState;
    /** 在线集合的详情（封面、简介、总数等），没有时为 null。 */
    readonly detail: ProviderCollection | null;
    readonly hint: CollectionUpdateHint;
    /** 每次从头加载都会递增；renderer 据此丢掉暂存的旧页。 */
    readonly generation: number;
}

export type CollectionResourceContext = {
    currentUserId?: MediaId | null;
};

export interface CollectionResource {
    readonly key: string;
    readonly kind: CollectionResourceKind;
    getSnapshot(): CollectionResourceSnapshot;
    /** 返回退订函数。 */
    subscribe(listener: () => void): () => void;
    /** 让资源对齐这份集合描述；同一版本重复调用不会重复请求。 */
    ensure(descriptor: LibraryCollectionDescriptor, context: CollectionResourceContext): void;
    /** 跳过缓存从头重新加载；正在加载时忽略。 */
    reload(): void;
    /** 从中断的 offset 续传后台补页。 */
    resumeSync(): void;
    /** 释放后再次打开同一集合时，能否直接沿用这份已加载的结果。 */
    canReuse(descriptor: LibraryCollectionDescriptor): boolean;
    /** 不再有人看：停止进行中的请求与补页，保留已取得的数据。 */
    pause(): void;
    dispose(): void;
    /**
     * P1 过渡期的编辑桥（P2 由正式的动作层取代）：
     * 立即记下删除（后续分页不会再带回来）并让缓存失效；`schedule` 决定何时把结果提交给界面，
     * 例如等卡片的退出动画结束。返回的 Promise 在缓存写完后完成。
     *
     * P2.1 起这是权威提交：变更动作层（services/libraryUi/collectionMutations）在上游确认后调用，
     * 不传 `schedule`，删除立即提交并以 urgent 通知。`schedule` 只剩 P2.2 之前的 GridView 在用，
     * 网格改由快照闸门保持展示之后删除这个参数。
     */
    removeTracks(match: (track: SongResult) => boolean, schedule?: (commit: () => void) => void): Promise<void>;
    /**
     * 只删第 index 个条目（重复条目里的这一个，例如 Navidrome 按原始下标删歌）；该位置已不是
     * expectedKey（playback key）时拒绝并返回 false。在线资源按歌去重、按墓碑过滤后续分页，
     * 单个重复条目记不了墓碑，所以同一首还有别的条目时也拒绝（在线删除按歌走 removeTracks）。
     */
    removeAt(index: number, expectedKey: string): boolean;
    /** 把第 index 首替换为 next；该位置已不是 expectedKey 时拒绝并返回 false。 */
    replaceTrackAt(index: number, expectedKey: string, next: SongResult): boolean;
    /** 用 load 的结果整体替换曲目（例如切换每日推荐的日期），不分页、不写缓存；失败时保持原样并返回 false。 */
    replaceAll(load: () => Promise<SongResult[]>): Promise<boolean>;
}

/**
 * pending：同类动作正在进行（共用的来源动作、串行的删除）；limit-reached：上游说没有更多了
 * （每日推荐的不喜欢次数用完）。
 */
export type LibraryCapabilityReason = 'empty' | 'loading' | 'unsupported' | 'pending' | 'limit-reached';

/** 同一个能力查询同时服务按钮与命令面板。 */
export type LibraryCapability = {
    supported: boolean;
    enabled: boolean;
    pending: boolean;
    reason?: LibraryCapabilityReason;
};

/** 把「播放 / 入队」交给应用现有的播放控制器；核心层不知道队列怎么构造。 */
export interface LibraryPlaybackPort {
    playTrack(track: SongResult, queue: SongResult[]): void;
    playAll(tracks: SongResult[]): void;
    enqueueTrack(track: SongResult): void;
    enqueueAll(tracks: SongResult[]): void;
}

/** 跨 renderer 保留的浏览会话；布局坐标不在这里，由各 renderer 自己存。 */
export type LibraryBrowseSession = {
    query: string;
    focusedEntryKey: string | null;
};

export type LibraryRendererId = 'grid' | 'tui';

// ---- 变更动作（P2）：删条目、订阅、改名、删除集合、重扫、导出……两套 UI 调同一个控制器。 ----

/**
 * 集合里的一个条目。同一首歌可以在歌单里出现多次，entryKey（`${playbackKey}-${occurrence}`，
 * 与网格卡片 id、TUI 行同一格式，见 utils/libraryUi/collectionEntries）区分是哪一次。
 */
export type LibraryEntryRef = { entryKey: string; track: SongResult };

/**
 * 动作没做成的原因：busy 同一动作还在进行（只发了一次请求）；stale 条目已经不在原处；
 * unsupported 这个集合没有这个动作；limit-reached 上游说没有更多了；failed 上游或本地出错。
 */
export type LibraryMutationFailureReason = 'busy' | 'stale' | 'unsupported' | 'limit-reached' | 'failed';

/** 存判别式，文案在 renderer 里翻译。 */
export type LibraryMutationResult =
    | { ok: true }
    | { ok: false; reason: LibraryMutationFailureReason; message?: string };

/** 「加入歌单」选择器里的一项。 */
export type LibraryPlaylistOption = { id: string | number; name: string; description?: string };

/** 本地曲库的来源动作；最后三个只打开宿主挂载的对话框。 */
export interface LibraryLocalMutationPort {
    removePlaylistSongs?: (playlistId: string, songIds: string[]) => Promise<void> | void;
    /** 重新读取本地曲库（歌单、歌曲）。 */
    refresh?: () => Promise<void> | void;
    renamePlaylist?: (playlistId: string, name: string) => Promise<void> | void;
    deletePlaylist?: (playlistId: string) => Promise<void> | void;
    deleteFolder?: (collection: LocalGridViewCollectionDescriptor) => Promise<void> | void;
    resyncFolder?: (collection: LocalGridViewCollectionDescriptor) => Promise<void> | void;
    resyncAllFolders?: () => Promise<void> | void;
    exportPlaylist?: (playlistId: string) => Promise<void> | void;
    editEntity?: (entityId: string) => Promise<void> | void;
    organizeFolder?: (collection: LocalGridViewCollectionDescriptor) => Promise<void> | void;
    matchSong?: (songId: string) => Promise<void> | void;
}

/** Navidrome 的来源动作。删歌按资源里的原始下标，不是界面上的显示下标。 */
export interface LibraryNavidromeMutationPort {
    availablePlaylists?: LibraryPlaylistOption[];
    removePlaylistSongs?: (playlistId: string, rawIndexes: number[]) => Promise<void> | void;
    renamePlaylist?: (playlistId: string, name: string) => Promise<void> | void;
    deletePlaylist?: (playlistId: string) => Promise<void> | void;
    addToPlaylist?: (playlistId: string | number, songs: SongResult[]) => Promise<void> | void;
    createPlaylist?: (name: string, songs: SongResult[]) => Promise<void> | void;
}

/**
 * 宿主提供的来源动作。在线集合的变更走 omni（由控制器注入），这里只有应用侧才做得到的事：
 * 本地曲库与 Navidrome 的读写、对话框、账户刷新和应用内通知。
 */
export interface LibraryMutationPort {
    local?: LibraryLocalMutationPort;
    navidrome?: LibraryNavidromeMutationPort;
    /** 集合在上游变了（删歌、订阅）：刷新账户里的歌单列表等。 */
    onCollectionMutated?: () => Promise<void> | void;
    /** renderer 把动作结果翻译成文案后经由这里显示；控制器自己只返回判别式。 */
    statusMessage?: (message: StatusMessage) => void;
    /** 收藏的专辑变了（订阅 / 取消订阅专辑）。 */
    notifyFavoriteAlbumsChanged?: () => void;
}

/**
 * 集合的来源分支，逐字对应 GridView 原先的布尔（见 utils/libraryUi/collectionMutationCapabilities）。
 * renderer 用它决定文案（例如专辑与歌单的订阅提示、文件夹删除要先确认）。
 */
export type CollectionMutationBranches = {
    isLocalCollection: boolean;
    isNavidromeCollection: boolean;
    isDailyRecommendationsCollection: boolean;
    isLocalFolderCollection: boolean;
    isLocalAllSongsCollection: boolean;
    isLocalPlaylistCollection: boolean;
    isLocalEntityCollection: boolean;
    isNavidromePlaylistCollection: boolean;
    isCloudDrive: boolean;
    isOnlinePlaylist: boolean;
    isOnlineAlbum: boolean;
    canEditOnlineCollectionTracks: boolean;
    canEditOwnedPlaylist: boolean;
    canEditProviderPlaylist: boolean;
    /** 有可编辑的内容（删条目或改名）：网格的「编辑」开关。 */
    canEditPlaylist: boolean;
    showSubscribeButton: boolean;
    canAddNavidromeToPlaylist: boolean;
};

export type CollectionMutationCapabilities = {
    /** 删除（或每日推荐的不喜欢）单个条目。 */
    removeEntry: LibraryCapability;
    subscribe: LibraryCapability;
    /** 进入 / 退出编辑（= canEditPlaylist）；编辑模式本身属于 renderer。 */
    editCollection: LibraryCapability;
    rename: LibraryCapability;
    deleteCollection: LibraryCapability;
    resyncFolder: LibraryCapability;
    resyncAllFolders: LibraryCapability;
    exportPlaylist: LibraryCapability;
    addToPlaylist: LibraryCapability;
    createPlaylist: LibraryCapability;
    editEntity: LibraryCapability;
    organizeSongInfo: LibraryCapability;
    /** 本地歌曲匹配在线信息；还要看条目本身是不是本地歌。 */
    matchSong: LibraryCapability;
    /** 每日推荐切换历史日期 / 刷新今天。加载中的禁用由 renderer 结合资源快照决定。 */
    dailyDate: LibraryCapability;
};

export type CollectionMutationSnapshot = {
    /** 订阅状态：null 表示还不知道，或这个集合不能订阅。 */
    readonly subscribed: boolean | null;
    readonly subscribing: boolean;
    /** 删除请求还没回来的条目。 */
    readonly pendingEntryKeys: readonly string[];
    readonly dailyLimitReached: boolean;
    /** 共用的来源动作（改名、删除、重扫、导出、加入歌单）进行中。 */
    readonly sourceActionPending: boolean;
    /** 每日推荐当前看的日期，'' 表示今天。 */
    readonly dailyDate: string;
    readonly dailyHistoryDates: readonly string[];
    /** Navidrome「加入歌单」的候选歌单。 */
    readonly availablePlaylists: readonly LibraryPlaylistOption[];
    readonly branches: CollectionMutationBranches;
    readonly capabilities: CollectionMutationCapabilities;
};

/** 控制器跟随宿主更新的输入：同一集合会话里描述、资源（本地集合会换新资源）、端口、用户都会变。 */
export type CollectionMutationInputs = {
    descriptor: LibraryCollectionDescriptor;
    resource: CollectionResource | null;
    port: LibraryMutationPort;
    currentUserId?: MediaId | null;
};

/**
 * 一个集合会话一个实例（宿主持有，renderer 订阅）。每个动作执行时重新检查能力；同一条目 / 同一动作
 * 进行中再次提交返回 busy，只发一次请求。dispose 之后控制器的状态不再变化、不再通知，
 * 已发出的上游请求照常完成。
 */
export interface CollectionMutationController {
    getSnapshot(): CollectionMutationSnapshot;
    /** 第一个订阅者到来时才去取订阅状态与每日推荐的历史日期。返回退订函数。 */
    subscribe(listener: () => void): () => void;
    /** 宿主同步最新输入；能力随之重算，有变化才通知。 */
    update(inputs: Partial<CollectionMutationInputs>): void;
    removeEntry(entry: LibraryEntryRef): Promise<LibraryMutationResult>;
    toggleSubscribe(): Promise<LibraryMutationResult>;
    /** 名字去掉首尾空白；空或与当前相同时什么都不做并返回 ok。 */
    rename(name: string): Promise<LibraryMutationResult>;
    /** 成功后由 renderer 返回上一层。 */
    deleteCollection(): Promise<LibraryMutationResult>;
    resyncFolder(): Promise<LibraryMutationResult>;
    resyncAllFolders(): Promise<LibraryMutationResult>;
    exportPlaylist(): Promise<LibraryMutationResult>;
    /** tracks 由 renderer 给（网格给的是可播放曲目）。 */
    addToPlaylist(playlistId: string | number, tracks: SongResult[]): Promise<LibraryMutationResult>;
    createPlaylist(name: string, tracks: SongResult[]): Promise<LibraryMutationResult>;
    editEntity(): Promise<LibraryMutationResult>;
    organizeSongInfo(): Promise<LibraryMutationResult>;
    matchSong(track: SongResult): Promise<LibraryMutationResult>;
    /** date 为 '' 表示今天；afresh 让上游重新生成今天的推荐。 */
    setDailyDate(date: string, options?: { afresh?: boolean }): Promise<LibraryMutationResult>;
    dispose(): void;
}
