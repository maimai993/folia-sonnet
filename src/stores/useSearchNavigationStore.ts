import { create } from 'zustand';
import { getNavidromeConfig, navidromeApi } from '../services/navidromeService';
import type { HomeViewTab, LocalSong, SongResult, UnifiedSong } from '../types';
import { DEFAULT_ONLINE_PROVIDER_ID, OnlineProviderError } from '../types/onlineMusic';
import type { OmniCollection, OmniSearchKind, OnlineProviderId } from '../types/onlineMusic';
import {
    applyLocalLibraryEntityDisplay,
    buildUnifiedLocalSong,
    type LocalLibraryDisplayCatalog,
} from '../services/playbackAdapters';
import { omni } from '../services/onlineMusic/omni';
import { noteProviderAuthExpired } from '../services/onlineMusic/authExpiry';
import { isLocalPlaybackSong, isNavidromePlaybackSong } from '../utils/appPlaybackGuards';
import { listAiCloudCacheSongs } from '../services/aiCloudCache';
import { resolveCloudThemeSong } from '../library/core/collection/resource/cloudThemeCollectionDeps.service';

const LAST_HOME_VIEW_TAB_KEY = 'last_home_view_tab';
const DEFAULT_SEARCH_LIMIT = 30;
export type SearchSource = OnlineProviderId | 'local' | 'navidrome' | 'cloud' | 'all';
export type SearchReturnView = 'home' | 'player';
/** 搜什么：单曲、专辑或歌单。专辑和歌单只有在线平台搜得到（omni.getProviderSearchKinds），本地与 Navidrome 只搜单曲。 */
export type SearchKind = OmniSearchKind;

type SearchExecutorDeps = {
    localSongs: LocalSong[];
    localLibraryCatalog?: LocalLibraryDisplayCatalog;
    t: (key: string, fallback?: string) => string;
};

type SearchExecutionResult = {
    /** 单曲搜索的结果；搜专辑、歌单时是空的。 */
    results: UnifiedSong[];
    /** 专辑、歌单搜索的结果；搜单曲时是空的。 */
    collections: OmniCollection[];
    hasMore: boolean;
    nextOffset: number;
    total?: number;
};

type SearchCacheEntry = {
    results: UnifiedSong[];
    collections: OmniCollection[];
    offset: number;
    hasMore: boolean;
    total: number | null;
    scrollTop: number;
};

/**
 * 「全部」中间那几批结果的出口：每次带上「此刻已经有的全部」，调用方整份替换即可。
 * 只在 `sourceTab === 'all'` 时会被叫（见 searchAllSources）。
 */
type SearchPartialSink = (results: UnifiedSong[], hasMore: boolean) => void;

interface SearchNavigationState {
    homeViewTab: HomeViewTab;
    searchQuery: string;
    /** 结果是按哪个词搜出来的（提交或恢复时定下）；searchQuery 是输入框里正在打的字。 */
    submittedQuery: string;
    searchSourceTab: SearchSource;
    searchKind: SearchKind;
    searchResults: UnifiedSong[] | null;
    /** 搜专辑、歌单时的结果（searchKind 不是 'song'）；还没搜过是 null。 */
    collectionResults: OmniCollection[] | null;
    /** 平台说一共有多少条；没说是 null。 */
    resultTotal: number | null;
    searchReturnView: SearchReturnView;
    isSearchOpen: boolean;
    isSearching: boolean;
    isLoadingMore: boolean;
    searchError: string | null;
    requestId: number;
    offset: number;
    limit: number;
    hasMore: boolean;
    scrollTop: number;
    /**
     * 搜索时平台说「要重新登录」（登录过期）：记下是哪一家，由展示层去提示。
     * 那是展示层（能拿到 i18n 和平台显示名）的事，store 只负责把事实记下来。
     */
    searchAuthExpiredProvider: OnlineProviderId | null;
    /**
     * 搜索结果列表往下滚时把底部播放条收到屏幕下面（它挡住列表末尾的「查看更多」），
     * 往上滚再放回来。只在搜索页成立：不写缓存、不持久化，关掉搜索页就复位。
     */
    isResultsBarHidden: boolean;
    searchCache: Record<string, SearchCacheEntry>;
    setHomeViewTab: (tab: HomeViewTab) => void;
    setSearchQuery: (query: string) => void;
    setSearchScrollTop: (scrollTop: number) => void;
    /** 搜索结果列表滚动时收起 / 放回底部播放条（只在搜索页成立，不持久化）。 */
    setResultsBarHidden: (hidden: boolean) => void;
    restoreSearch: (payload: { query: string; sourceTab: SearchSource; kind?: SearchKind; returnView?: SearchReturnView; }) => void;
    hideSearchOverlay: () => void;
    /**
     * 选着的来源不在 `sources` 里了（退出了那个平台的登录、mod 源被关掉、本地曲库清空）：换成 `fallback`，那个来源的
     * 结果与在途的搜索一起作废。还在里面就什么都不动（切换当前平台不重置搜索）。
     */
    keepSearchSourceWithin: (sources: readonly SearchSource[], fallback: SearchSource) => boolean;
    /** `kind` 不给就沿用当前的；来源搜不到这一种时退回单曲（resolveSearchKind）。 */
    submitSearch: (payload: { query?: string; sourceTab: SearchSource; kind?: SearchKind; deps: SearchExecutorDeps; returnView?: SearchReturnView; }) => Promise<boolean>;
    loadMoreSearchResults: (payload: { deps: SearchExecutorDeps; }) => Promise<void>;
}

