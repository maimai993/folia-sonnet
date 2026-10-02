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
import GridMap, { type GridMapItem } from '../../../src/library/suites/grid/directory/GridMap';
import GridMapBatchPanel from '../../../src/library/suites/grid/directory/GridMapBatchPanel';
import type { GridMapBatchConfig, GridMapBatchContext, GridMapDirectoryNode } from '../../../src/library/suites/grid/directory/gridMapBatch';
import { isHideableGridItem } from '../../../src/library/suites/grid/directory/gridItemVisibility';
import { SidePanelList } from '../../../src/components/shared/SidePanelList';
import { addProbeFault, setProbeLatency } from '../libraryBehavior/fakeProviders';
import { probeRefreshGate } from '../libraryBehavior/probeGates';
import { clearProbeCalls, clearProbeRequests, getProbeLog } from '../libraryBehavior/probeLog';
import type {
    HomeBatchAction,
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
// 打开侧面板的按钮，和隐藏管理面板里的两个开关（都在本文件里注明）。

const HIDDEN_STORAGE_KEY = 'hidden_grid_playlists';

type HarnessBindings = Pick<HomeProbeApi, 'sandbox' | 'ready' | 'remount' | 'localSongIds' | 'localPlaylists' | 'providers' | 'activeProvider' | 'switchProvider'>;

type SurfaceProps = {
    items: Grid3DSliderItem[];
    tabs?: DesktopGrid3DAction[];
    actions?: DesktopGrid3DAction[];
    isLoading?: boolean;
    playlistVisibilityScope?: string;
    batchConfig?: GridMapBatchConfig;
};
type SliderProps = { items: Grid3DSliderItem[]; onSelect: (item: Grid3DSliderItem, index: number) => void };
type GridMapProps = {
    items: GridMapItem[];
    onBack: () => void;
    isPlaylistHidden?: (item: GridMapItem) => boolean;
    onTogglePlaylistHidden?: (item: GridMapItem) => void;
    batchConfig?: GridMapBatchConfig;
};
type BatchPanelProps = {
    context: GridMapBatchContext;
    totalItemCount: number;
    config: GridMapBatchConfig;
    onToggleSelectAll: (selected: boolean) => void;
    onSetItemsSelected: (itemIds: string[], selected: boolean) => void;
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

const flattenDirectory = (nodes: GridMapDirectoryNode[] = []): GridMapDirectoryNode[] => (
    nodes.flatMap(node => [node, ...flattenDirectory(node.children)])
);

const batchActionsOf = (config: GridMapBatchConfig): HomeBatchAction[] => [
    'play',
    'enqueue',
    'create-playlist',
    ...(config.onRemove ? ['remove' as const] : []),
    ...(config.onRescanRoot ? ['rescan-root' as const] : []),
    ...(config.onRemoveRoot ? ['remove-root' as const] : []),
    ...(config.onClearFolderIgnore ? ['clear-ignore' as const] : []),
];

// ---- 隐藏管理面板（没有批量配置时 GridMap 侧面板里的两个开关）：只能点 DOM ----
const panelButton = (labelKey: string): HTMLButtonElement | null => {
    const root = firstHostElement(gridMapFiber());
    if (!root) return null;
    const label = i18n.t(labelKey);
    return [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === label) ?? null;
};
const readHiddenView = (): HomeHiddenView => {
    if (panelButton('home.showAllPlaylists')) return 'manage-hidden-only';
    if (panelButton('home.finishHidingPlaylists')) return 'manage';
    return 'browse';
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

/** 安装 `window.__homeProbe`，返回卸载函数。 */
export const installHomeProbeApi = (bindings: HarnessBindings): (() => void) => {
    const api: HomeProbeApi = {
        ...bindings,

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
            const visible = new Set((sliderProps()?.items ?? []).map(item => asId(item.id)));
            return props.items.map(item => {
                const hideable = isHideableGridItem(item);
                return {
                    id: asId(item.id),
                    name: nameOf(item.name),
                    type: item.type,
                    trackCount: item.trackCount,
                    trackIds: item.trackIds,
                    description: item.description,
                    hideable,
                    hidden: hideable && !visible.has(asId(item.id)),
                };
            });
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
            const props = gridMapProps();
            const items = mapDisplayItems();
            if (!props || !items) return [];
            return items.map(item => ({
                id: asId(item.id),
                name: item.name,
                type: item.type,
                path: item.path,
                description: item.description,
                trackIds: item.trackIds,
                hidden: isHideableGridItem(item) && Boolean(props.isPlaylistHidden?.(item)),
            }));
        },
        setQuery: query => {
            const filter = useAppViewStore.getState().commandFilter;
            if (!filter) return false;
            filter.setQuery(query);
            return true;
        },
        getQuery: () => useAppViewStore.getState().commandFilter?.getQuery() ?? null,

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
        batchScope: (): HomeBatchScope | null => {
            const props = batchPanelProps();
            if (!props) return null;
            return {
                selectionType: props.config.selectionType,
                itemIds: props.context.items.map(item => asId(item.id)),
                trackIds: [...props.context.trackIds],
                totalItemCount: props.totalItemCount,
                actions: batchActionsOf(props.config),
            };
        },
        batchSelect: (ids, selected = true) => {
            const props = batchPanelProps();
            if (!props) return false;
            props.onSetItemsSelected(ids, selected);
            return true;
        },
        batchSelectAll: (selected = true) => {
            const props = batchPanelProps();
            if (!props) return false;
            props.onToggleSelectAll(selected);
            return true;
        },
        runBatch: async (action, arg) => {
            const props = batchPanelProps();
            if (!props) return false;
            const { config, context } = props;
            switch (action) {
                case 'play': await config.onPlay(context); return true;
                case 'enqueue': await config.onAddToQueue(context); return true;
                case 'create-playlist': await config.onCreatePlaylist(arg ?? 'Probe Playlist', context); return true;
                case 'remove':
                    if (!config.onRemove) return false;
                    await config.onRemove(context);
                    return true;
                case 'rescan-root':
                    if (!config.onRescanRoot || !arg) return false;
                    await config.onRescanRoot(arg);
                    return true;
                case 'remove-root':
                    if (!config.onRemoveRoot || !arg) return false;
                    await config.onRemoveRoot(arg);
                    return true;
                case 'clear-ignore':
                    if (!config.onClearFolderIgnore || !arg) return false;
                    await config.onClearFolderIgnore(arg);
                    return true;
            }
            return false;
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
            if (!props?.onTogglePlaylistHidden || !item || !isHideableGridItem(item)) return false;
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

