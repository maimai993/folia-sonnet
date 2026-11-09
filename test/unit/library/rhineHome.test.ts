// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RhineHome from '@/library/suites/rhine/RhineHome';
import { buildHomeModel } from '@/components/app/home/buildHomeModel';
import { collectCollections } from '@/library/suites/rhine/rhineLibrary';
import type { LibraryHomeSurfaceProps } from '@/library/core/suite/suite.contract';
import type { LibraryHomeFeedResource, LibraryHomeFeedSnapshot } from '@/library/core/home/homeModel.contract';
import type { ProviderCollection } from '@/types/onlineMusic';

// test/unit/library/rhineHome.test.ts
// 挂实际首页与载荷转换，只替换外部端口；锁住无关重渲染、资源通知和 iframe 来源边界。
const ports = vi.hoisted(() => ({
    tracks: vi.fn(), search: vi.fn(), settings: vi.fn(), submitSearch: vi.fn(), setQuery: vi.fn(),
    t: (key: string) => key,
    language: 'en', daylight: false,
}));
// 组件这边把几个 store 都当 hook 用（`useX(select)`），测试还要能 `getState()`：
// 统一包成「可调用 + 带 getState」的形状，两边都满足。工厂会被提升，所以用 vi.hoisted。
const { asHookStore } = vi.hoisted(() => ({
    asHookStore: <T extends object>(state: T) => Object.assign(
        (select: (value: T) => unknown) => select(state),
        { getState: () => state },
    ),
}));
// 设置 kit 的链上还会 `i18n.use(initReactI18next)`，这个插件一并给出来。
vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: ports.t, i18n: { language: ports.language } }),
    initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('@/services/onlineMusic/omni', () => ({ omni: { getCollectionTracks: ports.tracks, searchSongs: ports.search } }));