const getSearchCacheKey = (query: string, sourceTab: SearchSource, kind: SearchKind) => (
    `${sourceTab}:${kind}:${query.trim().toLowerCase()}`
);

/** 这个来源能搜的种类：在线平台问 omni，本地 / Navidrome / 云缓存 /「全部」只有单曲。单曲总在第一个。 */
export const getSearchKinds = (sourceTab: SearchSource): SearchKind[] => {
    // 这几种不是某一个平台：云缓存是按歌名去各家搜，「全部」是把各家掺起来 ——
    // 它们都没有「这家平台能搜什么」可问，问了会拿到 unsupported 而把整次搜索打断。
    if (sourceTab === 'local' || sourceTab === 'navidrome' || sourceTab === 'cloud' || sourceTab === 'all') {
        return ['song'];
    }
    const kinds = omni.getProviderSearchKinds(sourceTab);
    return kinds.includes('song') ? kinds : ['song', ...kinds];
};

/** 来源搜不到要的那一种（换到了没有专辑搜索的平台）就搜单曲。 */
export const resolveSearchKind = (sourceTab: SearchSource, kind: SearchKind): SearchKind => (
    getSearchKinds(sourceTab).includes(kind) ? kind : 'song'
);

export const resolveSearchSource = (tab: HomeViewTab | SearchSource): SearchSource => {
    if (tab === 'local' || tab === 'navidrome' || tab === 'cloud' || tab === 'all') {
        return tab;
    }
    if (tab !== 'playlist' && tab !== 'albums' && tab !== 'radio' && tab !== 'explore') return tab as OnlineProviderId;
    return DEFAULT_ONLINE_PROVIDER_ID;
};

/** 这条搜索来源对应的在线平台；本地 / Navidrome / 云缓存 / 「全部」没有单一平台，返回 null。 */
const providerIdOf = (tab: SearchSource): OnlineProviderId | null => {
    const resolved = resolveSearchSource(tab);
    return resolved === 'local'
        || resolved === 'navidrome'
        || resolved === 'cloud'
        || resolved === 'all'
        ? null
        : resolved;
};

export const resolveCommandPaletteSearchSource = (
    currentSong: SongResult | null,
    searchSourceTab: SearchSource,
    activeOnlineProviderId: OnlineProviderId,
): SearchSource => {
    if (currentSong && isLocalPlaybackSong(currentSong)) return 'local';
    if (currentSong && isNavidromePlaybackSong(currentSong)) return 'navidrome';
    if (currentSong || searchSourceTab === DEFAULT_ONLINE_PROVIDER_ID) return activeOnlineProviderId;
    return searchSourceTab;
};

