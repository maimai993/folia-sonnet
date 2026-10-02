import i18n from '../../../src/i18n/config';
import { useAppViewStore } from '../../../src/stores/useAppViewStore';
import { useCollectionNavigationStore } from '../../../src/stores/useCollectionNavigationStore';
import { useSearchNavigationStore } from '../../../src/stores/useSearchNavigationStore';
import type { HomeViewTab } from '../../../src/types';
import Grid3D from '../../../src/library/suites/grid/home/Grid3D';
import DesktopGrid3DSurface, { type DesktopGrid3DAction } from '../../../src/library/suites/grid/home/DesktopGrid3DSurface';
import { Grid3DSlider, type Grid3DSliderItem } from '../../../src/library/suites/grid/home/Grid3DSlider';
import { GridViewTabs } from '../../../src/library/suites/grid/home/GridViewTabs';
import LocalGrid3DView from '../../../src/library/suites/grid/home/LocalGrid3DView';
import GridMap, { type GridMapBatchConfig, type GridMapItem } from '../../../src/library/suites/grid/directory/GridMap';
import GridMapBatchPanel from '../../../src/library/suites/grid/directory/GridMapBatchPanel';
import type { LibraryDirectoryNode } from '../../../src/library/core/contracts/directory';
import { resolveDirectoryBatchActions, resolveDirectoryBatchScope, runDirectoryBatchAction } from '../../../src/library/core/model/directoryBatch';
import { getLibraryDirectorySession, useLibraryDirectorySessionStore } from '../../../src/library/core/state/useLibraryDirectorySessionStore';
import { useLibraryDirectorySurfaceStore } from '../../../src/library/core/state/useLibraryDirectorySurfaceStore';
import { COMMAND_PALETTE_COMMANDS, isCommandPaletteCommandEnabled } from '../../../src/components/command-palette/commandRegistry';
import type { CommandPaletteContext } from '../../../src/components/command-palette/types';
import { useGridSurfaceStore } from '../../../src/stores/useGridSurfaceStore';
import { hiddenIdsOf, isDirectoryItemHidden, isHideableDirectoryItem } from '../../../src/library/core/model/directoryVisibility';
import { useHiddenCollectionsStore } from '../../../src/library/core/state/useHiddenCollectionsStore';
import type { LibraryHiddenScope } from '../../../src/library/core/contracts/directory';
import { SidePanelList } from '../../../src/components/shared/SidePanelList';
import { addProbeFault, setProbeLatency } from '../libraryBehavior/fakeProviders';
import { probeRefreshGate } from '../libraryBehavior/probeGates';
import { clearProbeCalls, clearProbeRequests, getProbeLog } from '../libraryBehavior/probeLog';
import type {
    HomeBatchScope,
    HomeHiddenView,
    HomeProbeApi,
    HomeProbeDescriptor,
    HomeProbeTab,
    HomeTabKey,
} from './probeApi';
import {
    findPresentComponent,
    firstHostElement,
    propsOf,
} from './reactFiberProbe';

// dev/probes/homeBehavior/homeProbeApi.ts
// `window.__homeProbe` 的网格实现。读的是界面交给叶子组件的 props（见 reactFiberProbe.ts 的说明），
// 调的是这些 props 里的回调——与点击走同一个函数。只有两处没有 props 可调、只能点 DOM：GridMap 标题上
// 打开侧面板的按钮，和隐藏管理面板里的两个开关（都在本文件里注明）。隐藏状态读的是 core 的隐藏 store
// （按当前列表的作用域），不从组件 props 推断。
// 目录的筛选词、批选、隐藏视图读写 core 的目录会话（GridMap 的 directoryKey 指向哪一个），批量范围用 core 的
// resolveDirectoryBatchScope 现算，批量动作经 runDirectoryBatchAction 交给控制器——与面板按钮同一个入口。

const HIDDEN_STORAGE_KEY = 'hidden_grid_playlists';

type HarnessBindings = Pick<HomeProbeApi, 'sandbox' | 'ready' | 'remount' | 'localSongIds' | 'localPlaylists' | 'providers' | 'activeProvider' | 'switchProvider'>;

