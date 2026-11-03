import React, { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, Loader2, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import type { Theme, UnifiedSong } from '../../../types';
import type { MediaId } from '../../../types/onlineMusic';
import {
    type SearchSource,
    useSearchNavigationStore,
} from '../../../stores/useSearchNavigationStore';
import SearchResultsList from './SearchResultsList';
import { useCollectionNavigationStore } from '../../../stores/useCollectionNavigationStore';
import { useOnlineProviderAccountStore } from '../../../stores/useOnlineProviderAccountStore';
import { omni } from '../../../services/onlineMusic/omni';
import { Button, TextField } from '@/components/ui';

// src/components/app/search/SearchWorkspace.tsx

// 平台注册表会在运行时增删（Folium mod 源），源列表要跟着它变，所以订阅版本号而不是只在挂载时读一次。
const subscribeProviderRegistry = (listener: () => void) => omni.subscribeProviders(listener);
const readProviderRegistryVersion = () => omni.getProviderRegistryVersion();

type SearchWorkspaceProps = {
    theme: Theme;
    isDaylight: boolean;
    onClose: () => void;
    onSubmitSearch: (source?: SearchSource) => void;
    onLoadMore: () => void;
    onPlayTrack: (track: UnifiedSong) => void;
    onAddTrackToQueue: (track: UnifiedSong) => void;
    onOpenArtist: (track: UnifiedSong, artistName: string, artistId?: MediaId, entityId?: string) => void;
    onOpenAlbum: (track: UnifiedSong, albumName: string, albumId?: MediaId, entityId?: string) => void;
    /**
     * 渲染前把结果重新套上当前的展示数据（本地曲目的歌手 / 专辑实体）。store 里的结果是提交那一刻的快照，
     * 本地曲库的实体目录在导入后要晚一拍才加载完，那之前搜到的行没有专辑、歌手链接是灰的；
     * 不在这里按当前目录重算，它们会一直停在那个状态，直到重新搜索。
     */
    resolveTrackDisplay?: (track: UnifiedSong) => UnifiedSong;
};

const SearchWorkspace: React.FC<SearchWorkspaceProps> = ({
    theme,
    isDaylight,
    onClose,
    onSubmitSearch,
    onLoadMore,
    onPlayTrack,
    onAddTrackToQueue,
    onOpenArtist,
    onOpenAlbum,
    resolveTrackDisplay,
}) => {
    const { t } = useTranslation();
    const {
        searchQuery,
        searchSourceTab,
        searchResults,
        isSearchOpen,
        isSearching,
        isLoadingMore,
        searchError,
        searchAuthExpiredProvider,
        hasMore,
        scrollTop,
        setSearchQuery,
        setSearchScrollTop,
        setResultsBarHidden,
    } = useSearchNavigationStore(useShallow(state => ({
        searchQuery: state.searchQuery,
        searchSourceTab: state.searchSourceTab,
        searchResults: state.searchResults,
        isSearchOpen: state.isSearchOpen,
        isSearching: state.isSearching,
        isLoadingMore: state.isLoadingMore,
        searchError: state.searchError,
        searchAuthExpiredProvider: state.searchAuthExpiredProvider,
        hasMore: state.hasMore,
        scrollTop: state.scrollTop,
        setSearchQuery: state.setSearchQuery,
        setSearchScrollTop: state.setSearchScrollTop,
        setResultsBarHidden: state.setResultsBarHidden,
    })));
    const results = useMemo(() => {
        const raw = searchResults || [];
        return resolveTrackDisplay ? raw.map(resolveTrackDisplay) : raw;
    }, [resolveTrackDisplay, searchResults]);
    /*
     * 搜索失败时点名是哪个平台登录过期了。
     *
     * 光说「搜索失败」用户只会重试 —— 而 cookie 过期是重试一万次也不会好的，
     * 他真正要做的是去重新登录那个平台。平台名必须带上：手机上同时挂着好几个平台，
     * 不点名他只能挨个试。
     */
    const searchErrorText = searchAuthExpiredProvider
        ? t('status.providerLoginExpired', { provider: omni.getProviderLabel(searchAuthExpiredProvider) })
        : t('search.error');
    const activeOnlineProviderId = useOnlineProviderAccountStore(state => state.activeProviderId);
    const providerRegistryVersion = useSyncExternalStore(
        subscribeProviderRegistry,
        readProviderRegistryVersion,
    );
    /**
     * 源列表 = 所有能搜的在线平台 + 本地 + Navidrome。
     *
     * 原来只列当前平台那一个，于是从本地页签进来时列表里根本没有网易云 —— 就是「搜索之后
     * 切不到网易云」。当前平台仍然排最前（它在的时候是默认源），其余按注册表顺序跟上。
     */
    const sources = useMemo<SearchSource[]>(() => {
        const online = omni.getProviderSummaries()
            .filter(summary => omni.getProviderCapabilities(summary.providerId).search)
            .map(summary => summary.providerId);
        // 「AI 主题」跟在「本地」后面：它同样不是某个在线平台，是云端缓存里那一批歌。
        // 「全部」排最前：它是「所有平台一起搜」，本身不是某一个平台（见 store 的 searchAllSources）。
        return [
            'all',
            activeOnlineProviderId,
            ...online.filter(id => id !== activeOnlineProviderId),
            'local',
            'cloud',
            'navidrome',
        ];
    }, [activeOnlineProviderId, providerRegistryVersion]);
    const hasCollection = useCollectionNavigationStore(state => Boolean(state.snapshot?.stack.length));
    const getSourceLabel = (source: SearchSource) => {
        if (source === 'all') return t('search.sourceAll');
        if (source === 'local') return t('search.sourceLocal');
        if (source === 'cloud') return t('search.sourceCloudTheme');
        if (source === 'navidrome') return t('search.sourceNavidrome');
        return omni.getProviderLabel(source);
    };

    useEffect(() => {
        if (!isSearchOpen || hasCollection) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [hasCollection, isSearchOpen, onClose]);

    /**
     * 带着词进来但还没有结果时，自己补一次提交。
     *
     * 墙上的搜索框（bravais）走的是 onSearchCommitted → navigateToSearch，只写历史、不发请求，
     * 于是进了搜索页「未找到相关结果」，必须再点一次搜索才真的搜。老套件 Grid3D 是先
     * submitSearch 再 onSearchCommitted，bravais 漏了这一步；把补提交放在这里而不是回墙上，
     * 是因为浏览器后退、刷新进 #search/... 这些入口同样需要它。
     *
     * 按「源 + 词」记一次，避免换源 / 改词时反复提交；关掉搜索页就清掉。
     */
    const autoSubmittedRef = useRef<string | null>(null);
    useEffect(() => {
        if (!isSearchOpen) {
            autoSubmittedRef.current = null;
        }
    }, [isSearchOpen]);

    /*
     * 关掉搜索页就把播放条放回来。那个「收起来」只属于这一次滚动，留着的话下次进搜索页
     * 列表明明停在顶上，底下却空着一块控制条。
     */
    useEffect(() => {
        if (!isSearchOpen) {
            setResultsBarHidden(false);
        }
    }, [isSearchOpen, setResultsBarHidden]);

    useEffect(() => {
        if (!isSearchOpen || hasCollection) return;
        const trimmedQuery = searchQuery.trim();
        // 出错与「确实没有结果」都把 searchResults 落成了 []，不是 null，所以不会在这里空转。
        if (!trimmedQuery || isSearching || searchResults !== null) return;
        const key = `${searchSourceTab}:${trimmedQuery.toLowerCase()}`;
        if (autoSubmittedRef.current === key) return;
        autoSubmittedRef.current = key;
        void onSubmitSearch(searchSourceTab);
    }, [hasCollection, isSearchOpen, isSearching, onSubmitSearch, searchQuery, searchResults, searchSourceTab]);

    // 上面那次补提交到达之前，results 还是 null：那一帧不该画「未找到相关结果」。
    const awaitingFirstResult = !hasCollection
        && searchResults === null
        && !searchError
        && Boolean(searchQuery.trim());

    /*
     * 列表末尾那一行：还在搜的提示、「加载更多」、以及这一批失败后的重试。
     *
     * 它是**这批结果的结尾**，所以跟着列表一起滚，不再钉在屏幕最下面：钉住时它永远占着一条，
     * 底下那块列表反而被压短了，还和浮在下面的播放条抢同一块地方。
     */
    const trailingRow = isSearching || searchError || hasMore ? (
        <div className="flex flex-col items-center justify-center gap-2 px-2 py-3">
            {isSearching && (
                <div className="flex items-center gap-2 text-xs opacity-55">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>{t('search.streamingMore')}</span>
                </div>
            )}
            {searchError ? (
                <div className="flex items-center gap-3 text-sm">
                    <span className="opacity-60">{searchErrorText}</span>
                    <Button
                        disabled={isLoadingMore}
                        onClick={onLoadMore}
                        className="rounded-full border border-current/15 px-4 py-2 disabled:opacity-50"
                    >
                        {t('search.retry')}
                    </Button>
                </div>
            ) : hasMore ? (
                <Button
                    disabled={isLoadingMore}
                    onClick={onLoadMore}
                    className={`rounded-full border px-5 py-2 text-sm disabled:opacity-50 ${
                        isDaylight
                            ? 'border-black/10 bg-black/5 hover:bg-black/10'
                            : 'border-white/10 bg-white/5 hover:bg-white/10'
                    }`}
                >
                    {isLoadingMore ? t('localMusic.searching') : t('home.loadMore')}
                </Button>
            ) : null}
        </div>
    ) : undefined;

    return (
        <AnimatePresence>
            {isSearchOpen && (
                <motion.section
                    initial={{ opacity: 0, y: 28 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 28 }}
                    className={`fixed inset-0 flex flex-col overflow-hidden px-3 py-4 sm:px-6 sm:py-6 ${
                        hasCollection ? 'z-[5]' : 'z-50'
                    }`}
                    style={{
                        color: theme.primaryColor,
                        backgroundColor: isDaylight ? 'rgba(250,250,250,0.96)' : 'rgba(8,8,10,0.94)',
                        backdropFilter: 'blur(24px)',
                    }}
                >
                    {/* 安全区：安卓的 env() 不可信（见 androidPhoneFit.css ⑥），搜索框由 CSS 整体下移。 */}
                    <header data-folia-safe-top="shift" className="mx-auto flex w-full max-w-5xl shrink-0 flex-col gap-3">
                        <div className="flex items-center gap-3">
                            <form
                                className={`relative flex-1 rounded-2xl border ${
                                    isDaylight ? 'border-black/10 bg-black/[0.04]' : 'border-white/10 bg-white/[0.05]'
                                }`}
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    onSubmitSearch();
                                }}
                            >
                                {isSearching ? (
                                    <Loader2 className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin opacity-50" />
                                ) : (
                                    <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 opacity-45" />
                                )}
                                <TextField
                                    value={searchQuery}
                                    onChange={event => setSearchQuery(event.target.value)}
                                    placeholder={t('search.placeholder')}
                                    className="w-full bg-transparent py-3.5 pl-11 pr-4 text-sm outline-none"
                                    autoFocus
                                />
                            </form>
                            <Button
                                onClick={onClose}
                                className={`rounded-full p-3 ${
                                    isDaylight ? 'bg-black/5 hover:bg-black/10' : 'bg-white/10 hover:bg-white/15'
                                }`}
                                aria-label={t('ui.backToHome')}
                            >
                                <X size={20} />
                            </Button>
                        </div>

                        {/*
                            横向滚动而不是换行：平台多了（现在列出所有能搜的源）之后，窄屏上这一排放不下。
                            关键是每个按钮上的 shrink-0 —— flex 子项默认可压缩，不给它就会被挤扁、
                            里面的文字折成两行，看着像「自动换行」。
                            -mx-1 / px-1 是为了焦点环不被 overflow 裁掉。
                        */}
                        <nav className="hide-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
                            {sources.map(source => (
                                <Button
                                    key={source}
                                    onClick={() => {
                                        if (source !== searchSourceTab) {
                                            onSubmitSearch(source);
                                        }
                                    }}
                                    className={`shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-xs font-medium transition-colors ${
                                        source === searchSourceTab
                                            ? 'shadow-sm'
                                            : isDaylight
                                                ? 'bg-black/5 text-black/60 hover:bg-black/10'
                                                : 'bg-white/5 text-white/60 hover:bg-white/10'
                                    }`}
                                    style={source === searchSourceTab ? {
                                        backgroundColor: theme.accentColor,
                                        color: theme.backgroundColor,
                                    } : undefined}
                                >
                                    {getSourceLabel(source)}
                                </Button>
                            ))}
                        </nav>
                    </header>

                    <div className="mx-auto mt-3 min-h-0 w-full max-w-5xl flex-1">
                        {/*
                            「全部」是流式的：出了一批就把 isSearching 之外的东西都备好了，
                            这里只要**已经有结果**就立刻画列表，不再拿一个大转圈把整屏占住
                            （见 store 里 submitSearch 的 applyPartial）。
                        */}
                        {results.length === 0 && (isSearching || awaitingFirstResult) ? (
                            <div className="flex h-full items-center justify-center">
                                <Loader2 className="h-9 w-9 animate-spin opacity-45" />
                            </div>
                        ) : searchError && results.length === 0 ? (
                            <div className="flex h-full flex-col items-center justify-center gap-3 text-center opacity-65">
                                <AlertCircle size={32} />
                                <p>{searchErrorText}</p>
                                <Button
                                    onClick={() => onSubmitSearch()}
                                    className="rounded-full border border-current/15 px-4 py-2 text-sm"
                                >
                                    {t('search.retry')}
                                </Button>
                            </div>
                        ) : results.length === 0 ? (
                            <div className="flex h-full items-center justify-center text-sm opacity-50">
                                {t('home.noResults')}
                            </div>
                        ) : (
                            <SearchResultsList
                                tracks={results}
                                scrollTop={scrollTop}
                                isDaylight={isDaylight}
                                onScrollTopChange={setSearchScrollTop}
                                onScrollBarHiddenChange={setResultsBarHidden}
                                onPlayTrack={onPlayTrack}
                                onAddTrackToQueue={onAddTrackToQueue}
                                onOpenArtist={onOpenArtist}
                                onOpenAlbum={onOpenAlbum}
                                trailingRow={trailingRow}
                            />
                        )}
                    </div>
                </motion.section>
            )}
        </AnimatePresence>
    );
};

export default SearchWorkspace;