const mapLocalSongToUnifiedSong = (
    song: LocalSong,
    catalog?: LocalLibraryDisplayCatalog,
): UnifiedSong => applyLocalLibraryEntityDisplay(buildUnifiedLocalSong({
        localSong: song,
        matchedSong: null,
        coverUrl: song.useOnlineCover ? song.onlineMetadata?.coverUrl || null : null,
        preferOnlineMetadata: false,
    }), catalog);

const searchLocalSongs = (
    deps: SearchExecutorDeps,
    query: string,
): SearchExecutionResult => {
    const lowerQuery = query.toLowerCase();
    const results = deps.localSongs
        .filter(song => {
            const title = song.title.toLowerCase();
            const artist = [
                ...song.importedMetadata.artistNames,
                ...song.onlineMetadata?.artists.map(item => item.name) || [],
            ].join(' ').toLowerCase();
            const album = [song.importedMetadata.albumName, song.onlineMetadata?.album?.name]
                .filter(Boolean).join(' ').toLowerCase();
            return title.includes(lowerQuery) || artist.includes(lowerQuery) || album.includes(lowerQuery);
        })
        .map(song => mapLocalSongToUnifiedSong(song, deps.localLibraryCatalog));

    return {
        results,
        collections: [],
        hasMore: false,
        nextOffset: results.length,
    };
};

const searchNavidromeSongs = async (query: string): Promise<SearchExecutionResult> => {
    const config = getNavidromeConfig();
    if (!config) {
        return { results: [], collections: [], hasMore: false, nextOffset: 0 };
    }

    const response = await navidromeApi.search(config, query, 0, 0, DEFAULT_SEARCH_LIMIT);
    const results = (response.song || []).map(song => {
        const navidromeSong = navidromeApi.toNavidromeSong(config, song);
        return navidromeSong as UnifiedSong;
    });

    return {
        results,
        collections: [],
        hasMore: false,
        nextOffset: results.length,
    };
};

/** 「AI 主题」来源同时解析几首歌名（去平台上搜出曲目）：再高就要占住 Capacitor 那座桥。 */
const CLOUD_RESOLVE_CONCURRENCY = 6;

const searchCloudThemeSongs = async (
    query: string,
    limit: number,
    offset: number,
): Promise<SearchExecutionResult> => {
    const browsing = !query.trim();
    let start = offset;
    if (browsing && offset === 0) {
        // 浏览（没有词）时随机起一页：每次进来看到的都不一样，和首页那一屏同一个意思。
        const probe = await listAiCloudCacheSongs({ limit: 1, offset: 0 }).catch(() => null);
        const total = Number(probe?.total ?? 0);
        if (total > limit) {
            start = Math.floor(Math.random() * (total - limit + 1));
        }
    }
    const page = await listAiCloudCacheSongs({ limit, offset: start, query }).catch(() => null);
    const names = page?.songs ?? [];
    if (names.length === 0) return { results: [], collections: [], hasMore: false, nextOffset: offset };
    const found = await mapWithConcurrency(
        names,
        CLOUD_RESOLVE_CONCURRENCY,
        entry => resolveCloudThemeSong(entry.songTitle, entry.key).catch(() => null),
    );
    const results = found.filter((song): song is UnifiedSong => Boolean(song));
    const total = Number(page?.total ?? 0);
    const consumed = start + names.length;
    return { results, collections: [], hasMore: consumed < total, nextOffset: consumed };
};

const searchOnlineProviderSongs = async (
    providerId: OnlineProviderId,
    query: string,
    limit: number,
    offset: number,
): Promise<SearchExecutionResult> => {
    const page = await omni.searchProviderSongs(providerId, query, { limit, offset });
    return { results: page.items, collections: [], hasMore: page.hasMore, nextOffset: page.nextOffset, total: page.total };
};

const searchOnlineProviderCollections = async (
    providerId: OnlineProviderId,
    kind: Exclude<SearchKind, 'song'>,
    query: string,
    limit: number,
    offset: number,
): Promise<SearchExecutionResult> => {
    const page = await omni.searchProviderCollections(providerId, kind, query, { limit, offset });
    return { results: [], collections: page.items, hasMore: page.hasMore, nextOffset: page.nextOffset, total: page.total };
};

const totalOf = (result: SearchExecutionResult): number | null => (
    typeof result.total === 'number' && Number.isFinite(result.total) && result.total >= 0 ? result.total : null
);