type SurfaceProps = {
    items: Grid3DSliderItem[];
    tabs?: DesktopGrid3DAction[];
    actions?: DesktopGrid3DAction[];
    isLoading?: boolean;
    playlistVisibilityScope?: LibraryHiddenScope;
    batchConfig?: GridMapBatchConfig;
};
type SliderProps = { items: Grid3DSliderItem[]; onSelect: (item: Grid3DSliderItem, index: number) => void };
type GridMapProps = {
    directoryKey?: string;
    items: GridMapItem[];
    onBack: () => void;
    onTogglePlaylistHidden?: (item: GridMapItem) => void;
    batchConfig?: GridMapBatchConfig;
};
type BatchPanelProps = {
    config: GridMapBatchConfig;
};

const surfaceFiber = () => findPresentComponent(DesktopGrid3DSurface);
const surfaceProps = () => propsOf<SurfaceProps>(surfaceFiber());
const sliderProps = () => propsOf<SliderProps>(findPresentComponent(Grid3DSlider, surfaceFiber()));
const gridMapFiber = () => findPresentComponent(GridMap, surfaceFiber());
const gridMapProps = () => propsOf<GridMapProps>(gridMapFiber());
const batchPanelProps = () => propsOf<BatchPanelProps>(findPresentComponent(GridMapBatchPanel, gridMapFiber()));
// GridMap 把筛选后的 displayItems 原样交给侧栏列表（侧栏收起时也在渲染），它就是「GridMap 此刻显示的卡」。
const mapDisplayItems = (): GridMapItem[] | null => {
    const map = gridMapFiber();
    if (!map) return null;
    return propsOf<{ items: GridMapItem[] }>(findPresentComponent(SidePanelList, map))?.items ?? null;
};

/** GridMap 此刻读写的目录会话 key（地图没开时为 null）。 */
const mapSessionId = (): string | null => gridMapProps()?.directoryKey ?? null;

/** 当前列表作用域的隐藏 id（core 的隐藏 store；作用域缺省与 DesktopGrid3DSurface 一样落在 default）。 */
const currentHiddenIds = () => hiddenIdsOf(
    useHiddenCollectionsStore.getState().hiddenByScope,
    surfaceProps()?.playlistVisibilityScope ?? 'default',
);

const asId = (id: string | number) => String(id);
const nameOf = (name: unknown) => (typeof name === 'string' || typeof name === 'number' ? String(name) : '');

const TAB_LABEL_KEYS: Record<HomeTabKey, string> = {
    playlist: 'home.playlists',
    radio: 'home.radio',
    albums: 'home.albums',
    local: 'localMusic.folder',
    navidrome: 'navidrome.title',
};

// 首页一级页签写在 Grid3D 的 JSX 里，没有 props 可读：按文案认出按钮（每个按钮外面包着带 title 的 span）。
const readTabs = (): HomeProbeTab[] => {
    const root = firstHostElement(findPresentComponent(Grid3D));
    if (!root) return [];
    const byLabel = new Map((Object.keys(TAB_LABEL_KEYS) as HomeTabKey[]).map(key => [i18n.t(TAB_LABEL_KEYS[key]), key]));
    return [...root.querySelectorAll<HTMLButtonElement>('span.inline-flex[title] > button')].flatMap(button => {
        const label = button.textContent?.trim() ?? '';
        const key = byLabel.get(label);
        if (!key) return [];
        const ariaLabel = button.getAttribute('aria-label') ?? label;
        return [{ key, label, disabled: button.disabled, ...(ariaLabel !== label ? { reason: ariaLabel } : {}) }];
    });
};

const summarizeDescriptor = (detail: unknown): HomeProbeDescriptor => detail as HomeProbeDescriptor;

const flattenDirectory = (nodes: LibraryDirectoryNode[] = []): LibraryDirectoryNode[] => (
    nodes.flatMap(node => [node, ...flattenDirectory(node.children)])
);

