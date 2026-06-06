import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, User, Loader2, Settings, LayoutGrid, Disc, Map as MapIcon, ArrowLeft, Heart } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useSearchNavigationStore } from '../stores/useSearchNavigationStore';
import { useSettingsUiStore } from '../stores/useSettingsUiStore';
import { useShallow } from 'zustand/react/shallow';
import { SongResult, NeteaseUser, NeteasePlaylist, LocalSong, LocalPlaylist, LocalLibraryGroup, Theme, PlayerState } from '../types';
import { neteaseApi, isSongMarkedUnavailable } from '../services/netease';
import { getNavidromeConfig, navidromeApi } from '../services/navidromeService';
import LocalMusicView from './LocalMusicView';
import NavidromeMusicView from './navidrome/NavidromeMusicView';
import GridView from './GridView';
import { formatSongName } from '../utils/songNameFormatter';

// C:\Users\123xi\.gemini\antigravity-ide\brain\5ddc5af2-6cab-4638-828b-1773ffe7d556
// src/components/Grid3D.tsx
// Glassmorphic interactive desktop home view replacing the legacy 3D carousel.
// Supports cover sliding with auto-fading header controls and opens songs in GridView.

interface Grid3DProps {
    onPlaySong: (song: SongResult, playlistCtx?: SongResult[], isFmCall?: boolean) => void;
    onBackToPlayer: () => void;
    onRefreshUser: () => void;
    user: NeteaseUser | null;
    playlists: NeteasePlaylist[];
    cloudPlaylist?: NeteasePlaylist | null;
    currentTrack?: SongResult | null;
    isPlaying: boolean;
    onSelectPlaylist: (playlist: NeteasePlaylist) => void;
    onSelectAlbum: (albumId: number) => void;
    onSelectArtist: (artistId: number) => void;
    onSelectLocalAlbum?: (albumName: string) => void;
    onSelectLocalArtist?: (artistName: string) => void;
    localSongs: LocalSong[];
    localPlaylists: LocalPlaylist[];
    onRefreshLocalSongs: () => void;
    onPlayLocalSong: (song: LocalSong, queue?: LocalSong[]) => void;
    onAddLocalSongToQueue?: (song: LocalSong) => void;
    localMusicState: {
        activeRow: 0 | 1 | 2 | 3;
        selectedGroup: LocalLibraryGroup | null;
        detailStack: LocalLibraryGroup[];
        detailOriginView: 'home' | 'player' | null;
        focusedFolderIndex: number;
        focusedAlbumIndex: number;
        focusedArtistIndex: number;
        focusedPlaylistIndex: number;
    };
    setLocalMusicState: React.Dispatch<React.SetStateAction<{
        activeRow: 0 | 1 | 2 | 3;
        selectedGroup: LocalLibraryGroup | null;
        detailStack: LocalLibraryGroup[];
        detailOriginView: 'home' | 'player' | null;
        focusedFolderIndex: number;
        focusedAlbumIndex: number;
        focusedArtistIndex: number;
        focusedPlaylistIndex: number;
    }>>;
    onMatchSong?: (song: LocalSong) => void;
    onPlayNavidromeSong?: (song: any, queue?: any[]) => void;
    onAddNavidromeSongsToQueue?: (songs: any[]) => void;
    onMatchNavidromeSong?: (song: any) => void;
    navidromeFocusedAlbumIndex?: number;
    setNavidromeFocusedAlbumIndex?: (index: number) => void;
    pendingNavidromeSelection?: any;
    onPendingNavidromeSelectionHandled?: () => void;
    onSearchCommitted: (query: string, sourceTab: any, replace?: boolean) => void;
    theme: Theme;
    onOpenSettings?: (initialTab?: 'help' | 'options') => void;
    navidromeEnabled?: boolean;
}

interface SelectedCollection {
    id: string | number;
    name: string;
    coverUrl?: string;
    type: 'playlist' | 'album' | 'radio' | 'local-album' | 'local-playlist' | 'navidrome-album' | 'navidrome-playlist';
    subtitle?: string;
}

