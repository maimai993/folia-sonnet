import { useAppViewStore } from '../../../src/stores/useAppViewStore';
import { useGridSurfaceStore } from '../../../src/stores/useGridSurfaceStore';
import { useCollectionNavigationStore } from '../../../src/stores/useCollectionNavigationStore';
import { useLibrarySuiteStore } from '../../../src/library/core/state/useLibrarySuiteStore';
import { switchLibrarySuite } from '../../../src/library/app/switchLibrarySuite';
import { listLibrarySuites, resolveLibrarySurface } from '../../../src/library/registry';
import type { LibrarySuiteId } from '../../../src/library/core/contracts/suite';
import { collectionKey } from '../../../src/library/core/model/collectionIdentity';
import type { LibraryProbeApi } from './probeApi';
import { clearProbeCalls, clearProbeRequests, getProbeLog } from './probeLog';
import { holdProbePaging, onlineFixtureTarget, releaseProbePaging } from './fakeProviders';
import { probeRefreshGate } from './probeGates';

// dev/probes/libraryBehavior/libraryProbeApi.ts
// 把探针的驱动接口挂到 window 上。查询、动作都经由真实的注册点（命令筛选、grid surface），
// 用的是命令面板同一条通道，所以它测到的就是命令面板能做到的事。

type HarnessBindings = Pick<LibraryProbeApi, 'sandbox' | 'fixtures' | 'ready' | 'open' | 'back' | 'pushArtist'>;

const setSuite = (suite: LibrarySuiteId) => {
    const stack = useCollectionNavigationStore.getState().snapshot?.stack ?? [];
    switchLibrarySuite(collectionKey(stack[stack.length - 1]), suite);
};
const currentSuite = () => useLibrarySuiteStore.getState().suite;

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
        setSuite,
        suite: currentSuite,
        setRenderer: setSuite,
        renderer: currentSuite,
        suites: () => listLibrarySuites().map(suite => suite.id),
        resolveSurface: (surface) => {
            const resolved = resolveLibrarySurface(surface, currentSuite());
            return { suiteId: resolved.suiteId, isFallback: resolved.isFallback, declaredActions: resolved.declaredActions };
        },
        holdPages: fixtureId => holdProbePaging(onlineFixtureTarget(fixtureId)),
        releasePages: fixtureId => releaseProbePaging(onlineFixtureTarget(fixtureId)),
        holdRefresh: kind => probeRefreshGate(kind).hold(),
        releaseRefresh: kind => probeRefreshGate(kind).release(),
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
