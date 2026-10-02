import type { GridSurfaceActionId, GridSurfaceState } from '../../../src/types/gridCommandSurface';
import type { LibraryDeclaredActions, LibrarySuiteId, LibrarySurfaceId } from '../../../src/library/core/contracts/suite';
import type { OnlineFixtureId, ProbeFixtureId } from './fixtureRules';
import type { ProbeRefreshKind } from './probeGates';
import type { ProbeCall, ProbeRequest } from './probeLog';

// dev/probes/libraryBehavior/probeApi.ts
// 行为探针挂在 window 上的驱动接口。只有类型：component 用例 import 它不会把探针运行时带进 Node。

export type LibraryProbeApi = {
    /** 种子数据（沙盒模式下的 IndexedDB）是否已经就绪。 */
    ready: () => boolean;
    /** 沙盒模式才写 IndexedDB / Navidrome 配置；测试浏览器里自动开启。 */
    sandbox: boolean;
    fixtures: () => ProbeFixtureId[];
    /** 等价于在首页点开这个集合。 */
    open: (fixtureId: ProbeFixtureId) => void;
    /** 等价于浏览器后退：只弹栈，不清网格的恢复记录。 */
    back: () => void;
    /** 导航栈里每一层的名字，自底向上。 */
    stack: () => string[];
    /** 经由当前注册的命令筛选写 query；没有注册者时返回 false。 */
    setQuery: (query: string) => boolean;
    getQuery: () => string | null;
    surface: () => GridSurfaceState | null;
    /** 经由当前注册的 grid surface 执行动作；不在 availableActions 里时返回 false。 */
    runSurface: (action: GridSurfaceActionId) => boolean;
    /** 与开发版浮层同一条路径切换 suite（先把焦点写回会话）。 */
    setSuite: (suite: LibrarySuiteId) => void;
    suite: () => LibrarySuiteId;
    /** setSuite / suite 的旧名（R3 之前叫 renderer）。 */
    setRenderer: (renderer: LibrarySuiteId) => void;
    renderer: () => LibrarySuiteId;
    /** registry 里这个构建可用的 suite（与 DEV 浮层的按钮同源）。 */
    suites: () => LibrarySuiteId[];
    /** 当前选中的 suite 下，这个 surface 由谁渲染、声明了哪些动作（回退时是默认 suite 的声明）。 */
    resolveSurface: (surface: LibrarySurfaceId) => { suiteId: LibrarySuiteId; isFallback: boolean; declaredActions: LibraryDeclaredActions };
    /** 从当前集合压入一个歌手页（本地 fixture 的第一个歌手，需要沙盒）；返回是否压入。 */
    pushArtist: () => boolean;
    /** 按住这个在线集合的后台分页应答（页面按请求那一刻的上游数据生成），releasePages 时送达。 */
    holdPages: (fixtureId: OnlineFixtureId) => void;
    releasePages: (fixtureId: OnlineFixtureId) => void;
    /** 按住宿主的刷新（回调照样记账，只是迟迟不完成），releaseRefresh 时继续。 */
    holdRefresh: (kind: ProbeRefreshKind) => void;
    releaseRefresh: (kind: ProbeRefreshKind) => void;
    /** 按住在线 provider 的变更应答（请求已记账，上游在放行时才改），releaseMutations 时送达。 */
    holdMutations: () => void;
    releaseMutations: () => void;
    calls: () => ProbeCall[];
    requests: () => ProbeRequest[];
    clearLog: () => void;
};

declare global {
    interface Window {
        __libraryProbe?: LibraryProbeApi;
    }
}