// ---- 隐藏管理面板（没有批量配置时 GridMap 侧面板里的两个开关）：只能点 DOM ----
const panelButton = (labelKey: string): HTMLButtonElement | null => {
    const root = firstHostElement(gridMapFiber());
    if (!root) return null;
    const label = i18n.t(labelKey);
    return [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === label) ?? null;
};
// 隐藏视图就是目录会话里的 visibilityMode（GridMap 的隐藏编辑模式读写它）。
const readHiddenView = (): HomeHiddenView => {
    const sessionId = mapSessionId();
    return sessionId ? getLibraryDirectorySession(sessionId).visibilityMode : 'browse';
};

/** 地图此刻的批量范围：可见 → 筛选 → 选中，全部从目录会话与 core 的纯规则现算。 */
const currentBatchScope = () => {
    const props = gridMapProps();
    const sessionId = mapSessionId();
    if (!props || !sessionId) return null;
    const session = getLibraryDirectorySession(sessionId);
    return resolveDirectoryBatchScope({
        items: props.items,
        hiddenIds: currentHiddenIds(),
        visibilityMode: session.visibilityMode,
        query: session.query,
        selectedIds: new Set(session.selectedIds),
    });
};
const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const waitFor = async (check: () => boolean, frames = 60): Promise<boolean> => {
    for (let frame = 0; frame < frames; frame += 1) {
        if (check()) return true;
        await nextFrame();
    }
    return check();
};
// GridMap 标题按钮：打开 / 关闭侧面板（批量面板或隐藏管理面板）。
const titleButton = (): HTMLButtonElement | null => (
    firstHostElement(gridMapFiber())?.querySelector<HTMLButtonElement>('button[class*="group/grid-title"]') ?? null
);
const isPanelOpen = () => Boolean(batchPanelProps()) || Boolean(panelButton('home.hidePlaylists') || panelButton('home.finishHidingPlaylists'));

// ---- 目录命令：真实的命令定义，配一个只有 scope 与 t 的 context（目录命令只用到这两样） ----
const DIRECTORY_COMMANDS = COMMAND_PALETTE_COMMANDS.filter(command => command.scope === 'directory-surface');
const directoryCommandContext = (): CommandPaletteContext => ({
    scope: {
        view: useAppViewStore.getState().view,
        filter: useAppViewStore.getState().commandFilter,
        grid: useGridSurfaceStore.getState().gridSurface,
        directory: useLibraryDirectorySurfaceStore.getState().directorySurface,
    },
    shared: { t: (key: string, fallback?: string) => i18n.t(key, { defaultValue: fallback }) },
}) as unknown as CommandPaletteContext;

