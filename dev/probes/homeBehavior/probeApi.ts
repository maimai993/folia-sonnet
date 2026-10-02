import type { ProbeFault } from '../libraryBehavior/fakeProviders';
import type { ProbeRefreshKind } from '../libraryBehavior/probeGates';
import type { ProbeCall, ProbeRequest } from '../libraryBehavior/probeLog';
import type { LibraryDirectoryBatchActionId } from '../../../src/library/core/contracts/directory';

// dev/probes/homeBehavior/probeApi.ts
// 首页行为探针挂在 window 上的驱动接口。只有类型：component 用例 import 它不会把探针运行时带进 Node。
//
// 接口按语义命名（条目、打开、筛选、批选、隐藏、provider），与渲染形态无关；P3.4 给 TUI 首页实现同一套
// 签名，用例就能对两套 suite 参数化。当前的网格实现见 homeProbeApi.ts。

export type HomeTabKey = 'playlist' | 'radio' | 'albums' | 'local' | 'navidrome';

export type HomeProbeTab = {
    key: HomeTabKey;
    label: string;
    disabled: boolean;
    /** 不可用时的原因文案（按钮的 aria-label）。 */
    reason?: string;
};

/** 当前页签 / section 的一个条目（来源列表里的全部条目，隐藏的也在，标 hidden）。 */
export type HomeProbeItem = {
    id: string;
    name: string;
    type?: string;
    trackCount?: number;
    trackIds?: string[];
    description?: string;
    /** 这类条目能不能隐藏（歌单类）。 */
    hideable: boolean;
    /** 隐藏了：在来源列表里，但不在滑条里。 */
    hidden: boolean;
};

/** GridMap 当前显示的一张卡（已应用隐藏视图与筛选）。 */
export type HomeProbeMapItem = {
    id: string;
    name: string;
    type?: string;
    path?: string;
    description?: string;
    trackIds?: string[];
    hidden: boolean;
};

/** 宿主收到的集合描述摘要（onOpenCollection）。 */
export type HomeProbeDescriptor = {
    key: string;
    source: string;
    providerId?: string;
    type: string;
    id: string;
    name: string;
    songIds?: string[];
    isVirtual?: boolean;
    editable?: boolean;
    entityId?: string;
};

export type HomeBatchSelectionType = 'folders' | 'albums' | 'artists';

/** 当前批量范围：选中的条目（按卡片顺序）与去重保序后的歌曲 id。 */
export type HomeBatchScope = {
    selectionType: HomeBatchSelectionType;
    itemIds: string[];
    trackIds: string[];
    /** 批量面板此刻可选的条目数（= GridMap 显示的卡片数）。 */
    totalItemCount: number;
    /** 这个 section 提供的批量动作。 */
    actions: HomeBatchAction[];
};

/** 批量动作 id，与 core 的契约同一套（play、enqueue、create-playlist、remove、rescan-root、remove-root、clear-ignore）。 */
export type HomeBatchAction = LibraryDirectoryBatchActionId;

/** 目录树（本地文件夹的批量面板）里的一个节点。 */
export type HomeDirectoryNode = {
    path: string;
    rootPath: string;
    depth: number;
    ignored: boolean;
    directTrackCount: number;
    totalTrackCount: number;
};

/** 「管理隐藏」视图：browse 只看未隐藏的；manage 显示全部并标出隐藏的；manage-hidden-only 只看隐藏的。 */
export type HomeHiddenView = 'browse' | 'manage' | 'manage-hidden-only';

export type HomeProbeApi = {
    /** 种子、账户、Navidrome 垫片都就绪。 */
    ready: () => boolean;
    sandbox: boolean;

    // ---- 页签与条目 ----
    tabs: () => HomeProbeTab[];
    tab: () => HomeTabKey;
    setTab: (tab: HomeTabKey) => void;
    /** 本地 / Navidrome 页签下的二级 section（在线页签为空）。 */
    sections: () => { id: string; active: boolean }[];
    setSection: (id: string) => boolean;
    items: () => HomeProbeItem[];
    /** 滑条上实际显示的条目 id（隐藏的不在）。 */
    visibleItems: () => string[];
    /** 当前列表的隐藏作用域（`online:${providerId}` / local / navidrome）。 */
    scope: () => string | null;
    isLoading: () => boolean;
    /** 当前列表右上角的动作按钮（本地：导入文件夹、刷新、导入歌单文件；Navidrome：刷新）。 */
    actions: () => { id: string; disabled: boolean }[];
    runAction: (id: string) => boolean;
    /** 等价于在文件选择器里选了这个 m3u 文件。 */
    importPlaylistFile: (fileName: string, text: string) => Promise<boolean>;

    // ---- 打开 ----
    /** 等价于点开滑条上的这张卡（隐藏的卡不在滑条上，返回 false）。 */
    open: (id: string) => boolean;
    /** 宿主收到的集合描述（按时间顺序）。 */
    opened: () => HomeProbeDescriptor[];
    /** 导航栈里每一层的名字，自底向上。 */
    stack: () => string[];
    /** 关掉打开的集合，回到首页。 */
    closeCollection: () => void;

    // ---- GridMap 与筛选 ----
    openMap: () => boolean;
    closeMap: () => boolean;
    isMapOpen: () => boolean;
    mapItems: () => HomeProbeMapItem[];
    /** 经由当前注册的命令筛选写 query；没有注册者时返回 false。 */
    setQuery: (query: string) => boolean;
    getQuery: () => string | null;

    // ---- 批量 ----
    /** 当前列表有没有批量动作（只有本地 folders / albums / artists 有）。 */
    batchAvailable: () => boolean;
    /** 打开 / 关闭 GridMap 的侧面板（有批量配置时是批量面板，否则是隐藏管理面板）。 */
    openPanel: () => boolean;
    closePanel: () => boolean;
    isBatchOpen: () => boolean;
    batchScope: () => HomeBatchScope | null;
    batchSelect: (ids: string[], selected?: boolean) => boolean;
    batchSelectAll: (selected?: boolean) => boolean;
    /** 执行批量动作；create-playlist 的参数是歌单名，三个根目录动作的参数是路径。 */
    runBatch: (action: HomeBatchAction, arg?: string) => Promise<boolean>;
    directoryNodes: () => HomeDirectoryNode[];

    // ---- 隐藏 ----
    /** 切换一张卡的隐藏（需要 GridMap 打开，与卡片上的眼睛按钮同一个回调）。 */
    toggleHidden: (id: string) => boolean;
    hiddenView: () => HomeHiddenView;
    setHiddenView: (view: HomeHiddenView) => Promise<boolean>;
    /** localStorage 里存的隐藏表。 */
    storedHidden: () => Record<string, string[]>;

    // ---- 在线 provider ----
    providers: () => string[];
    activeProvider: () => string;
    switchProvider: (providerId: string) => Promise<boolean>;

    // ---- 环境 ----
    /** 重新挂载整个首页（宿主 + Grid3D），模拟重启后回到首页。 */
    remount: () => void;
    localSongIds: () => string[];
    localPlaylists: () => { id: string; name: string; songIds: string[] }[];
    setLatency: (target: string, latency: { first?: number; rest?: number }) => void;
    addFault: (fault: ProbeFault) => void;
    holdRefresh: (kind: ProbeRefreshKind) => void;
    releaseRefresh: (kind: ProbeRefreshKind) => void;
    calls: () => ProbeCall[];
    requests: () => ProbeRequest[];
    clearLog: () => void;
};

declare global {
    interface Window {
        __homeProbe?: HomeProbeApi;
    }
}
