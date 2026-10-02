import { useAppViewStore } from '../../../src/stores/useAppViewStore';
import { useGridSurfaceStore } from '../../../src/stores/useGridSurfaceStore';
import { useCollectionNavigationStore } from '../../../src/stores/useCollectionNavigationStore';
import type { LibraryProbeApi } from './probeApi';
import { clearProbeCalls, clearProbeRequests, getProbeLog } from './probeLog';

// dev/probes/libraryBehavior/libraryProbeApi.ts
// 把探针的驱动接口挂到 window 上。查询、动作都经由真实的注册点（命令筛选、grid surface），
// 用的是命令面板同一条通道，所以它测到的就是命令面板能做到的事。

type HarnessBindings = Pick<LibraryProbeApi, 'sandbox' | 'fixtures' | 'ready' | 'open' | 'back'>;

/** 安装 `window.__libraryProbe`，返回卸载函数。 */
export const installLibraryProbeApi = (bindings: HarnessBindings): (() => void) => {
    const api: LibraryProbeApi = {
        ...bindings,
        stack: () => useCollectionNavigationStore.getState().snapshot?.stack.map(collection => collection.name) ?? [],
        setQuery: (query) => {
            const filter = useAppViewStore.getState().commandFilter;
            if (!filter) return false;
            filter.setQuery(query);
            return true;
        },
        getQuery: () => useAppViewStore.getState().commandFilter?.getQuery() ?? null,
        surface: () => useGridSurfaceStore.getState().gridSurface?.getState() ?? null,
        runSurface: (action) => {
            const surface = useGridSurfaceStore.getState().gridSurface;
            if (!surface || !surface.getState().availableActions.includes(action)) return false;
            surface.run(action);
            return true;
        },
        calls: () => getProbeLog().calls,
        requests: () => getProbeLog().requests,
        clearLog: () => {
            clearProbeCalls();
            clearProbeRequests();
        },
    };
    window.__libraryProbe = api;
    return () => {
        if (window.__libraryProbe === api) {
            delete window.__libraryProbe;
        }
    };
};
