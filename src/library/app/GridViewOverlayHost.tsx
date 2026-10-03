import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
    getActiveGridViewCollection,
    subscribeCollectionPop,
    useCollectionNavigationStore,
    type CollectionNavigationSnapshot,
} from '../../stores/useCollectionNavigationStore';
import { LocalSong, SongResult, UnifiedSong } from '../../types';
import { getNavidromeConfig, navidromeApi } from '../../services/navidromeService';
import { getLocalCoverAssetUrl } from '../../services/localCoverAssetUrl';
import {
    collectionKey,
    GridViewCollectionDescriptor,
    LocalGridViewCollectionDescriptor,
    isLocalGridViewCollection,
    isNavidromeGridViewCollection,
    refreshLocalGridViewCollection,
    resolveLocalAlbumArtistDisplay,
    resolveLocalGridViewTracks,
} from '../../components/app/home/gridViewCollectionAdapters';
import { createLibraryPlaybackPort } from './createLibraryPlaybackPort';
import { createLibraryMutationPort } from './createLibraryMutationPort';
import { useCollectionResource } from '../core/bindings/useCollectionResource';
import { useCollectionMutations } from '../core/bindings/useCollectionMutations';
import { useArtistResource } from '../core/bindings/useArtistResource';
import type { LocalLibraryCatalogSnapshot } from '../../hooks/useLocalLibraryCatalog';
import { LocalLibraryEntityPanel } from '../../components/modal/LocalLibraryEntityPanel';
import { LocalFolderSongInfoPanel } from '../../components/modal/LocalFolderSongInfoPanel';
import { LocalSongMetadataMatchDialog } from '../../components/modal/LocalSongMetadataMatchDialog';
import { followEntityRedirect } from '../../utils/localLibraryIndex';
import { buildLocalCatalogIndex, resolveLocalCatalogLink } from '../core/model/localCatalogLinks';
import { resolveSongCatalogRef } from '../../services/onlineMusic/catalogRefs';
import type { HomeSurfaceProps } from '../../components/app/home/homeSurfaceTypes';
import { useThemeSettingsStore } from '../../stores/useThemeSettingsStore';
import { countRender } from '../../dev/renderCount';
import { useReducedMotionFor } from '../../hooks/useReducedMotionFor';
import { useLibrarySuiteStore } from '../core/state/useLibrarySuiteStore';
import { useLibraryBrowseSessionStore } from '../core/state/useLibraryBrowseSessionStore';
import type { LibraryNavigationContext, LibrarySurfaceId } from '../core/contracts/suite';
import { forgetLibraryLayouts, listLibrarySuiteOverlays, listLibrarySuites, resolveLibrarySurface } from '../registry';

// src/library/app/GridViewOverlayHost.tsx
// Hosts the GridView overlay outside Grid3D so it can be opened/restored independently.
// R3 起集合层与歌手页经 registry 解析：当前选中的 suite 实现了就由它渲染，否则回退默认 suite（grid）。
// 宿主只交出契约里的输入（core/contracts/suite）；网格专属的转场（移形换影的入场计划、返回时的测量、
// 常驻的转场层）由网格 entry 的 transitions 提供，宿主不再直接 import 任何 suite。
//
// 返回的语义（P4.5，同一个手势在每套 suite 里含义相同）：
// - 返回按钮 = 完成（onDone）：清掉这一层的浏览会话，让每套 suite 忘掉这一层的布局记录，再返回；
// - Escape 与浏览器后退 = 离开但保留（onBack / popstate）。
// 两条返回路径都只让渲染这一层的 suite 跑一次 beforeBack：应用内返回在这里先跑，再走历史后退；浏览器后退
// 不经过这里，由导航 store 在 popstate 弹栈之前通知（subscribeCollectionPop），界面那时还是返回前的样子。

// suite 的切换浮层：懒加载、且只在 DEV 下引用，生产包不受影响（生产构建里也只有一套 suite）。
const DevLibraryRendererSwitch = import.meta.env.DEV ? React.lazy(() => import('./DevLibraryRendererSwitch')) : null;
const HAS_SUITE_CHOICE = listLibrarySuites().length > 1;
/** 在首页上切 suite 时交给 switchLibrarySuite 的会话 key（首页没有集合浏览会话，冲刷什么都不做）。 */
const HOME_SUITE_SESSION_KEY = 'home';
// 声明了转场层的 suite：常驻渲染，只有当前负责集合层的那套收到 enabled。
const SUITE_OVERLAYS = listLibrarySuiteOverlays();

