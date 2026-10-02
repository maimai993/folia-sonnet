import type { LocalSong, SongResult, StatusMessage, Theme } from '../../../types';
import type { MediaId } from '../../../types/onlineMusic';
import type { LibraryCollectionDescriptor } from './collection';
import type { LibraryHomeData, LibraryOnlineProviderPlatform } from './home';
import type { CollectionMutationController } from './mutations';
import type { LibraryPlaybackPort } from './ports';
import type { CollectionResource } from './resource';

// src/library/core/contracts/suite.ts
// UI suite 的能力契约：core 定义有哪些 surface、每个 surface 上有哪些动作、宿主交给任何一套 suite 的输入；
// suite 在自己的 entry.ts 里声明「我实现了哪些 surface、哪些动作」。没实现的 surface 由默认 suite（grid）渲染，
// 没声明的动作不出现在那套 UI 和命令面板里（core 判定「这个集合此刻能不能做」，suite 声明「我的 UI 做不做」，
// 两者取交集）。发现与解析在 src/library/registry.ts，纯规则在 core/model/librarySuites。
// 这里只有类型；对 React 组件只用一个结构化的最小类型（契约不 import react）。

/** 目录 / GridMap 属于 home；以后有 search 再加。 */
export type LibrarySurfaceId = 'home' | 'collection' | 'artist';

/**
 * suite 的标识，由 registry 从 `suites/<id>/entry.ts` 发现（开发版才有 tui）。用字符串而不是写死的联合：
 * 合法的 id 只有 registry 知道，state 层不 import registry。
 */
export type LibrarySuiteId = string;

/**
 * 集合 surface 的语义动作（home / directory 的动作 P3 再补）。与其它清单的对应：
 *
 * | LibraryActionId | core 能力来源 | 命令面板（GridSurfaceActionId） |
 * | --- | --- | --- |
 * | play / enqueue | 条目本身可播放 | —（卡片 / 行上的动作） |
 * | play-scope / enqueue-scope | useCollectionActions 的 scope | play-filtered / enqueue-filtered |
 * | filter | 浏览会话（总是可用） | —（命令面板的筛选框） |
 * | sort | 本地文件夹才排序 | sort-file-name / sort-modified-date / sort-album-track / sort-toggle-direction |
 * | reload | useCollectionActions 的 reload | reload-online-collection |
 * | resume-sync | 资源的 sync 中断 | — |
 * | remove-entry | CollectionMutationCapabilities.removeEntry | — |
 * | subscribe | .subscribe | toggle-subscribe |
 * | rename | .rename | — |
 * | delete-collection | .deleteCollection | — |
 * | resync-folder | .resyncFolder | resync-folder |
 * | resync-all-folders | .resyncAllFolders | resync-all-folders |
 * | export-playlist | .exportPlaylist | export-playlist |
 * | edit-entity | .editEntity | edit-entity |
 * | organize-song-info | .organizeSongInfo | organize-song-info |
 * | match-song | .matchSong | — |
 * | add-to-playlist | .addToPlaylist | — |
 * | create-playlist | .createPlaylist | — |
 * | daily-date | .dailyDate | — |
 *
 * CollectionMutationCapabilities.editCollection 不是动作：编辑模式属于 renderer，网格把它声明成自己的
 * 局部动作 `toggle-edit-mode`（同名命令）。映射的代码版本在 core/model/librarySuites 与 collectionSurface。
 */
export type LibraryActionId =
    | 'play'
    | 'enqueue'
    | 'play-scope'
    | 'enqueue-scope'
    | 'filter'
    | 'sort'
    | 'reload'
    | 'resume-sync'
    | 'remove-entry'
    | 'subscribe'
    | 'rename'
    | 'delete-collection'
    | 'resync-folder'
    | 'resync-all-folders'
    | 'export-playlist'
    | 'edit-entity'
    | 'organize-song-info'
    | 'match-song'
    | 'add-to-playlist'
    | 'create-playlist'
    | 'daily-date';

/**
 * 某个 surface 上实际渲染它的那套 suite 声明的动作：core 动作与 suite 自己的局部动作
 * （网格的 toggle-info-panel、toggle-track-list、toggle-edit-mode……）。宿主按 registry 解析后传给 surface，
 * surface 向命令面板发布时只发布这里有的（再与 core 能力取交集）。
 */
export type LibraryDeclaredActions = {
    readonly actions: readonly LibraryActionId[];
    readonly extraActions: readonly string[];
};

/**
 * 最小的组件类型：能被当成 `(props) => 节点` 调用即可。React 的函数组件、memo / lazy 组件都满足它；
 * registry 把它还原成 React 组件类型再交给宿主渲染。
 */
export type LibrarySurfaceComponent<Props> = (props: Props) => unknown;