/** 安装 `window.__homeProbe`，返回卸载函数。 */
export const installHomeProbeApi = (bindings: HarnessBindings): (() => void) => {
    const api: HomeProbeApi = {
        ...bindings,
        // 模拟重启：隐藏 store 是模块级状态，重挂载不会重读存储；先从 localStorage 重读一遍，
        // 「重启后仍隐藏」断言的才是持久化的那份。
        remount: () => {
            useHiddenCollectionsStore.getState().hydrate();
            bindings.remount();
        },

        tabs: readTabs,
        tab: () => useSearchNavigationStore.getState().homeViewTab as HomeTabKey,
        setTab: tab => useSearchNavigationStore.getState().setHomeViewTab(tab as HomeViewTab),
        sections: () => (surfaceProps()?.tabs ?? []).map(tab => ({ id: tab.id, active: Boolean(tab.active) })),
        setSection: id => {
            const tab = surfaceProps()?.tabs?.find(candidate => candidate.id === id);
            if (!tab) return false;
            tab.onClick();
            return true;
        },
        items: () => {
            const props = surfaceProps();
            if (!props) return [];
            const hiddenIds = currentHiddenIds();
            return props.items.map(item => ({
                id: asId(item.id),
                name: nameOf(item.name),
                type: item.type,
                trackCount: item.trackCount,
                trackIds: item.trackIds,
                description: item.description,
                ...(item.isVirtual ? { isVirtual: true } : {}),
                hideable: isHideableDirectoryItem(item),
                hidden: isDirectoryItemHidden(item, hiddenIds),
            }));
        },
        visibleItems: () => (sliderProps()?.items ?? []).map(item => asId(item.id)),
        scope: () => surfaceProps()?.playlistVisibilityScope ?? null,
        isLoading: () => Boolean(surfaceProps()?.isLoading),
        actions: () => (surfaceProps()?.actions ?? []).map(action => ({ id: action.id, disabled: Boolean(action.disabled) })),
        runAction: id => {
            const action = surfaceProps()?.actions?.find(candidate => candidate.id === id);
            if (!action || action.disabled) return false;
            action.onClick();
            return true;
        },
        importPlaylistFile: async (fileName, text) => {
            const props = propsOf<{ onImportPlaylistFile?: (file: File) => Promise<void> | void }>(findPresentComponent(LocalGrid3DView));
            if (!props?.onImportPlaylistFile) return false;
            await props.onImportPlaylistFile(new File([text], fileName, { type: 'audio/x-mpegurl' }));
            return true;
        },

        open: id => {
            const props = sliderProps();
            const index = props?.items.findIndex(item => asId(item.id) === id) ?? -1;
            if (!props || index < 0) return false;
            props.onSelect(props.items[index], index);
            return true;
        },
        opened: () => getProbeLog().calls.filter(call => call.kind === 'openCollection').map(call => summarizeDescriptor(call.detail)),
        stack: () => useCollectionNavigationStore.getState().snapshot?.stack.map(collection => collection.name) ?? [],
        closeCollection: () => useCollectionNavigationStore.getState().clear(),

        openMap: () => {
            const onOpenMap = propsOf<{ onOpenMap?: () => void }>(findPresentComponent(GridViewTabs, surfaceFiber()))?.onOpenMap;
            if (!onOpenMap) return false;
            onOpenMap();
            return true;
        },
        closeMap: () => {
            const props = gridMapProps();
            if (!props) return false;
            props.onBack();
            return true;
        },
        isMapOpen: () => Boolean(gridMapFiber()),
        mapItems: () => {
            const items = mapDisplayItems();
            if (!gridMapFiber() || !items) return [];
            const hiddenIds = currentHiddenIds();
            return items.map(item => ({
                id: asId(item.id),
                name: item.name,
                type: item.type,
                path: item.path,
                description: item.description,
                trackIds: item.trackIds,
                ...(item.isVirtual ? { isVirtual: true } : {}),
                hidden: isDirectoryItemHidden(item, hiddenIds),
            }));
        },
        setQuery: query => {
            const filter = useAppViewStore.getState().commandFilter;
            if (!filter) return false;
            filter.setQuery(query);
            return true;
        },
        // 地图开着时读它的目录会话；地图关掉（会话已清）时为 null。
        getQuery: () => {
            const sessionId = mapSessionId();
            return sessionId ? getLibraryDirectorySession(sessionId).query : null;
        },

        batchAvailable: () => Boolean(surfaceProps()?.batchConfig),
        openPanel: () => {
            if (isPanelOpen()) return true;
            const button = titleButton();
            if (!button || button.disabled) return false;
            button.click();
            return true;
        },
        closePanel: () => {
            if (!isPanelOpen()) return true;
            const button = titleButton();
            if (!button) return false;
            button.click();
            return true;
        },
        isBatchOpen: () => Boolean(batchPanelProps()),
        // 批量面板开着才有范围（面板是否在场仍看组件树；范围本身从会话现算）。
        batchScope: (): HomeBatchScope | null => {
            const props = batchPanelProps();
            const scope = currentBatchScope();
            if (!props || !scope) return null;
            return {
                selectionType: props.config.selectionType,
                itemIds: scope.context.items.map(item => asId(item.id)),
                trackIds: [...scope.context.trackIds],
                totalItemCount: scope.displayItems.length,
                actions: resolveDirectoryBatchActions(props.config),
            };
        },
        batchSelect: (ids, selected = true) => {
            const sessionId = mapSessionId();
            if (!batchPanelProps() || !sessionId) return false;
            useLibraryDirectorySessionStore.getState().setSelected(sessionId, ids, selected);
            return true;
        },
        // 与面板的「全选」一样：选中的是当前筛选出的卡片。
        batchSelectAll: (selected = true) => {
            const sessionId = mapSessionId();
            const scope = currentBatchScope();
            if (!batchPanelProps() || !sessionId || !scope) return false;
            useLibraryDirectorySessionStore.getState().replaceSelection(
                sessionId,
                selected ? scope.displayItems.map(item => asId(item.id)) : [],
            );
            return true;
        },
        runBatch: async (action, arg) => {
            const props = batchPanelProps();
            const scope = currentBatchScope();
            if (!props || !scope) return false;
            const result = await runDirectoryBatchAction(
                props.config,
                action,
                scope.context,
                action === 'create-playlist' ? (arg ?? 'Probe Playlist') : arg,
            );
            return result.ok;
        },
        directorySurface: () => useLibraryDirectorySurfaceStore.getState().directorySurface?.getState() ?? null,
        directoryCommands: () => {
            const context = directoryCommandContext();
            return DIRECTORY_COMMANDS.filter(command => isCommandPaletteCommandEnabled(command, context)).map(command => command.id);
        },
        runDirectoryCommand: async (id, input = '') => {
            const context = directoryCommandContext();
            const command = DIRECTORY_COMMANDS.find(candidate => candidate.id === id);
            if (!command || !isCommandPaletteCommandEnabled(command, context)) return false;
            return Boolean(await command.execute(input, context));
        },
        directoryNodes: () => flattenDirectory(batchPanelProps()?.config.directoryTrees ?? surfaceProps()?.batchConfig?.directoryTrees).map(node => ({
            path: node.path,
            rootPath: node.rootPath,
            depth: node.depth,
            ignored: Boolean(node.ignored),
            directTrackCount: node.directTrackCount,
            totalTrackCount: node.totalTrackCount,
        })),

        toggleHidden: id => {
            const props = gridMapProps();
            const item = props?.items.find(candidate => asId(candidate.id) === id);
            if (!props?.onTogglePlaylistHidden || !item || !isHideableDirectoryItem(item)) return false;
            props.onTogglePlaylistHidden(item);
            return true;
        },
        hiddenView: readHiddenView,
        setHiddenView: async view => {
            if (!gridMapFiber() || batchPanelProps()) return false;
            if (!isPanelOpen()) {
                titleButton()?.click();
                if (!await waitFor(isPanelOpen)) return false;
            }
            const wantsManage = view !== 'browse';
            if ((readHiddenView() !== 'browse') !== wantsManage) {
                (panelButton('home.hidePlaylists') ?? panelButton('home.finishHidingPlaylists'))?.click();
                if (!await waitFor(() => (readHiddenView() !== 'browse') === wantsManage)) return false;
            }
            if (wantsManage && (readHiddenView() === 'manage-hidden-only') !== (view === 'manage-hidden-only')) {
                (panelButton('home.showHiddenPlaylistsOnly') ?? panelButton('home.showAllPlaylists'))?.click();
                if (!await waitFor(() => readHiddenView() === view)) return false;
            }
            return readHiddenView() === view;
        },
        storedHidden: () => {
            try {
                return JSON.parse(localStorage.getItem(HIDDEN_STORAGE_KEY) ?? '{}') as Record<string, string[]>;
            } catch {
                return {};
            }
        },

        setLatency: (target, latency) => setProbeLatency(target, latency),
        addFault: addProbeFault,
        holdRefresh: kind => probeRefreshGate(kind).hold(),
        releaseRefresh: kind => probeRefreshGate(kind).release(),
        calls: () => getProbeLog().calls,
        requests: () => getProbeLog().requests,
        clearLog: () => {
            clearProbeCalls();
            clearProbeRequests();
        },
    };
    window.__homeProbe = api;
    return () => {
        if (window.__homeProbe === api) delete window.__homeProbe;
    };
};

