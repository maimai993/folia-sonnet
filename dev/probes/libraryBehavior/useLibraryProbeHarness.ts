import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocalPlaylist, LocalSong, SongResult } from '../../../src/types';
import type { ProviderCollection } from '../../../src/types/onlineMusic';
import type { NavidromeSong } from '../../../src/types/navidrome';
import type { HomeSurfaceProps } from '../../../src/components/app/home/homeSurfaceTypes';
import {
    createLocalGridViewCollection,
    createNavidromeGridViewCollection,
    createOnlineGridViewCollection,
    type GridViewCollectionDescriptor,
} from '../../../src/components/app/home/gridViewCollectionAdapters';
import { buildLocalGrid3DGroups } from '../../../src/components/app/home/localGrid3DModel';
import { useLocalLibraryCatalog, type LocalLibraryCatalogSnapshot } from '../../../src/hooks/useLocalLibraryCatalog';
import { useCollectionNavigationStore } from '../../../src/stores/useCollectionNavigationStore';
import { useOnlineProviderAccountStore } from '../../../src/stores/useOnlineProviderAccountStore';
import { unregisterOnlineMusicProvider } from '../../../src/services/onlineMusic/providerRegistry';
import { DEFAULT_THEME } from '../../../src/services/baseThemes';
import { getPlaybackSongKey } from '../../../src/utils/appPlaybackGuards';
import {
    LOCAL_PLAYLIST_NAME,
    NAVIDROME_ALBUM_ID,
    NAVIDROME_ALBUM_SONGS,
    NAVIDROME_PLAYLIST_ID,
    NAVIDROME_PLAYLIST_SONGS,
    ONLINE_FIXTURES,
    PROBE_PROVIDER_A,
    PROBE_PROVIDER_B,
    type OnlineFixtureId,
    type ProbeFixtureId,
} from './fixtureRules';
import { describeOnlineFixture, registerFakeProviders, resetFakeProviders } from './fakeProviders';
import { IN_MEMORY_LOCAL_PLAYLIST, LOCAL_FIXTURE_SONGS, readLocalLibrary, seedLocalLibrary } from './localFixtures';
import { installNavidromeShim, NAVIDROME_PROBE_CONFIG } from './navidromeShim';
import { recordProbeCall } from './probeLog';
import { installLibraryProbeApi } from './libraryProbeApi';

// dev/probes/libraryBehavior/useLibraryProbeHarness.ts
// 探针的「假 App」：装配 GridViewOverlayHost 需要的 surfaceProps（回调全部记账）、导航回调
// （去掉 history 的 useAppNavigation），以及把 fixture id 换成首页同款集合描述的入口。

const NAVIDROME_CONFIG_KEY = 'navidrome_config';
const ALL_FIXTURES = [
    ...Object.keys(ONLINE_FIXTURES),
    'local-all',
    'local-folder',
    'local-playlist',
    'local-album',
    'navi-album',
    'navi-playlist',
] as ProbeFixtureId[];
const SANDBOX_ONLY: ReadonlySet<ProbeFixtureId> = new Set(['local-playlist', 'local-album', 'navi-album', 'navi-playlist']);

export const isProbeSandbox = (): boolean => (
    Boolean(navigator.webdriver) || new URLSearchParams(window.location.search).has('sandbox')
);

const songKeys = (songs: SongResult[] | undefined) => (songs ?? []).map(getPlaybackSongKey);

const STATIC_CATALOG: LocalLibraryCatalogSnapshot = {
    entities: [],
    assignments: [],
    ready: true,
    reload: async () => {},
};

// 首页「歌单」页签里能看到的那几张：每日推荐在真实首页属于电台页签，不在歌单列表里。
const buildPlaylistList = (): ProviderCollection[] => (
    (Object.keys(ONLINE_FIXTURES) as OnlineFixtureId[])
        .filter(id => ONLINE_FIXTURES[id].type === 'playlist')
        .map(describeOnlineFixture)
);

const popNavigation = () => {
    const store = useCollectionNavigationStore.getState();
    const snapshot = store.snapshot;
    if (!snapshot || snapshot.stack.length <= 1) {
        store.clear();
        return;
    }
    store.restore({ ...snapshot, stack: snapshot.stack.slice(0, -1) });
};

