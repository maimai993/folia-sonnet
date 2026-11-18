import React, { useCallback, useEffect, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import type { Theme, UnifiedSong } from '../../../types';
import type { MediaId, OmniCollection } from '../../../types/onlineMusic';
import {
    getSearchKinds,
    type SearchKind,
    type SearchSource,
    useSearchNavigationStore,
} from '../../../stores/useSearchNavigationStore';
import SearchResultsList from './SearchResultsList';
import { usePlaybackStore, selectDisplaySong } from '../../../stores/usePlaybackStore';
import { getSongArtistLabel } from '../../../services/onlineMusic/songMetadata';
import { songKeyOf } from '../../bilibili/BilibiliMvLayer';
import SearchComposition from './SearchComposition';
import SearchTabs, { useSearchSourceLabel } from './SearchTabs';
import { useCollectionNavigationStore } from '../../../stores/useCollectionNavigationStore';
import { useSearchSources } from './searchSources';
import { collectToScratchpad } from '../../../stores/useScratchpadStore';
import { canOpenPlaylistPickerFor, openAddSongsToPlaylist } from '../../../stores/useAddToPlaylistStore';
import './search.css';

// src/components/app/search/SearchWorkspace.tsx
// 搜索页：搜索框、来源（当前在线平台、已登录与无需登录的在线平台、有歌时的本地、配好了的 Navidrome，见 searchSources）、
// 种类（单曲 / 专辑 / 歌单，在线平台搜得到几种就有几种），结果是一张列表；底下压着一幅随种类换站位、换来源时整幅
// 转一下的至上主义构图（SearchComposition）。选着的来源不再可用时回落到当前平台。
// 单曲行尾悬停出现的「加入速记簿」「收藏到歌单」直接交给速记簿与应用的歌单选择器（与资料库卡片上的同一对），
// 速记簿里这一组的出处是「搜索「词」」。

type SearchWorkspaceProps = {
    theme: Theme;
    isDaylight: boolean;
    onClose: () => void;
    /** 退掉压在搜索结果之上的一层（歌单 / 专辑）。安卓返回键在搜索页里要靠它逐层返回（#411）。 */
    onBackCollection: () => void;
    onSubmitSearch: (source?: SearchSource, kind?: SearchKind) => void;
    onLoadMore: () => void;
    onPlayTrack: (track: UnifiedSong) => void;
    onAddTrackToQueue: (track: UnifiedSong) => void;
    onOpenArtist: (track: UnifiedSong, artistName: string, artistId?: MediaId, entityId?: string) => void;
    onOpenAlbum: (track: UnifiedSong, albumName: string, albumId?: MediaId, entityId?: string) => void;
    /** 打开搜到的一张专辑或一个歌单。 */
    onOpenCollection: (collection: OmniCollection) => void;
    /**
     * 渲染前把结果重新套上当前的展示数据（本地曲目的歌手 / 专辑实体）。store 里的结果是提交那一刻的快照，
     * 本地曲库的实体目录在导入后要晚一拍才加载完，那之前搜到的行没有专辑、歌手链接是灰的；
     * 不在这里按当前目录重算，它们会一直停在那个状态，直到重新搜索。
     */
    resolveTrackDisplay?: (track: UnifiedSong) => UnifiedSong;
    /** 本地曲库里有没有歌：没有就不列「本地」这个来源。 */
    hasLocalSongs: boolean;
};

const PLACEHOLDER_KEYS: Record<SearchKind, string> = {
    song: 'search.placeholder',
    album: 'search.placeholderAlbum',
    playlist: 'search.placeholderPlaylist',
    // 视频站那几档；音乐平台不会选中它们，取不到时用通用的那句。
    video: 'search.placeholderVideo',
    bangumi: 'search.placeholderBangumi',
    movie: 'search.placeholderMovie',
    user: 'search.placeholderUser',
};

const SearchWorkspace: React.FC<SearchWorkspaceProps> = ({
    theme,
    isDaylight,
    onClose,
    onBackCollection,
    onSubmitSearch,
    onLoadMore,
    onPlayTrack,
    onAddTrackToQueue,
    onOpenArtist,
    onOpenAlbum,
    onOpenCollection,
    resolveTrackDisplay,
    hasLocalSongs,
}) => {
    const { t } = useTranslation();
    const {
        searchQuery,
        submittedQuery,
        searchSourceTab,
        searchKind,
        searchResults,
        collectionResults,
        resultTotal,
        isSearchOpen,
        isSearching,
        isLoadingMore,
        searchError,
        hasMore,
        scrollTop,
        setSearchQuery,
        setSearchScrollTop,
        setResultsBarHidden,
    } = useSearchNavigationStore(useShallow(state => ({
        searchQuery: state.searchQuery,
        submittedQuery: state.submittedQuery,
        searchSourceTab: state.searchSourceTab,
        searchKind: state.searchKind,
        searchResults: state.searchResults,
        collectionResults: state.collectionResults,
        resultTotal: state.resultTotal,
        isSearchOpen: state.isSearchOpen,
        isSearching: state.isSearching,
        isLoadingMore: state.isLoadingMore,
        searchError: state.searchError,
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
    const collections = collectionResults || [];
    /*
     * 哪些种类摆的是「集合」（专辑 / 歌单 / 番剧 / 电影 / 用户），哪些摆的是「单曲」。
     *
     * 不能写成 `kind !== 'song'`：视频站的「视频」那一档和单曲是同一条路
     * （executeSearch 把 'video' 也交给 searchOnlineProviderSongs，见那边的注释），
     * 结果落在 searchResults 里。以前这里把 'video' 当集合，界面就去读
     * collectionResults —— 永远是空的，表现成「视频这一档什么都搜不出来」，
     * 而同一个词在番剧 / 电影 / 用户那几档都正常。
     */
    const isCollectionKind = searchKind === 'album'
        || searchKind === 'playlist'
        || searchKind === 'bangumi'
        || searchKind === 'movie'
        || searchKind === 'user';
    const resultCount = isCollectionKind ? collections.length : results.length;
    const { sources, activeProviderId } = useSearchSources(hasLocalSongs);
    // B 站那一栏要「把视频钉到正在放的这首歌」：从播放器取当前歌，拼成 songKey。
    const displaySong = usePlaybackStore(selectDisplaySong);
    const currentSongKey = useMemo(() => {
        if (!displaySong) return '';
        const name = (displaySong as { name?: string }).name ?? '';
        const artist = getSongArtistLabel(displaySong as never) || '';
        return songKeyOf(name, artist);
    }, [displaySong]);
    // 钉好之后退出搜索：用户点的是「看这个视频」，不该还停在结果里。
    // onClose 就是「关搜索回主界面」，在播放页上发起搜索时回去正好是播放页。
    const onOpenPlayerAfterPin = useCallback(() => {
        onClose();
    }, [onClose]);
    const kinds = useMemo(() => getSearchKinds(searchSourceTab), [searchSourceTab]);
    const hasCollection = useCollectionNavigationStore(state => Boolean(state.snapshot?.stack.length));
    const getSourceLabel = useSearchSourceLabel();
    const collectTrack = useCallback((track: UnifiedSong) => {
        collectToScratchpad([track], submittedQuery.trim() ? { label: t('scratchpad.originSearch', { query: submittedQuery.trim() }) } : undefined);
    }, [submittedQuery, t]);
    const saveTrackToPlaylist = useCallback((track: UnifiedSong) => {
        if (canOpenPlaylistPickerFor(track)) openAddSongsToPlaylist([track]);
    }, []);
    const paperColor = isDaylight ? 'rgba(250,250,250,0.96)' : 'rgba(8,8,10,0.94)';
    const countLabel = resultTotal !== null && resultTotal >= resultCount
        ? String(resultTotal)
        : `${resultCount}${hasMore ? '+' : ''}`;

    // 选着的来源不再可用（退出了它的登录、mod 源关掉、本地曲库清空）：回落到当前平台，搜过词的话在那里再搜一遍。
    // 只在页面开着时看：启动时本地曲库还没读完，那时的「没有歌」不作数。
    useEffect(() => {
        if (!isSearchOpen) return;
        const fellBack = useSearchNavigationStore.getState().keepSearchSourceWithin(sources, activeProviderId);
        if (fellBack && submittedQuery.trim()) onSubmitSearch(activeProviderId);
    }, [activeProviderId, isSearchOpen, onSubmitSearch, sources, submittedQuery]);

    useEffect(() => {
        if (!isSearchOpen) return;
        /*
         * 安卓返回键（#411）：它派发的是一个 Escape，**有人消费才算关掉一层**，没人消费就退到后台。
         *
         * 原来这里是 `if (!isSearchOpen || hasCollection) return` —— 打开一张歌单 / 专辑之后
         * 搜索页就不接管 Escape 了，于是返回键直接退到后台（用户看到的正是「返回键把 App 杀了」），
         * 而不是先退回搜索结果。现在分两层：
         *   · 压在搜索结果之上（hasCollection）：退掉那一层，搜索页留着；
         *   · 已经在搜索结果上：关掉搜索页。
         * 两层都要 preventDefault，让 useNativeBackButton 认为这次按键被消费掉。
         */
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            if (hasCollection) onBackCollection();
            else onClose();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [hasCollection, isSearchOpen, onBackCollection, onClose]);

    return (
        <AnimatePresence>
            {isSearchOpen && (
                <motion.section
                    initial={{ opacity: 0, y: 28 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 28 }}
                    className={`search-workspace fixed inset-0 flex flex-col overflow-hidden px-4 sm:px-8 ${
                        hasCollection ? 'z-[5]' : 'z-50'
                    }`}
                    style={{
                        // 顶部避开状态栏：走 --folia-safe-area-top（原生量好写进 <html>）。
                        // 安卓 WebView 的 env(safe-area-inset-top) 恒为 0，直接写 env() 无效。
                        // 底部不用让出播放条：列表往下滚时播放条自己收起、往上滚再出来。
                        paddingTop: 'calc(var(--folia-safe-area-top, 0px) + 20px)',
                        paddingBottom: '20px',
                        color: theme.primaryColor,
                        backgroundColor: paperColor,
                        backdropFilter: 'blur(24px)',
                        '--search-ink': theme.primaryColor,
                        '--search-accent': theme.accentColor,
                        '--search-paper': isDaylight ? '#fafafa' : '#08080a',
                    } as React.CSSProperties}
                >
                    <SearchComposition
                        kind={searchKind}
                        query={submittedQuery}
                        source={searchSourceTab}
                        sourceIndex={sources.indexOf(searchSourceTab)}
                    />

                    <header className="mx-auto flex w-full max-w-5xl shrink-0 flex-col gap-5">
                        <div className="flex items-center gap-4">
                            <form
                                className="search-field flex-1"
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    onSubmitSearch();
                                }}
                            >
                                <span className={`search-field-mark ${isSearching ? 'is-busy' : ''}`} aria-hidden="true" />
                                <input
                                    value={searchQuery}
                                    onChange={event => setSearchQuery(event.target.value)}
                                    placeholder={t(PLACEHOLDER_KEYS[searchKind])}
                                    autoFocus
                                />
                            </form>
                            <button
                                type="button"
                                onClick={onClose}
                                className="search-close"
                                aria-label={t('ui.backToHome')}
                            >
                                <X size={20} />
                            </button>
                        </div>

                        <SearchTabs
                            sources={sources}
                            source={searchSourceTab}
                            kinds={kinds}
                            kind={searchKind}
                            onSelectSource={source => onSubmitSearch(source)}
                            onSelectKind={kind => onSubmitSearch(searchSourceTab, kind)}
                        />

                        <div className="search-meta">
                            <span>{getSourceLabel(searchSourceTab)}</span>
                            {!isSearching && resultCount > 0 && (
                                <span>{t('search.resultCount', { n: countLabel })}</span>
                            )}
                        </div>
                    </header>

                    <div className="search-plane mx-auto mt-3 min-h-0 w-full max-w-5xl flex-1">
                        {isSearching ? (
                            <div className="flex h-full items-center justify-center">
                                <div className="search-loader" role="status" aria-label={t('localMusic.searching')}>
                                    <i />
                                    <i />
                                    <i />
                                </div>
                            </div>
                        ) : searchError && resultCount === 0 ? (
                            <div className="flex h-full flex-col items-center justify-center gap-6 text-center">
                                <div className="search-void" aria-hidden="true" />
                                <p className="text-sm font-semibold opacity-70">{t('search.error')}</p>
                                <button
                                    type="button"
                                    onClick={() => onSubmitSearch()}
                                    className="search-flat-button"
                                >
                                    {t('search.retry')}
                                </button>
                            </div>
                        ) : resultCount === 0 ? (
                            <div className="flex h-full flex-col items-center justify-center gap-6 text-center">
                                <div className="search-void" aria-hidden="true" />
                                <p className="text-sm font-semibold opacity-60">{t('home.noResults')}</p>
                            </div>
                        ) : (
                            <div className="flex h-full flex-col">
                                <div className="min-h-0 flex-1">
                                    <SearchResultsList
                                        tracks={isCollectionKind ? undefined : results}
                                        collections={isCollectionKind ? collections : undefined}
                                        revealKey={`${searchSourceTab}:${searchKind}:${submittedQuery}`}
                                        scrollTop={scrollTop}
                                        onScrollTopChange={setSearchScrollTop}
                                        onScrollBarHiddenChange={setResultsBarHidden}
                                        onPlayTrack={onPlayTrack}
                                        onAddTrackToQueue={onAddTrackToQueue}
                                        onCollectTrack={collectTrack}
                                        canSaveTrackToPlaylist={canOpenPlaylistPickerFor}
                                        onSaveTrackToPlaylist={saveTrackToPlaylist}
                                        onOpenArtist={onOpenArtist}
                                        onOpenAlbum={onOpenAlbum}
                                        onOpenCollection={onOpenCollection}
                                        hasMore={Boolean(hasMore)}
                                        isLoadingMore={Boolean(isLoadingMore)}
                                        onLoadMore={onLoadMore}
                                    />
                                </div>
                                {searchError && (
                                    <div className="flex shrink-0 items-center justify-center gap-4 py-3 text-sm">
                                        <span className="opacity-60">{t('search.error')}</span>
                                        <button
                                            type="button"
                                            disabled={isLoadingMore}
                                            onClick={onLoadMore}
                                            className="search-flat-button"
                                        >
                                            {t('search.retry')}
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </motion.section>
            )}
        </AnimatePresence>
    );
};

export default SearchWorkspace;