/** 并行地图，最多 `limit` 个同时在跑（「全部」与云缓存那两条路共用）。 */
const mapWithConcurrency = async <T, R>(
    items: readonly T[],
    limit: number,
    worker: (item: T) => Promise<R>,
): Promise<R[]> => {
    const results = new Array<R>(items.length);
    let cursor = 0;
    const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        for (;;) {
            const index = cursor;
            cursor += 1;
            if (index >= items.length) return;
            results[index] = await worker(items[index] as T);
        }
    });
    await Promise.all(lanes);
    return results;
};

/** 「全部」里同时跑几个平台：再高就要占住 Capacitor 那座桥（见 mapWithConcurrency）。 */
const ALL_SEARCH_CONCURRENCY = 4;

/** 同一首歌在几家平台上重复出现时用的比对键。 */
const mergeSongKey = (song: UnifiedSong): string => (
    `${(song.name ?? '').trim().toLowerCase()}|${(song.artists ?? [])
        .map(artist => artist?.name ?? '')
        .join(' ')
        .trim()
        .toLowerCase()}`
);

/**
 * 「全部」：所有能搜的在线平台一起搜，再掺上本地曲库和 Navidrome。
 *
 * **流式**：谁先搜完谁先出，不等最后一家。给了 `onPartial` 就会被叫好几次，每次都带上「此刻
 * 已经有的全部」，调用方整份替换即可 —— 于是「有多少先显示多少，新平台好了再插进来」。
 * 单个平台失败（没登录、超时）只丢那一家，不让这一整屏空掉 —— 「全部」本来就是「有几家出几家」。
 *
 * 掺的本地 / Navidrome 只在第一页加：本地那条路是同步过滤、Navidrome 也不认 offset，翻页时
 * 再要一次会原样重复一遍。
 */
const searchAllSources = async (
    query: string,
    offset: number,
    limit: number,
    deps: SearchExecutorDeps,
    onPartial?: SearchPartialSink,
): Promise<SearchExecutionResult> => {
    const providerIds = omni.getProviderSummaries()
        .filter(summary => omni.getProviderCapabilities(summary.providerId).search)
        .map(summary => summary.providerId);
    // 每家匀一点：四家各要一整页就是 120 条，第一屏根本翻不到那么远。
    const perProvider = Math.max(8, Math.ceil(limit / Math.max(1, providerIds.length)));

    /*
     * 每来一桶就往已经显示的那批里**插**，而不是攒齐了一次性排。
     *
     * 位置按「这一首在自己桶里的序号」定：插到第一个序号更大的行前面。于是两家都有结果时
     * 排成 A0 B0 A1 B1 …（跟以前一次性轮着拿的成品一样，第一屏就能看见各家都有），
     * 而**已经在屏幕上的那些行只往下让位、不重新排序** —— 一次性重排会把用户正在看的那几行
     * 挪走，那才是流式最难看的地方。
     */
    const rows: { song: UnifiedSong; rank: number }[] = [];
    const seen = new Set<string>();
    let hasMore = false;

    const insertBucket = (bucket: UnifiedSong[]): number => {
        let added = 0;
        bucket.forEach((song, rank) => {
            // 同一首几个平台都有：只留先到的那一份，否则一屏里同一首排四五遍。
            const key = mergeSongKey(song);
            if (seen.has(key)) return;
            seen.add(key);
            let at = rows.length;
            for (let index = 0; index < rows.length; index += 1) {
                if (rows[index].rank > rank) {
                    at = index;
                    break;
                }
            }
            rows.splice(at, 0, { song, rank });
            added += 1;
        });
        return added;
    };

    const takeBucket = (bucket: UnifiedSong[], more = false) => {
        const added = insertBucket(bucket);
        if (more) hasMore = true;
        if (added > 0 && onPartial) {
            onPartial(rows.map(row => row.song), hasMore);
        }
    };

    // 本地那一路是同步的，先出：输完词立刻就有东西看，不用等任何一家平台回话。
    // Navidrome 那一路跟平台一起跑，回来再插，不堵在前面。
    const navidromePromise = offset === 0
        ? searchNavidromeSongs(query).catch(() => null)
        : null;
    if (offset === 0) {
        takeBucket(searchLocalSongs(deps, query).results);
    }

    await mapWithConcurrency(providerIds, ALL_SEARCH_CONCURRENCY, async (providerId) => {
        try {
            const page = await searchOnlineProviderSongs(providerId, query, perProvider, offset);
            takeBucket(page.results, page.hasMore);
        } catch (error) {
            console.warn('[SearchStore] "all" search skipped a provider:', providerId, error);
        }
    });

    if (navidromePromise) {
        const navidrome = await navidromePromise;
        if (navidrome) takeBucket(navidrome.results);
    }

    return { results: rows.map(row => row.song), collections: [], hasMore, nextOffset: offset + perProvider };
};