export type LibraryProbeHarness = {
    sandbox: boolean;
    ready: boolean;
    fixtures: ProbeFixtureId[];
    surfaceProps: HomeSurfaceProps;
    open: (fixtureId: ProbeFixtureId) => void;
    back: () => void;
    onOpenCollection: (collection: GridViewCollectionDescriptor) => void;
    onPushCollection: (collection: GridViewCollectionDescriptor) => void;
};

export const useLibraryProbeHarness = (): LibraryProbeHarness => {
    const { t } = useTranslation();
    const sandbox = useMemo(isProbeSandbox, []);
    const [ready, setReady] = useState(false);
    const [localSongs, setLocalSongs] = useState<LocalSong[]>(sandbox ? [] : LOCAL_FIXTURE_SONGS);
    const [localPlaylists, setLocalPlaylists] = useState<LocalPlaylist[]>(sandbox ? [] : [IN_MEMORY_LOCAL_PLAYLIST]);
    const [playlists, setPlaylists] = useState<ProviderCollection[]>([]);
    const liveCatalog = useLocalLibraryCatalog(sandbox ? localSongs : null);
    const localLibraryCatalog = sandbox ? liveCatalog : STATIC_CATALOG;

    // 假 provider、Navidrome 垫片和种子数据都在挂载时装、卸载时拆：gallery 会 eager import 全部探针，
    // 模块顶层的副作用会污染别的探针。
    useEffect(() => {
        registerFakeProviders();
        resetFakeProviders();
        setPlaylists(buildPlaylistList());
        const previousProviderId = useOnlineProviderAccountStore.getState().activeProviderId;
        // 直接 setState，不走 setActiveProviderId：后者会写 localStorage，手动打开探针会改掉开发者自己的选择。
        useOnlineProviderAccountStore.setState({ activeProviderId: PROBE_PROVIDER_A });
        useCollectionNavigationStore.getState().clear();

        let cancelled = false;
        let uninstallShim: (() => void) | undefined;
        const previousNavidromeConfig = localStorage.getItem(NAVIDROME_CONFIG_KEY);
        if (sandbox) {
            localStorage.setItem(NAVIDROME_CONFIG_KEY, JSON.stringify(NAVIDROME_PROBE_CONFIG));
            uninstallShim = installNavidromeShim();
            void seedLocalLibrary().then(({ songs, playlists: seededPlaylists }) => {
                if (cancelled) return;
                setLocalSongs(songs);
                setLocalPlaylists(seededPlaylists);
                setReady(true);
            });
        } else {
            setReady(true);
        }

        return () => {
            cancelled = true;
            uninstallShim?.();
            if (sandbox) {
                if (previousNavidromeConfig === null) localStorage.removeItem(NAVIDROME_CONFIG_KEY);
                else localStorage.setItem(NAVIDROME_CONFIG_KEY, previousNavidromeConfig);
            }
            useCollectionNavigationStore.getState().clear();
            useOnlineProviderAccountStore.setState({ activeProviderId: previousProviderId });
            unregisterOnlineMusicProvider(PROBE_PROVIDER_A);
            unregisterOnlineMusicProvider(PROBE_PROVIDER_B);
        };
    }, [sandbox]);

    const refreshLocal = useCallback(async () => {
        recordProbeCall({ kind: 'refreshLocalSongs', ids: [] });
        if (!sandbox) return;
        const { songs, playlists: storedPlaylists } = await readLocalLibrary();
        setLocalSongs(songs);
        setLocalPlaylists(storedPlaylists);
    }, [sandbox]);

    const surfaceProps = useMemo<HomeSurfaceProps>(() => ({
        onPlaySong: (song, queue) => recordProbeCall({ kind: 'playSong', ids: songKeys([song]), queueIds: songKeys(queue) }),
        onPlayAll: songs => recordProbeCall({ kind: 'playAll', ids: songKeys(songs) }),
        onAddAllToQueue: songs => {
            recordProbeCall({ kind: 'addAllToQueue', ids: songKeys(songs) });
            return songs.length;
        },
        onAddSongToQueue: song => recordProbeCall({ kind: 'addSongToQueue', ids: songKeys([song]) }),
        onAddLocalSongToQueue: (song: LocalSong) => recordProbeCall({ kind: 'addLocalSongToQueue', ids: [song.id] }),
        onAddNavidromeSongsToQueue: (songs: NavidromeSong[]) => recordProbeCall({
            kind: 'addNavidromeSongsToQueue',
            ids: songs.map(song => song.navidromeData?.id ?? String(song.id)),
        }),
        onRefreshUser: () => {
            recordProbeCall({ kind: 'refreshUser', ids: [] });
            setPlaylists(buildPlaylistList());
        },
        onRefreshLocalSongs: refreshLocal,
        onStatusMessage: message => recordProbeCall({ kind: 'statusMessage', ids: [], text: message.text }),
        onBackToPlayer: () => {},
        user: { id: 'probe-user', nickname: 'Probe User' },
        playlists,
        localSongs,
        localLibraryCatalog,
        localPlaylists,
        localMusicState: {
            activeRow: 0,
            selectedGroup: null,
            detailStack: [],
            detailOriginView: null,
            focusedFolderIndex: 0,
            focusedAlbumIndex: 0,
            focusedArtistIndex: 0,
            focusedPlaylistIndex: 0,
        },
        setLocalMusicState: () => {},
        onSearchCommitted: () => {},
        theme: DEFAULT_THEME,
    }), [localLibraryCatalog, localPlaylists, localSongs, playlists, refreshLocal]);

    const onOpenCollection = useCallback((collection: GridViewCollectionDescriptor) => {
        useCollectionNavigationStore.getState().openRoot(collection, 'home');
    }, []);
    const onPushCollection = useCallback((collection: GridViewCollectionDescriptor) => {
        useCollectionNavigationStore.getState().push(collection);
    }, []);

    // 把 fixture id 换成首页同款的集合描述：在线走 createOnlineGridViewCollection，本地走 Grid3D 的分组。
    const resolveFixture = useCallback((fixtureId: ProbeFixtureId): GridViewCollectionDescriptor | null => {
        if (fixtureId in ONLINE_FIXTURES) {
            const id = fixtureId as OnlineFixtureId;
            return createOnlineGridViewCollection(describeOnlineFixture(id), ONLINE_FIXTURES[id].providerId);
        }
        if (fixtureId === 'navi-album') {
            return createNavidromeGridViewCollection({ id: NAVIDROME_ALBUM_ID, name: 'Navi Album', trackCount: NAVIDROME_ALBUM_SONGS.length }, 'album');
        }
        if (fixtureId === 'navi-playlist') {
            return createNavidromeGridViewCollection({
                id: NAVIDROME_PLAYLIST_ID,
                name: 'Navi Playlist',
                trackCount: NAVIDROME_PLAYLIST_SONGS.length,
                editable: true,
            } as Parameters<typeof createNavidromeGridViewCollection>[0], 'playlist');
        }
        const groups = buildLocalGrid3DGroups(localSongs, localPlaylists, t, localLibraryCatalog.ready ? localLibraryCatalog : undefined);
        const group = fixtureId === 'local-all'
            ? groups.folders.find(candidate => candidate.isVirtual)
            : fixtureId === 'local-folder'
                ? groups.folders.find(candidate => candidate.id === 'folder-Folder A')
                : fixtureId === 'local-playlist'
                    ? groups.playlists.find(candidate => candidate.name === LOCAL_PLAYLIST_NAME)
                    : groups.albums.find(candidate => candidate.name === 'Alpha Album' && candidate.entityId);
        return group ? createLocalGridViewCollection(group) : null;
    }, [localLibraryCatalog, localPlaylists, localSongs, t]);

    const open = useCallback((fixtureId: ProbeFixtureId) => {
        if (SANDBOX_ONLY.has(fixtureId) && !sandbox) {
            console.warn(`[libraryBehavior] ${fixtureId} needs sandbox mode (?probe=libraryBehavior&sandbox)`);
            return;
        }
        const collection = resolveFixture(fixtureId);
        if (!collection) {
            console.warn(`[libraryBehavior] fixture ${fixtureId} is not available yet`);
            return;
        }
        onOpenCollection(collection);
    }, [onOpenCollection, resolveFixture, sandbox]);

    const latestRef = useRef({ open, ready });
    latestRef.current = { open, ready };
    useEffect(() => installLibraryProbeApi({
        sandbox,
        fixtures: () => ALL_FIXTURES,
        ready: () => latestRef.current.ready,
        open: fixtureId => latestRef.current.open(fixtureId),
        back: popNavigation,
    }), [sandbox]);

    return {
        sandbox,
        ready,
        fixtures: ALL_FIXTURES,
        surfaceProps,
        open,
        back: popNavigation,
        onOpenCollection,
        onPushCollection,
    };
};

export { popNavigation as onProbeBackCollection };
