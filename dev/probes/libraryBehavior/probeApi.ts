import type { GridSurfaceActionId, GridSurfaceState } from '../../../src/types/gridCommandSurface';
import type { LibraryRendererId } from '../../../src/types/libraryUi';
import type { ProbeFixtureId } from './fixtureRules';
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
    /** 与开发版浮层同一条路径切换 renderer（先把焦点写回会话）。 */
    setRenderer: (renderer: LibraryRendererId) => void;
    renderer: () => LibraryRendererId;
    calls: () => ProbeCall[];
    requests: () => ProbeRequest[];
    clearLog: () => void;
};

declare global {
    interface Window {
        __libraryProbe?: LibraryProbeApi;
    }
}