/** 导航发生之前的栈状态，交给 suite 的转场钩子。 */
const readNavigationContext = (): LibraryNavigationContext => {
    const snapshot = useCollectionNavigationStore.getState().snapshot;
    const depth = snapshot?.stack.length ?? 0;
    return {
        depth,
        origin: snapshot?.origin ?? null,
        activeType: snapshot?.stack[depth - 1]?.type ?? null,
    };
};

type GridViewOverlayHostProps = {
    surfaceProps: HomeSurfaceProps;
    onOpenCollection: (collection: GridViewCollectionDescriptor) => void;
    onPushCollection: (collection: GridViewCollectionDescriptor) => void;
    onBackCollection: () => void;
    isInteractive?: boolean;
    children: (
        openGridView: (collection: GridViewCollectionDescriptor) => void,
        isHomeGridInteractive: boolean,
    ) => React.ReactNode;
};

const getPersistentCoverUrl = (url?: string) => (
    url && !url.startsWith('blob:') ? url : undefined
);

const resolveLocalCollectionCoverUrlFromTracks = (
    tracks: UnifiedSong[],
    localSongs: LocalSong[],
): string | undefined => {
    const songsById = new Map(localSongs.map(song => [song.id, song]));
    const songs = tracks
        .map(track => track.localRef ? songsById.get(track.localRef.songId) : undefined)
        .filter((song): song is LocalSong => Boolean(song))
        .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    const preferredSong = songs.find(song => {
        const hasEmbeddedCover = Boolean(getLocalCoverAssetUrl(song.localCoverAssetId));
        if (song.useOnlineCover) {
            return song.onlineMetadata?.coverUrl || hasEmbeddedCover;
        }
        return hasEmbeddedCover || song.onlineMetadata?.coverUrl;
    });

    if (!preferredSong) {
        return undefined;
    }

    if (preferredSong.useOnlineCover && preferredSong.onlineMetadata?.coverUrl) {
        return preferredSong.onlineMetadata.coverUrl;
    }

    const localCoverUrl = getLocalCoverAssetUrl(preferredSong.localCoverAssetId, 512);
    if (localCoverUrl) return localCoverUrl;

    return preferredSong.onlineMetadata?.coverUrl;
};

const resolveLiveLocalCollection = (
    collection: LocalGridViewCollectionDescriptor,
    surfaceProps: HomeSurfaceProps,
    catalog: LocalLibraryCatalogSnapshot,
): LocalGridViewCollectionDescriptor | null => {
    if (!collection.playlistId) {
        return refreshLocalGridViewCollection(
            collection,
            surfaceProps.localSongs,
            catalog.ready ? catalog : undefined,
        );
    }

    const playlist = surfaceProps.localPlaylists.find(item => item.id === collection.playlistId);
    if (!playlist) {
        return null;
    }

    const validSongIds = new Set(surfaceProps.localSongs.map(song => song.id));
    const songIds = playlist.songIds.filter(songId => validSongIds.has(songId));

    return {
        ...collection,
        name: playlist.name,
        songIds,
        trackCount: songIds.length,
        isVirtual: playlist.isFavorite,
    };
};