const executeSearch = async (
    query: string,
    sourceTab: SearchSource,
    kind: SearchKind,
    offset: number,
    limit: number,
    deps: SearchExecutorDeps,
    onPartial?: SearchPartialSink,
): Promise<SearchExecutionResult> => {
    if (sourceTab === 'local') {
        return searchLocalSongs(deps, query);
    }

    if (sourceTab === 'navidrome') {
        return searchNavidromeSongs(query);
    }

    // 「AI 主题」：在云端缓存的歌名里搜（曲目由客户端拿名字去平台上搜出来）。
    if (sourceTab === 'cloud') {
        return searchCloudThemeSongs(query, limit, offset);
    }

    // 「全部」只掺单曲：专辑与歌单是各家自己的东西，混在一起分不出是谁的。
    // 它路由到 `executeSearch` 之后才判种类，所以这里先把它挡住（getSearchKinds 也只给它 'song'）。
    if (sourceTab === 'all') {
        return searchAllSources(query, offset, limit, deps, onPartial);
    }

    return kind === 'song'
        ? searchOnlineProviderSongs(sourceTab, query, limit, offset)
        : searchOnlineProviderCollections(sourceTab, kind, query, limit, offset);
};

const getInitialHomeViewTab = (): HomeViewTab => {
    if (typeof window === 'undefined') {
        return 'playlist';
    }
    const savedTab = localStorage.getItem(LAST_HOME_VIEW_TAB_KEY);
    return savedTab === 'playlist' || savedTab === 'local' || savedTab === 'albums' || savedTab === 'navidrome' || savedTab === 'radio' || savedTab === 'explore'
        ? savedTab
        : 'playlist';
};

