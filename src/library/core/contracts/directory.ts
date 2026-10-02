// src/library/core/contracts/directory.ts
// 首页目录的契约：目录条目（任意 suite 展示的一张卡 / 一行的业务部分）、本地文件夹树节点、批量范围与批量动作。
// 只有类型。条目里不放 ReactNode 之类的 UI 字段；网格需要随卡带回的原对象（rawCollection）由网格自己的
// GridMapItem 扩展，不进契约。

/**
 * 目录里的一个条目（歌单、专辑、歌手、文件夹、电台……）。
 * `id` 在同一个目录（同一来源的同一 section）里唯一；隐藏、批选、焦点都按它认人。
 */
export interface LibraryDirectoryItem {
    id: string | number;
    name: string;
    /** 条目类型：playlist、album、artist、folder、cloud、radio、daily_recommendations、personal_fm…… */
    type?: string;
    /** 本地真实文件夹的相对路径（目录树与批量范围按它匹配）；虚拟条目没有。 */
    path?: string;
    description?: string;
    summary?: string;
    trackCount?: number;
    /** 这个条目包含的歌曲 id（目前只有本地条目有），批量范围按它去重保序。 */
    trackIds?: string[];
    coverUrl?: string;
    /** 不对应真实来源对象的条目：本地「全部歌曲」「我喜欢」、未知专辑 / 歌手、Navidrome 随机 / 收藏歌单。 */
    isVirtual?: boolean;
    /** 显式声明能否隐藏；不给时按类型推断（见 core/model/directoryVisibility 的 isHideableDirectoryItem）。 */
    hideable?: boolean;
}

/** 本地文件夹树的一个节点（只含目录，不含曲目）。service 构建它，批量面板 / 目录树展示它。 */
export interface LibraryDirectoryNode {
    id: string;
    name: string;
    path: string;
    rootPath: string;
    depth: number;
    ignored?: boolean;
    directTrackCount: number;
    totalTrackCount: number;
    children: LibraryDirectoryNode[];
}

/** 支持批量的 section。 */
export type LibraryDirectorySelectionType = 'folders' | 'albums' | 'artists';

/**
 * 批量动作 id。隐藏不是批量动作（见 directoryVisibility 的产品语义）。
 * play / enqueue / create-playlist 每个批量 section 都有；其余只有本地文件夹有。
 */
export type LibraryDirectoryBatchActionId =
    | 'play'
    | 'enqueue'
    | 'create-playlist'
    | 'remove'
    | 'rescan-root'
    | 'remove-root'
    | 'clear-ignore';

/** 批量范围：选中的条目（按目录顺序）与它们去重保序后的歌曲 id。 */
export interface LibraryDirectoryBatchContext<TItem extends LibraryDirectoryItem = LibraryDirectoryItem> {
    items: TItem[];
    trackIds: string[];
}

/**
 * 一个目录 section 的批量能力与实现（宿主 / 首页视图装配）。可选回调缺省即该动作不可用；
 * 能用哪些动作由 core/model/directoryBatch 的 resolveDirectoryBatchActions 读出。
 */
export interface LibraryDirectoryBatchConfig {
    selectionType: LibraryDirectorySelectionType;
    directoryTrees?: LibraryDirectoryNode[];
    onPlay: (context: LibraryDirectoryBatchContext) => Promise<void> | void;
    onAddToQueue: (context: LibraryDirectoryBatchContext) => Promise<void> | void;
    onCreatePlaylist: (name: string, context: LibraryDirectoryBatchContext) => Promise<void> | void;
    onRemove?: (context: LibraryDirectoryBatchContext) => Promise<void> | void;
    onRescanRoot?: (rootPath: string) => Promise<void> | void;
    onRemoveRoot?: (rootPath: string) => Promise<void> | void;
    onClearFolderIgnore?: (folderPath: string) => Promise<void> | void;
}

/** 目录树上一个节点相对当前（已筛选）条目的选中状态。 */
export interface LibraryDirectoryNodeSelection {
    /** 这个节点及其子孙对应的条目。 */
    itemIds: string[];
    /** 正好是这个节点本身的条目。 */
    directItemIds: string[];
    selectedCount: number;
    state: 'none' | 'partial' | 'direct' | 'all';
}

/** 点一次节点复选框后要变成的选择：全部取消、只选本层、选整棵子树。 */
export type LibraryDirectoryNodeSelectionTarget = 'none' | 'direct' | 'all';

/**
 * 隐藏项的作用域：在线按 provider 分（`online:${providerId}`），本地曲库一个、Navidrome 一个；
 * `default` 是没声明作用域的目录的兜底。同一个 id 在不同作用域互不影响。
 */
export type LibraryHiddenScope = `online:${string}` | 'local' | 'navidrome' | 'default';

/**
 * 隐藏表：作用域 → 隐藏的条目 id（按隐藏的先后）。就是 localStorage `hidden_grid_playlists` 里存的格式；
 * 取消隐藏后作用域留一个空数组。
 */
export type LibraryHiddenCollections = Record<string, string[]>;

/**
 * 目录的隐藏视图：browse 只显示未隐藏的（浏览、筛选、批量都在这之上）；manage 显示全部并标出隐藏的；
 * manage-hidden-only 只显示隐藏的。后两个是「管理隐藏」（网格里是 GridMap 的隐藏编辑模式）。
 */
export type LibraryDirectoryVisibilityMode = 'browse' | 'manage' | 'manage-hidden-only';