const GridViewOverlayHost: React.FC<GridViewOverlayHostProps> = ({
    surfaceProps,
    onOpenCollection,
    onPushCollection,
    onBackCollection,
    isInteractive = true,
    children,
}) => {
    countRender('GridViewOverlayHost');
    const { t } = useTranslation();
    const collectionSnapshot = useCollectionNavigationStore(state => state.snapshot);
    const isDaylight = useThemeSettingsStore(state => state.isDaylight);
    const localLibraryCatalog = surfaceProps.localLibraryCatalog;
    const selectedCollection = getActiveGridViewCollection(collectionSnapshot);
    const suiteId = useLibrarySuiteStore(state => state.suite);
    // 集合层与歌手页都由选中的 suite 渲染（它没实现那个 surface 时回退网格；P4.3 起 TUI 也实现了歌手页）。
    const collectionSurface = resolveLibrarySurface('collection', suiteId);
    const artistSurface = resolveLibrarySurface('artist', suiteId);
    // 转场属于渲染集合层的那套 suite：已经打开的看它所在的 surface；还在首页时看「将要打开的集合」由谁渲染
    // （选中 TUI 时，首页卡片点开的集合是 TUI，不该起飞移形换影）。
    const transitionSurface: LibrarySurfaceId = selectedCollection?.type === 'artist' ? 'artist' : 'collection';
    const transitionOwner = transitionSurface === 'artist' ? artistSurface : collectionSurface;
    // 「降低动态效果」的这一面。关掉之后转场完全不出现（不藏 hero、不飞卡片、背景板按原来的
    // 0.18s 淡入），而不是缩短成一次更快的飞行 —— 转场是纯装饰，降级就该是原来的行为。
    // 移形换影也只属于网格：TUI 没有卡片可飞，开着只会让首页那张卡的残影盖在列表上。
    // （网格以外的 suite 不声明 transitions，于是它渲染集合层时转场关闭。）
    const morphEnabled = !useReducedMotionFor('collectionMorph') && Boolean(transitionOwner.transitions);
    const activeTransitions = morphEnabled ? transitionOwner.transitions : undefined;
    const [resolvedLocalCollectionCoverUrl, setResolvedLocalCollectionCoverUrl] = useState<string | undefined>(undefined);
    const [navidromePlaylistItems, setNavidromePlaylistItems] = useState<Array<{ id: string | number; name: string; description?: string; }>>([]);
    const [editingEntityId, setEditingEntityId] = useState<string | null>(null);
    const [organizingFolder, setOrganizingFolder] = useState<LocalGridViewCollectionDescriptor | null>(null);
    const [matchingSongId, setMatchingSongId] = useState<string | null>(null);
    const selectedCollectionKey = collectionKey(selectedCollection);
    const refreshedSelectedCollection = useMemo(() => {
        if (!selectedCollection || !isLocalGridViewCollection(selectedCollection)) {
            if (selectedCollection?.source !== 'online') return selectedCollection;

            const refreshed = surfaceProps.playlists.find(collection => (
                collection.providerId === selectedCollection.providerId
                && String(collection.id) === String(selectedCollection.id)
            ));
            return refreshed
                ? { ...selectedCollection, ...refreshed, source: 'online' as const, providerId: selectedCollection.providerId }
                : selectedCollection;
        }

        return resolveLiveLocalCollection(selectedCollection, surfaceProps, localLibraryCatalog);
    }, [surfaceProps.localPlaylists, surfaceProps.localSongs, surfaceProps.playlists, localLibraryCatalog, selectedCollection]);
    // Navidrome 歌单的名字以刷新过的歌单列表为准：改名之后 refreshNavidromePlaylists 带回新名字，
    // 不必就地改写导航栈里的描述（嵌套返回再进来也还是新名字）。单独一层 memo：别的来源不随歌单列表换新对象
    // （本地集合的 effect 会清空这个列表，放进同一个 memo 会互相触发）。
    const liveSelectedCollection = useMemo(() => {
        const collection = refreshedSelectedCollection;
        if (collection?.source !== 'navidrome' || collection.type !== 'playlist') return collection;
        const listed = navidromePlaylistItems.find(item => String(item.id) === String(collection.id));
        return listed && listed.name !== collection.name ? { ...collection, name: listed.name } : collection;
    }, [navidromePlaylistItems, refreshedSelectedCollection]);
    const displaySelectedCollection = useMemo(() => {
        if (!liveSelectedCollection) {
            return null;
        }

        if (!isLocalGridViewCollection(liveSelectedCollection)) {
            return liveSelectedCollection;
        }

        const coverUrl = resolvedLocalCollectionCoverUrl
            || getPersistentCoverUrl(liveSelectedCollection.coverUrl);

        return {
            ...liveSelectedCollection,
            coverUrl,
        };
    }, [liveSelectedCollection, resolvedLocalCollectionCoverUrl]);

    // 本地集合的曲目在渲染期算好：放在 effect 里的话，新打开的网格第一帧会带着上一个集合的曲目。
    const localTracks = useMemo(() => (
        liveSelectedCollection && isLocalGridViewCollection(liveSelectedCollection)
            ? resolveLocalGridViewTracks(liveSelectedCollection, surfaceProps.localSongs, localLibraryCatalog) as UnifiedSong[]
            : undefined
    ), [liveSelectedCollection, localLibraryCatalog, surfaceProps.localSongs]);
    // 宿主持有集合资源，网格（以及别的 renderer）只订阅它：切换 renderer 不会重新请求。
    // 宿主自己不订阅快照，所以分页到达不会让首页这棵大树重渲染。歌手页同理，见下面的 artistResource。
    const collectionResource = useCollectionResource({
        descriptor: liveSelectedCollection && liveSelectedCollection.type !== 'artist' ? liveSelectedCollection : null,
        currentUserId: surfaceProps.user?.id,
        localTracks,
    });
    // 歌手资源：宿主按导航栈里那一层的 collectionKey 持有（本地描述的 id 会在 catalog 就绪后改写，不拿它算 key），
    // 本地歌手由宿主这一份 catalog 派生（歌手页不再自带第二个 catalog 实例）。宿主同样不订阅它的快照。
    const artistLocalLibrary = useMemo(() => ({
        catalog: localLibraryCatalog,
        songs: surfaceProps.localSongs,
    }), [localLibraryCatalog, surfaceProps.localSongs]);
    const isArtistSelected = selectedCollection?.type === 'artist';
    const artistResource = useArtistResource({
        key: isArtistSelected ? selectedCollectionKey : null,
        descriptor: isArtistSelected ? liveSelectedCollection : null,
        local: artistLocalLibrary,
    });
    // 播放与入队的语义集中在端口里，网格与别的 renderer 共用。
    const playbackPort = useMemo(() => createLibraryPlaybackPort(surfaceProps), [surfaceProps]);

    const openGridView = useCallback((collection: GridViewCollectionDescriptor) => {
        onOpenCollection(collection);
    }, [onOpenCollection]);

    // 压栈 / 返回之前先让负责集合层的 suite 安排转场（网格：级联入场计划、反向移形换影，原先写在这里的
    // 两段逻辑原样搬进了 suites/grid/transitions/gridHostTransitions）。
    const handlePushCollection = useCallback((col: GridViewCollectionDescriptor) => {
        activeTransitions?.beforePush?.(readNavigationContext());
        onPushCollection(col);
    }, [activeTransitions, onPushCollection]);

    // 应用内返回已经跑过 beforeBack 的那次弹栈（弹栈前的快照）：随后 history.back() 的 popstate 再通知时认出它、不重跑。
    // 快照每次导航都是新对象，按引用比较；没等来通知（例如返回被忽略）也无妨，下一次弹栈的快照不会是它。
    const armedBackRef = useRef<CollectionNavigationSnapshot | null>(null);
    const handleBackCollection = useCallback(() => {
        activeTransitions?.beforeBack?.(readNavigationContext());
        armedBackRef.current = useCollectionNavigationStore.getState().snapshot;
        onBackCollection();
    }, [activeTransitions, onBackCollection]);

    // 浏览器后退（popstate 直接恢复历史里的栈，不经过上面的 handleBackCollection）：在 store 变化之前跑同一个
    // beforeBack，网格的反向移形换影与卡片散开和应用内返回一样出现。
    const activeTransitionsRef = useRef(activeTransitions);
    activeTransitionsRef.current = activeTransitions;
    useEffect(() => subscribeCollectionPop((from) => {
        const armed = armedBackRef.current;
        armedBackRef.current = null;
        if (armed === from) return;
        activeTransitionsRef.current?.beforeBack?.(readNavigationContext());
    }), []);

    useEffect(() => {
        if (
            localLibraryCatalog.ready &&
            selectedCollection &&
            isLocalGridViewCollection(selectedCollection) &&
            selectedCollection.entityId &&
            liveSelectedCollection &&
            isLocalGridViewCollection(liveSelectedCollection) &&
            liveSelectedCollection.trackCount === 0
        ) {
            handleBackCollection();
        }
    }, [handleBackCollection, liveSelectedCollection, localLibraryCatalog.ready, selectedCollection]);

    const showCatalogUnavailable = useCallback(() => {
        surfaceProps.onStatusMessage?.({ type: 'error', text: t('search.catalogUnavailable') });
    }, [surfaceProps, t]);

    const handlePushAlbumCollection = useCallback(async (
        albumId: number | string,
        album?: any,
        track?: SongResult,
    ) => {
        if (!selectedCollection) return;

        const source = selectedCollection.source;
        const albumName = album?.name || '';
        const albumCoverUrl = album?.coverUrl;
        // 点的是当前正在看的这张专辑时直接返回：不必再去解析 catalog（在线路径会发请求，
        // 解析失败还会弹「目录不可用」，而用户只是点了自己在看的那张专辑）。解析之后再比一次
        // 由 store 的 push 兜底 —— 那条才是所有分支都绕不过的不变式。
        if (selectedCollection.type === 'album' && String(selectedCollection.id) === String(albumId)) {
            return;
        }
        if (source === 'online') {
            let resolvedAlbumId = albumId;
            if (track) {
                try {
                    const ref = await resolveSongCatalogRef(track as UnifiedSong, 'album', {
                        id: albumId,
                        name: albumName,
                        coverUrl: albumCoverUrl,
                        catalogRef: album?.catalogRef,
                    });
                    if (!ref) {
                        showCatalogUnavailable();
                        return;
                    }
                    resolvedAlbumId = ref.id;
                } catch (error) {
                    console.warn('[CatalogNavigation] Failed to resolve nested album:', error);
                    showCatalogUnavailable();
                    return;
                }
            }
            handlePushCollection({
                ...(album && typeof album === 'object' ? album : {}),
                source: 'online',
                providerId: selectedCollection.providerId,
                id: resolvedAlbumId,
                name: albumName,
                type: 'album',
                coverUrl: albumCoverUrl,
            });
        } else if (source === 'navidrome') {
            handlePushCollection({
                source: 'navidrome',
                id: String(albumId),
                name: albumName,
                type: 'album',
                coverUrl: albumCoverUrl,
            });
        } else if (source === 'local') {
            const catalogIndex = buildLocalCatalogIndex(localLibraryCatalog);
            const link = resolveLocalCatalogLink(localLibraryCatalog, surfaceProps.localSongs, {
                kind: 'album',
                entityId: String(albumId),
                name: album?.name,
            }, catalogIndex);
            if (!link) return;
            const localAlbumEntity = link.entity;
            const selectedAlbumSourceId = selectedCollection.entityId
                || (selectedCollection.type === 'album' ? String(selectedCollection.id) : undefined);
            const selectedAlbumEntityId = selectedAlbumSourceId
                ? followEntityRedirect(selectedAlbumSourceId, catalogIndex.entitiesById)
                : undefined;
            if (selectedCollection.type === 'album' && selectedAlbumEntityId === localAlbumEntity.id) {
                return;
            }
            const localAlbumName = localAlbumEntity.displayName;
            const localCoverUrl = albumCoverUrl;
            const albumSongs = link.songs;
            const albumArtist = resolveLocalAlbumArtistDisplay(
                albumSongs.map(song => song.id),
                localLibraryCatalog,
            );
            handlePushCollection({
                source: 'local',
                id: localAlbumEntity.id,
                entityId: localAlbumEntity.id,
                name: localAlbumName,
                type: 'album',
                coverUrl: localCoverUrl,
                description: albumArtist,
                albumArtist,
                songIds: albumSongs.map(song => song.id),
            });
        }
    }, [handlePushCollection, surfaceProps.localSongs, localLibraryCatalog, selectedCollection, showCatalogUnavailable]);

    const handlePushArtistCollection = useCallback(async (
        artistId: number | string,
        artist?: any,
        track?: SongResult,
    ) => {
        if (!selectedCollection) return;

        const source = selectedCollection.source;
        const artistName = artist?.name || String(artistId);
        // 同上：歌手页的曲目卡片带着同一张歌手的入口，点它不该再压一层同样的歌手页。
        if (selectedCollection.type === 'artist' && String(selectedCollection.id) === String(artistId)) {
            return;
        }
        if (source === 'online') {
            let resolvedArtistId = artistId;
            if (track) {
                try {
                    const ref = await resolveSongCatalogRef(track as UnifiedSong, 'artist', {
                        id: artistId,
                        name: artistName,
                        catalogRef: artist?.catalogRef,
                    });
                    if (!ref) {
                        showCatalogUnavailable();
                        return;
                    }
                    resolvedArtistId = ref.id;
                } catch (error) {
                    console.warn('[CatalogNavigation] Failed to resolve nested artist:', error);
                    showCatalogUnavailable();
                    return;
                }
            }
            handlePushCollection({
                source: 'online',
                providerId: selectedCollection.providerId,
                id: resolvedArtistId,
                name: artistName,
                type: 'artist',
            });
            return;
        }
        if (source === 'navidrome') {
            handlePushCollection({
                source: 'navidrome',
                id: String(artistId),
                name: artistName,
                type: 'artist',
            });
            return;
        }

        const link = resolveLocalCatalogLink(localLibraryCatalog, surfaceProps.localSongs, {
            kind: 'artist',
            entityId: String(artistId),
            name: artistName,
        });
        if (!link) return;
        const artistEntity = link.entity;
        const artistSongs = link.songs;
        handlePushCollection({
            source: 'local',
            id: artistEntity.id,
            entityId: artistEntity.id,
            name: artistEntity.displayName,
            type: 'artist',
            songIds: artistSongs.map(song => song.id),
        });
    }, [handlePushCollection, surfaceProps.localSongs, localLibraryCatalog, selectedCollection, showCatalogUnavailable]);

    useEffect(() => {
        if (!selectedCollection || !isLocalGridViewCollection(selectedCollection)) {
            setResolvedLocalCollectionCoverUrl(undefined);
        }
        if (!selectedCollection || selectedCollection.source === 'online') {
            setNavidromePlaylistItems([]);
        }
    }, [selectedCollectionKey]);

    useEffect(() => {
        if (!selectedCollection || !isLocalGridViewCollection(selectedCollection)) {
            return;
        }

        if (!liveSelectedCollection || !isLocalGridViewCollection(liveSelectedCollection)) {
            handleBackCollection();
            return;
        }

        const resolvedTracks = localTracks ?? [];
        if (liveSelectedCollection.songIds.length > 0 && resolvedTracks.length === 0) {
            handleBackCollection();
            return;
        }

        setNavidromePlaylistItems([]);
        setResolvedLocalCollectionCoverUrl(resolveLocalCollectionCoverUrlFromTracks(
            resolvedTracks,
            surfaceProps.localSongs,
        ));
    }, [
        handleBackCollection,
        surfaceProps.localSongs,
        liveSelectedCollection,
        localTracks,
        selectedCollection,
    ]);

    const refreshNavidromePlaylists = useCallback(async () => {
        const config = getNavidromeConfig();
        if (!config) {
            setNavidromePlaylistItems([]);
            return;
        }

        const playlists = await navidromeApi.getPlaylists(config);
        setNavidromePlaylistItems(playlists.map(playlist => ({
            id: playlist.id,
            name: playlist.name,
            description: playlist.owner,
        })));
    }, []);

    useEffect(() => {
        if (selectedCollection && isNavidromeGridViewCollection(selectedCollection)) {
            void refreshNavidromePlaylists();
        }
    }, [refreshNavidromePlaylists, selectedCollection]);


    // 「完成」（任意 suite 的返回按钮）：清掉这一层的浏览会话，让每套 suite 忘掉这一层的布局记录，再返回。
    // 键与 suite 用的会话键一致：歌手页是导航栈那一层的 collectionKey（= 歌手资源的 key），集合是显示用描述的
    // collectionKey（本地集合在 catalog 就绪后可能换 id，两个都清）。先清再返回：正在离开的 TUI 卸载时想写回焦点，
    // 会被会话的「代」挡住（core/state/useLibraryBrowseSessionStore）。
    const handleDoneCollection = useCallback(() => {
        const keys = new Set([selectedCollectionKey, collectionKey(displaySelectedCollection)].filter(Boolean));
        const sessions = useLibraryBrowseSessionStore.getState();
        keys.forEach(key => {
            forgetLibraryLayouts(key);
            sessions.clearSession(key);
        });
        handleBackCollection();
    }, [displaySelectedCollection, handleBackCollection, selectedCollectionKey]);

    // 来源动作（本地曲库、Navidrome、对话框、账户刷新）集中在变更端口里，只交给变更控制器；
    // suite 不直接拿端口，所有变更都经控制器（能力判定、进行中标记与重复提交保护在那里）。
    const mutationPort = useMemo(() => createLibraryMutationPort({
        surface: surfaceProps,
        t,
        dialogs: {
            editEntity: setEditingEntityId,
            organizeFolder: setOrganizingFolder,
            matchSong: setMatchingSongId,
        },
        navidromePlaylists: navidromePlaylistItems,
        refreshNavidromePlaylists,
    }), [surfaceProps, t, navidromePlaylistItems, refreshNavidromePlaylists]);
    // 变更动作控制器：宿主按集合会话创建与释放，自己不订阅快照（不会因进行中的状态重渲染首页）。
    // 交给集合 surface：网格与 TUI 都订阅它（换 suite 不重建，订阅状态、进行中的删除都留在这里）。
    const collectionMutations = useCollectionMutations({
        descriptor: liveSelectedCollection && liveSelectedCollection.type !== 'artist' ? liveSelectedCollection : null,
        resource: collectionResource,
        port: mutationPort,
        currentUserId: surfaceProps.user?.id,
    });
    const CollectionSurface = collectionSurface.component;
    const ArtistSurface = artistSurface.component;

    const editingEntity = editingEntityId
        ? localLibraryCatalog.entities.find(entity => entity.id === editingEntityId)
        : undefined;
    const editingEntityMemberIds = new Set(localLibraryCatalog.assignments
        .filter(assignment => editingEntity?.kind === 'artist'
            ? assignment.artistEntityIds.includes(editingEntity.id)
            : assignment.albumEntityId === editingEntity?.id)
        .map(assignment => assignment.songId));
    const editingEntitySongs = surfaceProps.localSongs.filter(song => editingEntityMemberIds.has(song.id));
    const organizingFolderSongs = organizingFolder
        ? organizingFolder.songIds
            .map(songId => surfaceProps.localSongs.find(song => song.id === songId))
            .filter((song): song is LocalSong => Boolean(song))
        : [];
    const matchingSong = matchingSongId
        ? surfaceProps.localSongs.find(song => song.id === matchingSongId)
        : undefined;
    const matchingSongAssignment = matchingSongId
        ? localLibraryCatalog.assignments.find(assignment => assignment.songId === matchingSongId)
        : undefined;

    return (
        <>
            <div
                className="absolute inset-0"
                aria-hidden={Boolean(selectedCollection)}
                style={{
                    visibility: selectedCollection ? 'hidden' : 'visible',
                    pointerEvents: selectedCollection ? 'none' : 'auto',
                }}
            >
                {children(openGridView, isInteractive && !selectedCollection)}
            </div>
            <AnimatePresence initial={false}>
                {selectedCollection && (
                    <motion.div
                        key="grid-transition-backdrop"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        // 时长只在降级时回到官方原版的 0.18s：移形换影关闭后不该还留着
                        // 一段为飞行准备的慢淡入。开着的时候维持作者调的 0.62s / 0.28s。
                        exit={morphEnabled
                            ? { opacity: 0, transition: { duration: 0.28, ease: [0.4, 0, 0.2, 1] } }
                            : { opacity: 0 }}
                        transition={morphEnabled
                            ? { duration: 0.62, ease: [0.22, 1, 0.36, 1] }
                            : { duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                        className="fixed inset-0 z-[49] pointer-events-none"
                        style={{ backgroundColor: 'var(--bg-color)' }}
                    />
                )}
            </AnimatePresence>
            {SUITE_OVERLAYS.map(({ suiteId: overlaySuiteId, Overlay }) => (
                <Overlay key={overlaySuiteId} enabled={morphEnabled && transitionOwner.suiteId === overlaySuiteId} />
            ))}
            <AnimatePresence initial={false}>
                {displaySelectedCollection && (
                    // key 带上实际渲染它的 suite：切换 suite 时集合层换一个实例；两个都回退到网格的 suite 之间
                    // 切换（例如歌手页）不重新挂载。Suspense 给 lazy 的 suite 组件用，即时组件不会挂起。
                    displaySelectedCollection.type === 'artist' ? (
                        <React.Suspense key={`${artistSurface.suiteId}:${selectedCollectionKey}`} fallback={null}>
                            <ArtistSurface
                                collection={displaySelectedCollection}
                                resource={artistResource}
                                playback={playbackPort}
                                theme={surfaceProps.theme}
                                isDaylight={isDaylight}
                                isInteractive={isInteractive}
                                onEditEntity={setEditingEntityId}
                                declaredActions={artistSurface.declaredActions}
                                onBack={handleBackCollection}
                                onDone={handleDoneCollection}
                                onOpenAlbum={handlePushAlbumCollection}
                                onOpenArtist={handlePushArtistCollection}
                            />
                        </React.Suspense>
                    ) : (
                        <React.Suspense key={`${collectionSurface.suiteId}:${selectedCollectionKey}`} fallback={null}>
                            <CollectionSurface
                                collection={displaySelectedCollection}
                                resource={collectionResource}
                                playback={playbackPort}
                                mutations={collectionMutations}
                                localSongs={surfaceProps.localSongs}
                                theme={surfaceProps.theme}
                                isDaylight={isDaylight}
                                isInteractive={isInteractive}
                                onStatusMessage={surfaceProps.onStatusMessage}
                                currentUserId={surfaceProps.user?.id}
                                declaredActions={collectionSurface.declaredActions}
                                onBack={handleBackCollection}
                                onDone={handleDoneCollection}
                                onOpenAlbum={handlePushAlbumCollection}
                                onOpenArtist={handlePushArtistCollection}
                            />
                        </React.Suspense>
                    )
                )}
            </AnimatePresence>
            {/* 首页上也有（切换的是首页 surface；没有集合会话要冲刷，用首页的固定 key）；歌手页上也有（P4.3 起 TUI 实现了歌手页，
                冲刷的是这一层歌手页的会话——键与歌手资源的 key 相同）。 */}
            {DevLibraryRendererSwitch && HAS_SUITE_CHOICE && (isInteractive || displaySelectedCollection) && (
                <React.Suspense fallback={null}>
                    <DevLibraryRendererSwitch
                        sessionKey={displaySelectedCollection ? selectedCollectionKey : HOME_SUITE_SESSION_KEY}
                        placement={displaySelectedCollection ? (displaySelectedCollection.type === 'artist' ? 'artist' : 'collection') : 'home'}
                    />
                </React.Suspense>
            )}
            {editingEntity && (
                <LocalLibraryEntityPanel
                    entity={editingEntity}
                    sameKindEntities={localLibraryCatalog.entities.filter(entity => entity.kind === editingEntity.kind)}
                    memberSongs={editingEntitySongs}
                    isDaylight={isDaylight}
                    onClose={() => setEditingEntityId(null)}
                    onChanged={async () => {
                        await localLibraryCatalog.reload();
                        await surfaceProps.onRefreshLocalSongs();
                    }}
                />
            )}
            {organizingFolder && (
                <LocalFolderSongInfoPanel
                    folderName={organizingFolder.name}
                    songs={organizingFolderSongs}
                    assignments={localLibraryCatalog.assignments}
                    isDaylight={isDaylight}
                    onClose={() => setOrganizingFolder(null)}
                    onChanged={async () => {
                        await localLibraryCatalog.reload();
                        await surfaceProps.onRefreshLocalSongs();
                    }}
                />
            )}
            {matchingSong && (
                <LocalSongMetadataMatchDialog
                    song={matchingSong}
                    assignment={matchingSongAssignment}
                    isDaylight={isDaylight}
                    onClose={() => setMatchingSongId(null)}
                    onChanged={async () => {
                        await localLibraryCatalog.reload();
                        await surfaceProps.onRefreshLocalSongs();
                    }}
                />
            )}
        </>
    );
};

export default GridViewOverlayHost;