export const useSearchNavigationStore = create<SearchNavigationState>((set, get) => ({
    homeViewTab: getInitialHomeViewTab(),
    searchQuery: '',
    submittedQuery: '',
    searchSourceTab: DEFAULT_ONLINE_PROVIDER_ID,
    searchKind: 'song',
    searchResults: null,
    collectionResults: null,
    resultTotal: null,
    searchReturnView: 'home',
    isSearchOpen: false,
    isSearching: false,
    isLoadingMore: false,
    searchError: null,
    requestId: 0,
    offset: 0,
    limit: DEFAULT_SEARCH_LIMIT,
    hasMore: false,
    scrollTop: 0,
    searchAuthExpiredProvider: null,
    isResultsBarHidden: false,
    searchCache: {},
    setHomeViewTab: (tab) => {
        if (typeof window !== 'undefined') {
            localStorage.setItem(LAST_HOME_VIEW_TAB_KEY, tab);
        }
        set({ homeViewTab: tab });
    },
    setSearchQuery: (query) => set({ searchQuery: query }),
    // 相等就原样返回：列表的 onScroll 会反复调用，卸载时也会补一次复位，不能每次都让订阅者重渲染。
    setResultsBarHidden: (hidden) => set(state => (state.isResultsBarHidden === hidden ? state : { isResultsBarHidden: hidden })),
    setSearchScrollTop: (scrollTop) => set(state => {
        // 滚的是按 submittedQuery 搜出来的那组结果；输入框里改了字也还是它。
        const cacheKey = getSearchCacheKey(state.submittedQuery, state.searchSourceTab, state.searchKind);
        const cached = state.searchCache[cacheKey];
        return {
            scrollTop,
            searchCache: cached
                ? {
                    ...state.searchCache,
                    [cacheKey]: { ...cached, scrollTop },
                }
                : state.searchCache,
        };
    }),
    // 旧的历史记录没有 kind：按当前的种类恢复。requestId 往前走一格：还在途的搜索或加载更多晚到时不再写进恢复出来的这一组。
    restoreSearch: ({ query, sourceTab, kind, returnView = 'home' }) => set(state => {
        const searchKind = resolveSearchKind(sourceTab, kind ?? state.searchKind);
        const cached = state.searchCache[getSearchCacheKey(query, sourceTab, searchKind)];
        return {
            requestId: state.requestId + 1,
            searchQuery: query,
            submittedQuery: query,
            searchSourceTab: sourceTab,
            searchKind,
            searchReturnView: returnView,
            searchResults: cached?.results ?? null,
            collectionResults: cached?.collections ?? null,
            resultTotal: cached?.total ?? null,
            offset: cached?.offset ?? 0,
            hasMore: cached?.hasMore ?? false,
            scrollTop: cached?.scrollTop ?? 0,
            // 播放条是否收起跟着这一次滚动，不跟着缓存：重新进这一页时它是露着的。
            isResultsBarHidden: false,
            searchAuthExpiredProvider: null,
            searchError: null,
            isSearching: false,
            isLoadingMore: false,
            isSearchOpen: true,
        };
    }),
    hideSearchOverlay: () => set({ isSearchOpen: false, searchReturnView: 'home', isResultsBarHidden: false }),
    keepSearchSourceWithin: (sources, fallback) => {
        const state = get();
        if (sources.includes(state.searchSourceTab)) return false;
        set({
            searchSourceTab: fallback,
            searchKind: resolveSearchKind(fallback, state.searchKind),
            searchResults: null,
            collectionResults: null,
            resultTotal: null,
            isSearching: false,
            isLoadingMore: false,
            searchError: null,
            requestId: state.requestId + 1,
            offset: 0,
            hasMore: false,
            scrollTop: 0,
        });
        return true;
    },
    submitSearch: async ({ query, sourceTab, kind, deps, returnView = 'home' }) => {
        const trimmedQuery = (query ?? get().searchQuery).trim();
        /*
         * 「AI 主题」那一屏是**逛**云端缓存里都有什么歌：点那个页签时手上还没有词，
         * 空词也要能拉一屏下来（随机起点那一段见 searchCloudThemeSongs）。
         */
        if (!trimmedQuery && sourceTab !== 'cloud') {
            return false;
        }

        const searchKind = resolveSearchKind(sourceTab, kind ?? get().searchKind);
        const requestId = get().requestId + 1;
        set({
            searchQuery: trimmedQuery,
            submittedQuery: trimmedQuery,
            searchSourceTab: sourceTab,
            searchKind,
            searchReturnView: returnView,
            isSearchOpen: true,
            isSearching: true,
            isLoadingMore: false,
            searchError: null,
            requestId,
            searchResults: null,
            collectionResults: null,
            resultTotal: null,
            offset: 0,
            hasMore: false,
            scrollTop: 0,
        });

        /*
         * 「全部」是流式的：一家搜完就先把那时已有的整批送上来（见 searchAllSources），
         * 这里只管整份替换。
         *
         * **`isSearching` 留到最后才关**：它是「还有平台在跑」的意思，界面靠
         * `searchResults` 有没有东西来决定画不画转圈，所以先出结果和「还在搜」能同时成立。
         * 缓存也只写最终那一份 —— 中途那几批不是完整结果，写进去会把半屏结果当缓存。
         */
        const applyPartial = (partial: UnifiedSong[], partialHasMore: boolean) => {
            if (get().requestId !== requestId) return;
            set({ searchResults: partial, hasMore: partialHasMore });
        };

        try {
            const result = await executeSearch(trimmedQuery, sourceTab, searchKind, 0, get().limit, deps, applyPartial);
            // 被另一次提交或一次历史恢复作废了：回 false，调用方不再拿它压历史。作废它的那一次自己会导航；
            // 恢复时历史已经是恢复后的样子，再压一条就会把人拉回一个没有结果的搜索页。
            if (get().requestId !== requestId) {
                return false;
            }
            const total = totalOf(result);
            set(state => ({
                searchResults: result.results,
                collectionResults: result.collections,
                resultTotal: total,
                hasMore: result.hasMore,
                offset: result.nextOffset,
                isSearching: false,
                // 上一组结果的列表卸载时会把它的滚动位置写回来（SearchResultsList 的 cleanup）：新结果从顶上开始。
                scrollTop: 0,
                searchCache: {
                    ...state.searchCache,
                    [getSearchCacheKey(trimmedQuery, sourceTab, searchKind)]: {
                        results: result.results,
                        collections: result.collections,
                        hasMore: result.hasMore,
                        offset: result.nextOffset,
                        total,
                        scrollTop: 0,
                    },
                },
            }));
            return true;
        } catch (error) {
            console.error('[SearchStore] submitSearch failed:', error);
            if (get().requestId !== requestId) {
                return false;
            }
            /*
             * 登录态失效是最该被看见的一类失败：它就发生在搜索这一下，
             * 界面上却是干干净净的「没有结果」—— 用户只会以为这首歌搜不到。
             * 记下平台，顺手把账号标成过期（首页和账户面板那套「登录已过期」会亮起来），
             * 展示层再据此把提示换成能点名平台的那一句。
             */
            const authProviderId = error instanceof OnlineProviderError
                && error.code === 'auth-required'
                ? (error.providerId ?? providerIdOf(sourceTab))
                : null;
            if (authProviderId) {
                noteProviderAuthExpired(authProviderId);
            }
            set({
                searchResults: [],
                collectionResults: [],
                resultTotal: null,
                hasMore: false,
                offset: 0,
                isSearching: false,
                scrollTop: 0,
                searchError: error instanceof Error ? error.message : 'search_failed',
                searchAuthExpiredProvider: authProviderId,
            });
            return true;
        }
    },
    loadMoreSearchResults: async ({ deps }) => {
        // 接着翻的是已经显示的那组结果，按搜出它的词翻，不按输入框里改到一半的字。
        const {
            submittedQuery: searchQuery,
            searchSourceTab,
            searchKind,
            searchResults,
            collectionResults,
            hasMore,
            isSearching,
            isLoadingMore,
            offset,
            limit,
        } = get();

        if (
            searchSourceTab === 'local'
            || searchSourceTab === 'navidrome'
            || !hasMore
            || isSearching
            || isLoadingMore
            || !searchQuery.trim()
        ) {
            return;
        }

        const requestId = get().requestId;
        // 翻页也走流式：中途那几批都挂在「进来时那一份」后面，最终那一次用同一个底，
        // 所以不会出现「中途插了一批、最后又把整页追加一遍」的重复。
        const baseResults = searchResults || [];
        set({ isLoadingMore: true, searchError: null });

        try {
            const applyPartial = (partial: UnifiedSong[], partialHasMore: boolean) => {
                if (get().requestId !== requestId) return;
                set({ searchResults: [...baseResults, ...partial], hasMore: partialHasMore });
            };
            const result = await executeSearch(
                searchQuery,
                searchSourceTab,
                searchKind,
                offset,
                limit,
                deps,
                applyPartial,
            );
            if (get().requestId !== requestId) {
                return;
            }
            set(state => {
                const results = [...baseResults, ...result.results];
                const collections = [...(collectionResults || []), ...result.collections];
                const total = totalOf(result) ?? state.resultTotal;
                return {
                    searchResults: results,
                    collectionResults: collections,
                    resultTotal: total,
                    hasMore: result.hasMore,
                    offset: result.nextOffset,
                    isLoadingMore: false,
                    searchCache: {
                        ...state.searchCache,
                        [getSearchCacheKey(searchQuery, searchSourceTab, searchKind)]: {
                            results,
                            collections,
                            hasMore: result.hasMore,
                            offset: result.nextOffset,
                            total,
                            scrollTop: state.scrollTop,
                        },
                    },
                };
            });
        } catch (error) {
            console.error('[SearchStore] loadMoreSearchResults failed:', error);
            if (get().requestId === requestId) {
                set({
                    isLoadingMore: false,
                    searchError: error instanceof Error ? error.message : 'search_failed',
                });
            }
        }
    },
}));