/** 集合层的导航动作：宿主实现（压栈、返回、解析目录引用）。 */
export type LibraryCollectionNavigation = {
    onBack: () => void;
    /** album 是界面上已有的专辑摘要（名字、封面、目录引用），track 是触发它的那首歌（在线集合按它解析目录）。 */
    onOpenAlbum: (albumId: number | string, album?: LibraryCatalogLinkHint, track?: SongResult) => void;
    onOpenArtist: (artistId: number | string, artist?: LibraryCatalogLinkHint, track?: SongResult) => void;
};

/** 打开专辑 / 歌手时界面上已有的摘要；在线集合的条目原样带着 provider 的字段。 */
export type LibraryCatalogLinkHint = {
    readonly name?: string;
    readonly coverUrl?: string;
    readonly catalogRef?: unknown;
    readonly [field: string]: unknown;
};

/** 每个 surface 都有的输入。 */
export type LibrarySurfaceBaseProps = {
    /** 只有用户正看着的那一层可交互（键盘、命令面板注册）。 */
    isInteractive: boolean;
    declaredActions: LibraryDeclaredActions;
};

/**
 * 集合 surface：宿主持有资源与变更控制器（切换 suite 不重新请求），suite 只订阅。
 * 网格专属的输入（移形换影的计划等）不在这里，网格从自己的转场 store 读。
 */
export type LibraryCollectionSurfaceProps = LibrarySurfaceBaseProps & LibraryCollectionNavigation & {
    collection: LibraryCollectionDescriptor;
    resource: CollectionResource | null;
    playback: LibraryPlaybackPort;
    /** 变更动作控制器；宿主创建、不订阅。suite 经它删歌、订阅、改名……（网格与 TUI 订阅同一个实例）。 */
    mutations: CollectionMutationController | null;
    localSongs: LocalSong[];
    theme: Theme;
    isDaylight: boolean;
    onStatusMessage?: (message: StatusMessage) => void;
    currentUserId?: MediaId | null;
};

/** 歌手页 surface：歌手页自己加载（不经资源），播放仍走播放端口。 */
export type LibraryArtistSurfaceProps = LibrarySurfaceBaseProps & LibraryCollectionNavigation & {
    collection: LibraryCollectionDescriptor;
    playback: LibraryPlaybackPort;
    localSongs: LocalSong[];
    theme: Theme;
    isDaylight: boolean;
    /** 本地歌手实体的编辑对话框（宿主挂载）。 */
    onEditEntity: (entityId: string) => void;
};

/** 首页 surface：首页模型的数据，加上打开集合的入口。 */
export type LibraryHomeSurfaceProps = LibrarySurfaceBaseProps & LibraryHomeData & {
    onlineProviderPlatform?: LibraryOnlineProviderPlatform;
    onOpenGridView: (collection: LibraryCollectionDescriptor) => void;
};

export type LibrarySurfacePropsMap = {
    home: LibraryHomeSurfaceProps;
    collection: LibraryCollectionSurfaceProps;
    artist: LibraryArtistSurfaceProps;
};

/** suite 对一个 surface 的实现与声明。 */
export type LibrarySurfaceDeclaration<Props> = {
    /** 默认 suite 可以是即时组件；其它 suite 必须是 React.lazy（registry 用 eager glob 发现 entry）。 */
    component: LibrarySurfaceComponent<Props>;
    actions: readonly LibraryActionId[];
    /** suite 自己的动作（不在 core 的清单里），例如网格的信息面板、曲目侧栏、编辑模式。 */
    extraActions?: readonly string[];
};

/** 宿主在导航时交给 suite 转场钩子的上下文（导航发生之前读的）。 */
export type LibraryNavigationContext = {
    /** 导航栈当前深度。 */
    depth: number;
    /** 根集合从哪里打开（'home' 时返回可以落回首页卡片）。 */
    origin: string | null;
    /** 当前顶层集合的类型。 */
    activeType: string | null;
};

/**
 * suite 自带的集合层转场（网格的移形换影）。宿主只在「渲染当前集合层的就是这套 suite」且未关闭动态效果时调用，
 * 其它情况下 Overlay 收到 enabled=false。
 */
export type LibrarySuiteTransitions = {
    /** 常驻在集合层之上的转场层；需要从挂载起就在（例如捕获首页卡片的点击）。 */
    Overlay?: LibrarySurfaceComponent<{ enabled: boolean }>;
    /** 压入下一层之前。 */
    beforePush?: (context: LibraryNavigationContext) => void;
    /** 返回上一层之前。 */
    beforeBack?: (context: LibraryNavigationContext) => void;
    /** 切换 suite 时：丢掉还没用掉的转场计划（它是给切换前那次入场准备的）。每套 suite 都会收到。 */
    reset?: () => void;
};

export type LibrarySuiteManifest = {
    id: LibrarySuiteId;
    /** 切换浮层上的名字（i18n key）。 */
    labelKey: string;
    /** false 时 registry 当它不存在（例如开发版专用的 suite 在生产构建里）。缺省为可用。 */
    available?: boolean;
    surfaces: { readonly [Surface in LibrarySurfaceId]?: LibrarySurfaceDeclaration<LibrarySurfacePropsMap[Surface]> };
    transitions?: LibrarySuiteTransitions;
};