vi.mock('@/services/onlineMusic/omni/activeProvider', () => ({ activeProviderId: () => 'test' }));
vi.mock('@/stores/useOnlineProviderAccountStore', () => ({ useOnlineProviderAccountStore: asHookStore({ accounts: {} }) }));
vi.mock('@/stores/useThemeSettingsStore', () => ({ useThemeSettingsStore: (select: (state: { isDaylight: boolean }) => unknown) => select({ isDaylight: ports.daylight }) }));
// 可视化装配那几个 hook 会读 settingsModalState.isOpen / isSubSettingsViewOpen 之类，一并给默认值。
vi.mock('@/stores/useSettingsModalStore', () => ({
    openSettings: ports.settings,
    useSettingsModalStore: asHookStore({
        openSettings: ports.settings,
        settingsModalState: { isOpen: false },
        isSubSettingsViewOpen: false,
        isUserGuideModalOpen: false,
        pinnedCommandIds: [],
        appLanguagePreference: 'auto',
        setIsSubSettingsViewOpen: () => {},
        handleSetAppLanguagePreference: () => {},
    }),
}));
vi.mock('@/stores/useSearchNavigationStore', () => ({ useSearchNavigationStore: asHookStore({ setSearchQuery: ports.setQuery, submitSearch: ports.submitSearch }) }));
// RhineHome 与可视化装配都把 usePlaybackStore 当 hook 用、还会取多个具名导出：用真实 store
// （测试环境里没有在播的歌，选择器结果就是空）。原来只给 getState 的 mock 已经不匹配了。
vi.mock('@/stores/usePlaybackStore', async (importOriginal) => ({ ...(await importOriginal<object>()) }));
vi.mock('@/utils/appPlaybackGuards', () => ({ getPlaybackSongKey: (song: { id: string }) => song.id }));
vi.mock('@/services/phoneInsets', () => ({ getPhoneInsets: () => ({}), subscribePhoneInsets: () => () => {} }));
vi.mock('@/components/login/loginWindowStore', () => ({ openLoginWindow: vi.fn() }));
vi.mock('@/components/ui/Button', () => ({ Button: () => null }));
// 设置 kit（CopyButton 等）从图标库拿一堆图标：用真实模块，只把登录那个换掉。
vi.mock('lucide-react', async (importOriginal) => ({ ...(await importOriginal<object>()), LogIn: () => null }));
vi.mock('@/components/app/playing-song-locator/playingSongLocator', () => ({ noteQueueStarted: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const collection = (id: string): ProviderCollection => ({ id, name: id } as ProviderCollection);
const song = { id: 'song', name: 'Song' };

/** 模拟宿主资源：快照不可变，loading/error 可沿用同一 data 引用。 */
const feed = (data: ProviderCollection[] = []) => {
    let snapshot: LibraryHomeFeedSnapshot<ProviderCollection[]> = { data, owners: [], status: 'ready', loaded: true };
    const listeners = new Set<() => void>();
    const resource: LibraryHomeFeedResource<ProviderCollection[]> = {
        getSnapshot: () => snapshot,
        subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        setOwners: vi.fn(), ensure: async () => {}, reload: async () => {},
    };
    return {
        resource, listeners,
        update: (next: ProviderCollection[], status: LibraryHomeFeedSnapshot<ProviderCollection[]>['status'] = 'ready') => {
            snapshot = { ...snapshot, data: next, status };
            listeners.forEach(listener => listener());
        },
    };
};

let root: Root | null;
let container: HTMLDivElement;
let props: LibraryHomeSurfaceProps;
let favorites: ReturnType<typeof feed>;
const render = async (next: LibraryHomeSurfaceProps = props) => {
    props = next;
    await act(async () => { root!.render(createElement(RhineHome, props)); });
};
const frame = () => container.querySelector('iframe')!.contentWindow!;
const message = async (data: unknown, source: MessageEventSource | null = frame()) => {
    await act(async () => { window.dispatchEvent(new MessageEvent('message', { data, source })); });
};

beforeEach(() => {
    vi.clearAllMocks();
    ports.language = 'en';
    ports.daylight = false;
    ports.t = key => key;
    ports.tracks.mockResolvedValue({ items: [song] });
    ports.search.mockResolvedValue({ items: [song] });
    favorites = feed();
    props = {
        playlists: [collection('playlist')], cloudPlaylist: null,
        homeResources: { favoriteAlbums: favorites.resource }, isInteractive: true,
        localSongs: [], localLibraryCatalog: {},
        onPlaySong: vi.fn(), onAddAllToQueue: vi.fn(), onAddSongToQueue: vi.fn(),
    } as unknown as LibraryHomeSurfaceProps;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    if (root) act(() => root!.unmount());
    container.remove();
});

describe('Rhine home data lifetime', () => {
    it('does not refetch for unrelated props, language, theme or iframe readiness', async () => {
        await render();
        const post = vi.spyOn(frame(), 'postMessage');
        ports.language = 'zh-TW';
        ports.daylight = true;
        await render({ ...props, isInteractive: false, currentTrack: song as never, localSongs: [], onPlaySong: vi.fn() });
        await act(async () => { container.querySelector('iframe')!.dispatchEvent(new Event('load')); });
        expect(ports.tracks).toHaveBeenCalledTimes(1);
        expect(post).toHaveBeenCalledWith({ type: 'rhine-visibility', visible: false }, '*');
        expect(post).toHaveBeenCalledWith({ type: 'rhine-language', language: 'zh-TW' }, '*');
        expect(post).toHaveBeenCalledWith({ type: 'rhine-theme', theme: 'light' }, '*');
    });

    it('does not refetch when the real host rebuilds its filtered playlists on track changes', async () => {
        const collections = props.playlists!;
        const host = (currentSong: unknown) => buildHomeModel({
            ...props,
            activeProvider: { collections },
            currentSong,
        } as unknown as Parameters<typeof buildHomeModel>[0]).surfaceProps;
        const first = host(null);
        await render({ ...props, ...first });
        const next = host(song);
        expect(next.playlists).not.toBe(first.playlists);
        expect(next.playlists?.[0]).toBe(first.playlists?.[0]);
        await render({ ...props, ...next });
        expect(ports.tracks).toHaveBeenCalledTimes(1);
        // 同 id 的新集合对象可能带更新后的元数据，不能只按 id 忽略。
        await render({ ...props, playlists: [{ ...collections[0], name: 'Updated' }] });
        expect(ports.tracks).toHaveBeenCalledTimes(2);
    });

    it('rebuilds for each consumed collection input, including resource-only data notifications', async () => {
        await render();
        await render({ ...props, playlists: [collection('renamed')] });
        expect(ports.tracks).toHaveBeenCalledTimes(2);
        await render({ ...props, cloudPlaylist: collection('cloud') });
        expect(ports.tracks).toHaveBeenCalledTimes(4);
        const albums = [collection('album')];
        await act(async () => favorites.update(albums));
        expect(ports.tracks).toHaveBeenCalledTimes(7);
        await act(async () => favorites.update(albums, 'loading'));
        await act(async () => favorites.update(albums, 'error'));
        expect(ports.tracks).toHaveBeenCalledTimes(7);
    });

    it('switches resource subscriptions and unsubscribes on unmount', async () => {
        await render();
        const next = feed([collection('new-album')]);
        await render({ ...props, homeResources: { ...props.homeResources, favoriteAlbums: next.resource } });
        expect(favorites.listeners.size).toBe(0);
        expect(next.listeners.size).toBe(1);
        const count = ports.tracks.mock.calls.length;
        await act(async () => favorites.update([collection('stale-album')]));
        expect(ports.tracks).toHaveBeenCalledTimes(count);
        act(() => root!.unmount());
        root = null;
        expect(next.listeners.size).toBe(0);
    });

    it('does not inject a stale build after newer data wins or after unmount', async () => {
        let resolveOld!: (value: { items: unknown[] }) => void;
        ports.tracks.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
        await render();
        const post = vi.spyOn(frame(), 'postMessage');
        await render({ ...props, playlists: [collection('new')] });
        expect(post.mock.calls.filter(([data]) => data.type === 'rhine-library')).toHaveLength(1);
        await act(async () => resolveOld({ items: [{ id: 'old', name: 'Old' }] }));
        expect(post.mock.calls.filter(([data]) => data.type === 'rhine-library')).toHaveLength(1);
        let resolveUnmounted!: (value: { items: unknown[] }) => void;
        ports.tracks.mockImplementationOnce(() => new Promise(resolve => { resolveUnmounted = resolve; }));
        await render({ ...props, playlists: [collection('unmounted')] });
        act(() => root!.unmount());
        root = null;
        await act(async () => resolveUnmounted({ items: [song] }));
        expect(post.mock.calls.filter(([data]) => data.type === 'rhine-library')).toHaveLength(1);
    });

    it('keeps the native resource fallback, explicit empty favorites and the existing ten-collection cap', () => {
        favorites.update([collection('native-album')]);
        expect(collectCollections(props).map(entry => entry.id)).toEqual(['playlist', 'native-album']);
        expect(collectCollections({ ...props, favoriteAlbums: [] }).map(entry => entry.id)).toEqual(['playlist']);
        expect(collectCollections({ playlists: Array.from({ length: 12 }, (_, i) => collection(String(i))) })).toHaveLength(10);
    });
});

describe('Rhine iframe message boundary', () => {
    it('rejects every privileged action from null, host and another iframe source', async () => {
        await render();
        const other = document.createElement('iframe');
        document.body.appendChild(other);
        const post = vi.spyOn(other.contentWindow!, 'postMessage');
        for (const source of [null, window, other.contentWindow]) {
            for (const type of ['rhine-open-settings', 'rhine-open-search', 'rhine-search', 'rhine-play', 'rhine-enqueue']) {
                await message({ type, query: 'query', id: 'X-001' }, source);
            }
        }
        expect(ports.settings).not.toHaveBeenCalled();
        expect(ports.submitSearch).not.toHaveBeenCalled();
        expect(ports.search).not.toHaveBeenCalled();
        expect(props.onPlaySong).not.toHaveBeenCalled();
        expect(props.onAddAllToQueue).not.toHaveBeenCalled();
        expect(props.onAddSongToQueue).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
        other.remove();
    });

    it('accepts settings, search, playback and queue actions only from its current iframe', async () => {
        await render();
        const post = vi.spyOn(frame(), 'postMessage');
        await message({ type: 'rhine-open-settings' });
        await message({ type: 'rhine-search', query: ' query ' });
        await message({ type: 'rhine-play', id: 'X-001' });
        await message({ type: 'rhine-enqueue', id: 'X-001' });
        expect(ports.settings).toHaveBeenCalledWith('options');
        expect(ports.search).toHaveBeenCalledWith('query', { limit: 24, offset: 0 });
        expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'rhine-search-result', query: 'query' }), '*');
        expect(props.onPlaySong).toHaveBeenCalledWith(song, [song], false, undefined);
        expect(props.onAddAllToQueue).toHaveBeenCalledWith([song]);
        await render({ ...props, onAddAllToQueue: undefined });
        await message({ type: 'rhine-enqueue', id: 'X-001' });
        expect(props.onAddSongToQueue).toHaveBeenCalledWith(song);
        expect(ports.tracks).toHaveBeenCalledTimes(1);
    });

    it('opens host search with the latest local library and translation without refetching tracks', async () => {
        await render();
        const localSongs = [{ id: 'latest' }] as unknown as LibraryHomeSurfaceProps['localSongs'];
        const localLibraryCatalog = { ...props.localLibraryCatalog, ready: true };
        ports.t = key => `latest:${key}`;
        await render({ ...props, localSongs, localLibraryCatalog });
        await message({ type: 'rhine-open-search', query: ' query ' });
        expect(ports.setQuery).toHaveBeenCalledWith('query');
        const request = ports.submitSearch.mock.calls[0][0];
        expect(request.deps.localSongs).toBe(localSongs);
        expect(request.deps.localLibraryCatalog).toBe(localLibraryCatalog);
        expect(request.deps.t('key')).toBe('latest:key');
        expect(request.deps.t('key', 'fallback')).toBe('fallback');
        expect(ports.tracks).toHaveBeenCalledTimes(1);
    });
});