export const Grid3D: React.FC<Grid3DProps> = (props) => {
    const {
        onPlaySong,
        onBackToPlayer,
        onRefreshUser,
        user,
        playlists,
        cloudPlaylist = null,
        currentTrack,
        onSelectLocalAlbum,
        onSelectLocalArtist,
        localSongs,
        localPlaylists,
        onRefreshLocalSongs,
        onPlayLocalSong,
        onAddLocalSongToQueue,
        localMusicState,
        setLocalMusicState,
        onMatchSong,
        onPlayNavidromeSong,
        onAddNavidromeSongsToQueue,
        onMatchNavidromeSong,
        navidromeFocusedAlbumIndex = 0,
        setNavidromeFocusedAlbumIndex,
        pendingNavidromeSelection = null,
        onPendingNavidromeSelectionHandled,
        onSearchCommitted,
        theme,
        onOpenSettings,
        navidromeEnabled = false,
    } = props;

    const { t } = useTranslation();
    const isDaylight = useSettingsUiStore(state => state.isDaylight);
    const {
        homeViewTab,
        setHomeViewTab,
        searchQuery,
        setSearchQuery,
        isSearching,
        submitSearch,
    } = useSearchNavigationStore(useShallow(state => ({
        homeViewTab: state.homeViewTab,
        setHomeViewTab: state.setHomeViewTab,
        searchQuery: state.searchQuery,
        setSearchQuery: state.setSearchQuery,
        isSearching: state.isSearching,
        submitSearch: state.submitSearch,
    })));

    const isNeteaseTab = homeViewTab === 'playlist' || homeViewTab === 'albums' || homeViewTab === 'radio';
    
    // UI Interaction states
    const [isSliding, setIsSliding] = useState(false);
    const slidingTimeoutRef = useRef<any>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);

    // Detail Grid states
    const [selectedCollection, setSelectedCollection] = useState<SelectedCollection | null>(null);
    const [loadingTracks, setLoadingTracks] = useState(false);
    const [gridTracks, setGridTracks] = useState<SongResult[]>([]);
    const [showCollectionGrid, setShowCollectionGrid] = useState(false);

    // Netease details
    const [favoriteAlbums, setFavoriteAlbums] = useState<any[]>([]);
    const [loadingAlbums, setLoadingAlbums] = useState(false);
    const [radioItems, setRadioItems] = useState<any[]>([]);
    const [loadingRadio, setLoadingRadio] = useState(false);

    // Trigger sliding fade indicators
    const handleSliding = () => {
        setIsSliding(true);
        if (slidingTimeoutRef.current) clearTimeout(slidingTimeoutRef.current);
        slidingTimeoutRef.current = setTimeout(() => {
            setIsSliding(false);
        }, 800);
    };

    // Mouse drag-to-scroll implementation
    const isDraggingRef = useRef(false);
    const startXRef = useRef(0);
    const scrollLeftRef = useRef(0);
    const dragDistanceRef = useRef(0);

    const handleMouseDown = (e: React.MouseEvent) => {
        if (!scrollContainerRef.current) return;
        if (e.button !== 0) return; // Only left click
        isDraggingRef.current = true;
        startXRef.current = e.pageX - scrollContainerRef.current.offsetLeft;
        scrollLeftRef.current = scrollContainerRef.current.scrollLeft;
        dragDistanceRef.current = 0;
        
        scrollContainerRef.current.style.scrollBehavior = 'auto';
        scrollContainerRef.current.style.scrollSnapType = 'none';
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (!isDraggingRef.current || !scrollContainerRef.current) return;
        e.preventDefault();
        const x = e.pageX - scrollContainerRef.current.offsetLeft;
        const walk = (x - startXRef.current) * 1.5;
        dragDistanceRef.current = Math.abs(walk);
        scrollContainerRef.current.scrollLeft = scrollLeftRef.current - walk;
        handleSliding();
    };

    const handleMouseUpOrLeave = () => {
        if (!isDraggingRef.current) return;
        isDraggingRef.current = false;
        if (scrollContainerRef.current) {
            scrollContainerRef.current.style.scrollBehavior = '';
            scrollContainerRef.current.style.scrollSnapType = '';
        }
    };

    // Clean sliding timeout
    useEffect(() => {
        return () => {
            if (slidingTimeoutRef.current) clearTimeout(slidingTimeoutRef.current);
        };
    }, []);

    // Load favorite albums and recommendations
    useEffect(() => {
        if (homeViewTab === 'albums' && favoriteAlbums.length === 0 && user) {
            fetchFavoriteAlbums();
        }
        if (homeViewTab === 'radio' && radioItems.length === 0 && user) {
            fetchRadioItems();
        }
    }, [homeViewTab, user]);

    const fetchFavoriteAlbums = async () => {
        setLoadingAlbums(true);
        try {
            let allAlbums: any[] = [];
            let offset = 0;
            const limit = 50;
            let hasMore = true;

            while (hasMore) {
                const res = await neteaseApi.getFavoriteAlbums(limit, offset);
                if (res.data) {
                    allAlbums = [...allAlbums, ...res.data];
                }
                hasMore = res.hasMore;
                offset += limit;
            }
            setFavoriteAlbums(allAlbums);
        } catch (e) {
            console.error('[Grid3D] Failed to fetch favorite albums', e);
        } finally {
            setLoadingAlbums(false);
        }
    };

    const fetchRadioItems = async () => {
        setLoadingRadio(true);
        try {
            const fmRes = await neteaseApi.getPersonalFm();
            let fmCoverUrl = '';
            if (fmRes.data && fmRes.data.length > 0) {
                fmCoverUrl = fmRes.data[0].album?.picUrl || fmRes.data[0].al?.picUrl || '';
            }

            const fmItem = {
                id: 'personal_fm',
                name: '私人FM',
                coverUrl: fmCoverUrl,
                description: 'Personal FM',
                isFm: true,
            };

            const recRes = await neteaseApi.getDailyRecommendPlaylists();
            let recItems: any[] = [];
            if (recRes.recommend) {
                recItems = recRes.recommend.slice(0, 30).map((r: any) => ({
                    id: r.id,
                    name: r.name,
                    coverUrl: r.picUrl,
                    trackCount: r.trackCount,
                    description: r.creator?.nickname || '每日推荐'
                }));
            }
            setRadioItems([fmItem, ...recItems]);
        } catch (e) {
            console.error('[Grid3D] Failed to fetch radio items', e);
        } finally {
            setLoadingRadio(false);
        }
    };

    // Filter cloud and local playlists
    const playlistCards = useMemo(() => {
        const base = cloudPlaylist
            ? (playlists.length > 0
                ? [playlists[0], cloudPlaylist, ...playlists.slice(1)]
                : [cloudPlaylist])
            : playlists;
        return base.map(p => ({
            id: p.id,
            name: p.name,
            coverUrl: p.coverImgUrl || p.coverUrl,
            trackCount: p.trackCount,
            description: p.creator?.nickname || '歌单',
            type: 'playlist' as const
        }));
    }, [playlists, cloudPlaylist]);

    const albumCards = useMemo(() => {
        return favoriteAlbums.map(a => ({
            id: a.id,
            name: a.name,
            coverUrl: a.picUrl,
            trackCount: a.size,
            description: a.artists?.[0]?.name || '未知歌手',
            type: 'album' as const
        }));
    }, [favoriteAlbums]);

    const radioCards = useMemo(() => {
        return radioItems.map(r => ({
            id: r.id,
            name: r.name,
            coverUrl: r.coverUrl,
            trackCount: r.trackCount,
            description: r.description || '电台',
            type: r.isFm ? 'radio' as const : 'playlist' as const
        }));
    }, [radioItems]);

    // Active tab list items mapping
    const currentDesktopItems = useMemo(() => {
        if (homeViewTab === 'playlist') return playlistCards;
        if (homeViewTab === 'albums') return albumCards;
        if (homeViewTab === 'radio') return radioCards;
        return [];
    }, [homeViewTab, playlistCards, albumCards, radioCards]);

    // Load track context mapping for grid selection details
    const handleSelectCollectionCard = async (card: { id: string | number; name: string; coverUrl?: string; type: string; description?: string }) => {
        setSelectedCollection({
            id: card.id,
            name: card.name,
            coverUrl: card.coverUrl,
            type: card.type as any,
            subtitle: card.description
        });
        setLoadingTracks(true);
        setGridTracks([]);

        try {
            if (card.type === 'radio' && card.id === 'personal_fm') {
                const fmRes = await neteaseApi.getPersonalFm();
                if (fmRes.data) {
                    setGridTracks(fmRes.data);
                }
            } else if (card.type === 'album') {
                const res = await neteaseApi.getAlbum(Number(card.id));
                if (res.code === 200) {
                    const enriched = res.songs.map((song: SongResult) => ({
                        ...song,
                        al: { id: res.album.id, name: res.album.name, picUrl: song.al?.picUrl || res.album.picUrl },
                        album: { id: res.album.id, name: res.album.name, picUrl: song.album?.picUrl || res.album.picUrl }
                    }));
                    setGridTracks(enriched);
                }
            } else if (card.type === 'playlist') {
                const res = await neteaseApi.getPlaylistTracks(Number(card.id), 150, 0);
                if (res.songs) {
                    setGridTracks(res.songs);
                }
            }
        } catch (error) {
            console.error('[Grid3D] Failed to load collection tracks:', error);
        } finally {
            setLoadingTracks(false);
        }
    };

    // Generic track click playback bridge
    const handleSelectTrack = (track: SongResult, queue: SongResult[]) => {
        if (track.isNavidrome) {
            if (onPlayNavidromeSong) {
                onPlayNavidromeSong(track as any, queue as any);
            }
        } else if (track.isLocal) {
            if (onPlayLocalSong) {
                onPlayLocalSong(track as any, queue as any);
            }
        } else {
            onPlaySong(track, queue);
        }
    };

    // Search committed callback
    const handleSearch = async (e?: React.FormEvent) => {
        e?.preventDefault();
        const query = searchQuery.trim();
        if (!query) return;

        const didSearch = await submitSearch({
            query,
            sourceTab: homeViewTab,
            deps: {
                localSongs,
                t: (key, fallback) => t(key, fallback ?? ''),
            },
        });

        if (didSearch) {
            onSearchCommitted(query, homeViewTab);
        }
    };

    const isSearchingActive = isSearching;

    // Background style mappings
    const mainBg = isDaylight ? 'bg-white/40' : 'bg-black/20';
    const inputBg = isDaylight ? 'bg-black/5 focus:bg-black/10' : 'bg-white/5 focus:bg-white/10';
    const navPillBg = isDaylight ? 'bg-black/5' : 'bg-white/10';
    const navPillInactiveText = isDaylight ? 'text-black/60 hover:text-black' : 'text-white/60 hover:text-white';
    const activeTabBg = isDaylight ? 'text-black font-bold' : 'text-black';

    // Desktop Polaroid Layout parameters
    const cardSpacing = 'px-6';

    return (
        <div className={`relative w-full h-full flex flex-col font-sans overflow-hidden ${mainBg} pointer-events-auto backdrop-blur-sm`}>
            
            {/* Main Header Container (Fades out when sliding/interacting) */}
            <div className={`transition-opacity duration-500 ease-in-out z-20 ${isSliding ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
                <div className="grid grid-cols-2 md:grid-cols-3 items-center w-full max-w-7xl mx-auto p-4 md:p-8 gap-y-4 md:gap-y-0">
                    {/* Left title and settings */}
                    <div className="flex items-center justify-start">
                        <h1 className="text-2xl font-bold tracking-tight opacity-90 flex items-center gap-3">
                            Folia
                        </h1>
                        <button
                            onClick={() => onOpenSettings?.('help')}
                            className="p-2 rounded-full hover:bg-white/10 opacity-40 hover:opacity-100 transition-all ml-4"
                            title="Help & Options"
                        >
                            <Settings size={20} style={{ color: 'var(--text-primary)' }} />
                        </button>
                    </div>

                    {/* Center Tab Switcher */}
                    <div className="flex justify-center col-span-2 md:col-span-1">
                        <div className={`relative ${navPillBg} backdrop-blur-md p-1 rounded-full scale-90 md:scale-100 origin-center`}>
                            <div className="inline-flex items-center gap-0">
                                {[
                                    { key: 'playlist', label: t('home.playlists') },
                                    { key: 'radio', label: t('home.radio') || '电台' },
                                    { key: 'albums', label: t('home.albums') || '专辑' },
                                    { key: 'local', label: t('localMusic.folder') },
                                    ...(navidromeEnabled ? [{ key: 'navidrome', label: t('navidrome.title') || 'Navidrome' }] : []),
                                ].map((tab) => {
                                    const isActive = homeViewTab === tab.key;
                                    return (
                                        <button
                                            key={tab.key}
                                            onClick={() => setHomeViewTab(tab.key as any)}
                                            className={`relative inline-flex items-center justify-center px-4 py-1.5 rounded-full text-xs md:text-sm font-medium transition-colors duration-300 whitespace-nowrap ${isActive ? activeTabBg : navPillInactiveText}`}
                                        >
                                            {isActive && (
                                                <motion.span
                                                    layoutId="home-active-tab-pill-desktop"
                                                    className="absolute inset-0 rounded-full bg-white shadow-sm"
                                                    transition={{ type: 'spring', stiffness: 460, damping: 36, mass: 0.9 }}
                                                />
                                            )}
                                            <span className="relative z-10">{tab.label}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>

                    {/* Right Search Bar */}
                    <div className="flex justify-end">
                        <form onSubmit={handleSearch} className="relative w-full md:w-56 transition-all focus-within:md:w-72">
                            {isSearchingActive ? (
                                <Loader2 className="absolute left-3 top-1/2 w-4 h-4 animate-spin opacity-40 -mt-2" />
                            ) : (
                                <Search
                                    className="absolute left-3 top-1/2 -translate-y-1/2 opacity-40 w-4 h-4 cursor-pointer hover:opacity-100 transition-opacity"
                                    onClick={() => handleSearch()}
                                />
                            )}
                            <input
                                type="text"
                                placeholder={homeViewTab === 'local' ? t('home.searchLocal') : homeViewTab === 'navidrome' ? t('home.searchNavidrome') : t('home.searchDatabase')}
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                                className={`w-full ${inputBg} border border-white/10 rounded-full py-2 pl-10 pr-4 text-sm focus:outline-none focus:border-white/20 transition-all placeholder:text-current placeholder:opacity-40`}
                                style={{ color: 'var(--text-primary)' }}
                            />
                        </form>
                    </div>
                </div>
            </div>

            {/* Desktop Canvas Surface */}
            <div className="flex-1 min-h-0 flex flex-col items-center justify-center relative">
                {isNeteaseTab ? (
                    <div className="w-full flex-1 flex flex-col justify-center relative min-h-0">
                        
                        {/* Map Button (GridView Launcher) */}
                        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10">
                            <motion.button
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                                onClick={() => setShowCollectionGrid(true)}
                                className="px-4 py-2 rounded-full flex items-center gap-2 text-xs font-semibold shadow-lg backdrop-blur-md transition-all border border-white/10"
                                style={{
                                    backgroundColor: isDaylight ? 'rgba(255,255,255,0.7)' : 'rgba(25,25,25,0.7)',
                                    color: 'var(--text-primary)'
                                }}
                            >
                                <MapIcon size={14} />
                                <span>{t('home.allAlbums') || '全部'}</span>
                            </motion.button>
                        </div>

                        {/* Horizontal Polaroid Slider Container */}
                        <div 
                            ref={scrollContainerRef}
                            onScroll={handleSliding}
                            onTouchStart={handleSliding}
                            onTouchMove={handleSliding}
                            onWheel={handleSliding}
                            onMouseDown={handleMouseDown}
                            onMouseMove={handleMouseMove}
                            onMouseUp={handleMouseUpOrLeave}
                            onMouseLeave={handleMouseUpOrLeave}
                            className="w-full flex items-center overflow-x-auto overflow-y-hidden py-16 scroll-smooth custom-scrollbar snap-x snap-mandatory cursor-grab active:cursor-grabbing"
                            style={{ scrollbarWidth: 'none' }}
                        >
                            <div className="flex px-[40vw] gap-12">
                                {currentDesktopItems.map((item, idx) => {
                                    // Stagger photo rotations organically to mimic real sheets lying on desk
                                    const rotateDeg = (idx % 2 === 0 ? 3.5 : -3.5) * (idx % 3 === 0 ? 0.4 : 1.0);
                                    
                                    const polaroidClass = isDaylight
                                        ? 'bg-[#faf9f6] text-zinc-900 border-zinc-200/50 shadow-lg'
                                        : 'bg-zinc-900 text-zinc-100 border-zinc-800/80 shadow-2xl';

                                    return (
                                        <motion.div
                                            key={item.id}
                                            className="snap-center shrink-0 cursor-pointer pointer-events-auto select-none"
                                            whileHover={{ 
                                                scale: 1.05, 
                                                y: -10, 
                                                rotate: 0,
                                                transition: { type: 'spring', stiffness: 300, damping: 20 }
                                            }}
                                            onClick={() => {
                                                if (dragDistanceRef.current < 8) {
                                                    handleSelectCollectionCard(item);
                                                }
                                            }}
                                        >
                                            <div 
                                                className={`w-64 rounded-xl border p-4 flex flex-col items-center transition-all ${polaroidClass}`}
                                                style={{ 
                                                    transform: `rotate(${rotateDeg}deg)`,
                                                    transformOrigin: 'center center'
                                                }}
                                            >
                                                {/* Square Album Cover */}
                                                <div className="w-full aspect-square rounded-lg overflow-hidden bg-zinc-800/20 relative shadow-inner mb-4 flex items-center justify-center">
                                                    {item.coverUrl ? (
                                                        <img src={item.coverUrl} alt={item.name} className="w-full h-full object-cover pointer-events-none select-none" />
                                                    ) : (
                                                        <Disc size={64} className="opacity-20" />
                                                    )}
                                                </div>

                                                {/* Details White Border Label */}
                                                <div className="w-full text-left pt-2 min-w-0">
                                                    <h3 className="font-bold text-sm truncate max-w-full tracking-tight">
                                                        {item.name}
                                                    </h3>
                                                    <p className="text-xs opacity-50 truncate max-w-full mt-1 font-medium">
                                                        {item.description}
                                                    </p>
                                                    {item.trackCount !== undefined && (
                                                        <span className="text-[10px] font-mono opacity-30 mt-2 block">
                                                            {item.trackCount} {t('playlist.tracks') || 'songs'}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        </motion.div>
                                    );
                                })}
                            </div>
                        </div>

                    </div>
                ) : homeViewTab === 'local' ? (
                    <div className="w-full h-full flex-1">
                        <LocalMusicView
                            {...props}
                            theme={theme}
                            isDaylight={isDaylight}
                            hasFloatingPlayer={Boolean(currentTrack)}
                        />
                    </div>
                ) : (
                    <div className="w-full h-full flex-1">
                        <NavidromeMusicView
                            onPlaySong={onPlayNavidromeSong || (() => { })}
                            onAddSongsToQueue={onAddNavidromeSongsToQueue}
                            onOpenSettings={() => onOpenSettings?.('help')}
                            onMatchSong={onMatchNavidromeSong}
                            theme={theme}
                            isDaylight={isDaylight}
                            focusedAlbumIndex={navidromeFocusedAlbumIndex}
                            setFocusedAlbumIndex={setNavidromeFocusedAlbumIndex}
                            externalSelection={pendingNavidromeSelection}
                            hasFloatingPlayer={Boolean(currentTrack)}
                            onExternalSelectionHandled={onPendingNavidromeSelectionHandled}
                        />
                    </div>
                )}
            </div>

            {/* Polaroid Detail Tracks Grid View (GridView) */}
            <AnimatePresence>
                {selectedCollection && (
                    <GridView
                        title={selectedCollection.name}
                        subtitle={selectedCollection.subtitle}
                        items={gridTracks.map((track, idx) => ({
                            id: `${track.id}-${idx}`,
                            name: formatSongName(track),
                            coverUrl: track.al?.picUrl || track.album?.picUrl,
                            subtitle: String(idx + 1).padStart(2, '0'),
                            description: track.ar?.map(a => a.name).join(', '),
                            rawTrack: track
                        }))}
                        mode="tracks"
                        onBack={() => {
                            setSelectedCollection(null);
                            setGridTracks([]);
                        }}
                        onSelectTrack={handleSelectTrack}
                        onAddTrackToQueue={onAddLocalSongToQueue}
                        isLoading={loadingTracks}
                        theme={theme}
                        isDaylight={isDaylight}
                    />
                )}
            </AnimatePresence>

            {/* Collection Grid View (All Items GridView) */}
            <AnimatePresence>
                {showCollectionGrid && (
                    <GridView
                        title={
                            homeViewTab === 'playlist' 
                                ? t('home.playlists') 
                                : homeViewTab === 'albums' 
                                    ? t('home.albums') 
                                    : t('home.radio')
                        }
                        items={currentDesktopItems.map(item => ({
                            id: item.id,
                            name: item.name,
                            coverUrl: item.coverUrl,
                            description: item.description,
                            rawCollection: item
                        }))}
                        mode="collection"
                        onBack={() => setShowCollectionGrid(false)}
                        onSelectCollection={(col) => {
                            setShowCollectionGrid(false);
                            handleSelectCollectionCard(col);
                        }}
                        theme={theme}
                        isDaylight={isDaylight}
                    />
                )}
            </AnimatePresence>

        </div>
    );
};

export default Grid3D;
