import React, { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, useMotionValue, animate, AnimatePresence } from 'framer-motion';
import { ChevronLeft, Disc, Play, Plus, Loader2, Heart, ListPlus, Pencil, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SongResult, Theme } from '../types';
import { isSongMarkedUnavailable, getSongUnavailableTagText, neteaseApi } from '../services/netease';
import { getNavidromeConfig, navidromeApi } from '../services/navidromeService';
import { formatSongName } from '../utils/songNameFormatter';
import { colorWithAlpha } from './visualizer/colorMix';
import { saveToCache, getFromCache, removeFromCache } from '../services/db';
import {
    areIndexListsEqual,
    pixelToCubeCenter,
    resolveVisibleHexIndexes,
    toCubeKey,
    type HexGridCoord,
} from './gridView/hexViewport';

interface GridItem {
    id: string | number;
    name: string;
    coverUrl?: string;
    subtitle?: string;
    description?: string;
    rawTrack?: SongResult;
    rawCollection?: any;
}

interface GridViewProps {
    title: string;
    subtitle?: string;
    items?: GridItem[];
    mode: 'collection' | 'tracks';
    onBack: () => void;
    onSelectTrack?: (track: SongResult, queue: SongResult[]) => void;
    onSelectCollection?: (item: any) => void;
    onAddTrackToQueue?: (track: SongResult) => void;
    isLoading?: boolean;
    theme: Theme;
    isDaylight: boolean;

    // Optional self-contained collection props
    collection?: any;
    onPlayAll?: (songs: SongResult[]) => void;
    onAddAllToQueue?: (songs: SongResult[]) => void;
    onSelectAlbum?: (albumId: number) => void;
    onSelectArtist?: (artistId: number) => void;
    currentUserId?: number | null;
    onPlaylistMutated?: () => Promise<void> | void;
}

interface HexCoord {
    x: number;
    y: number;
    z: number;
}

/**
 * Generates cubic spiral coordinates for a honeycomb grid.
 * Fills rings starting from (0,0,0) outwards to ensure a compact layout.
 */
function getHexCubicSpiral(count: number): HexCoord[] {
    const results: HexCoord[] = [{ x: 0, y: 0, z: 0 }];
    if (count <= 1) return results.slice(0, count);

    const dirs = [
        { x: 0, y: 1, z: -1 }, // down-left
        { x: -1, y: 1, z: 0 },  // left
        { x: -1, y: 0, z: 1 },  // up-left
        { x: 0, y: -1, z: 1 },  // up-right
        { x: 1, y: -1, z: 0 },  // right
        { x: 1, y: 0, z: -1 }   // down-right
    ];

    let radius = 1;
    while (results.length < count) {
        let currX = radius;
        let currY = -radius;
        let currZ = 0;

        for (let side = 0; side < 6; side++) {
            for (let step = 0; step < radius; step++) {
                if (results.length >= count) break;
                currX += dirs[side].x;
                currY += dirs[side].y;
                currZ += dirs[side].z;
                results.push({ x: currX, y: currY, z: currZ });
            }
        }
        radius++;
    }
    return results;
}

/**
 * High-performance memoized Polaroid card — pure visual component.
 * All position/scale/opacity/zIndex/display transforms are managed
 * by a single centralized rAF loop in the parent GridView via wrapper refs.
 * Queue button opacity uses inherited CSS custom property --queue-opacity / --queue-pe.
 */
const PolaroidCard = React.memo<{
    item: GridItem;
    isDaylight: boolean;
    theme: Theme;
    onSelect: () => void;
    onCenter: () => void;
    onAddQueue?: () => void;
    mode: 'collection' | 'tracks';
    t: any;
    cardWidth: number;
    cardHeight: number;
    isEditMode?: boolean;
    onRemoveTrack?: () => void;
    onSelectArtist?: (artistId: number) => void;
    onSelectAlbum?: (albumId: number) => void;
}>(
    ({
        item,
        isDaylight,
        theme,
        onSelect,
        onCenter,
        onAddQueue,
        mode,
        t,
        cardWidth,
        cardHeight,
        isEditMode = false,
        onRemoveTrack,
        onSelectArtist,
        onSelectAlbum
    }) => {
        const isUnavailable = mode === 'tracks' && item.rawTrack ? isSongMarkedUnavailable(item.rawTrack) : false;
        const unavailableTagText = (mode === 'tracks' && item.rawTrack)
            ? getSongUnavailableTagText(item.rawTrack, t('status.songUnavailableTag'))
            : '';

        const cardBg = isDaylight
            ? 'bg-[#faf9f6] text-zinc-900 border-zinc-200/50 shadow-lg'
            : 'bg-zinc-900 text-zinc-100 border-zinc-800/80 shadow-2xl';

        const cardBorderHover = isDaylight
            ? 'hover:border-zinc-300'
            : 'hover:border-zinc-700';

        return (
            <div
                className={`rounded-xl p-3 flex flex-col items-center border transition-shadow duration-300 ${cardBg} ${cardBorderHover}`}
                style={{
                    width: cardWidth,
                    minHeight: cardHeight,
                    height: 'auto',
                    animation: isEditMode && !isUnavailable
                        ? 'polaroid-shake 0.28s ease-in-out infinite'
                        : 'none',
                }}
                onClick={(e) => {
                    if (isEditMode) {
                        e.stopPropagation();
                        return;
                    }
                    onCenter();
                }}
            >
                {/* Square Polaroid Photo Area */}
                <div className="w-full aspect-square rounded-lg overflow-hidden bg-zinc-200/60 dark:bg-zinc-800/60 relative shadow-inner flex items-center justify-center shrink-0">
                    {item.coverUrl ? (
                        <>
                            <img
                                src={item.coverUrl}
                                alt={item.name}
                                loading="lazy"
                                decoding="async"
                                ref={(el) => {
                                    if (el && el.complete) {
                                        el.style.opacity = isUnavailable ? '0.3' : '1';
                                        const placeholder = el.nextElementSibling as HTMLElement;
                                        if (placeholder) {
                                            placeholder.style.opacity = '0';
                                            placeholder.style.display = 'none';
                                        }
                                    }
                                }}
                                onLoad={(e) => {
                                    const img = e.currentTarget;
                                    img.style.opacity = isUnavailable ? '0.3' : '1';
                                    const placeholder = img.nextElementSibling as HTMLElement;
                                    if (placeholder) {
                                        placeholder.style.opacity = '0';
                                        setTimeout(() => {
                                            placeholder.style.display = 'none';
                                        }, 350);
                                    }
                                }}
                                className="w-full h-full object-cover transition-opacity duration-350 pointer-events-none select-none opacity-0"
                            />
                            <div className="absolute inset-0 bg-zinc-300/40 dark:bg-zinc-700/40 transition-opacity duration-350 flex items-center justify-center">
                                <Disc size={48} className="opacity-20 animate-spin" style={{ animationDuration: '3s', color: 'var(--text-primary)' }} />
                            </div>
                        </>
                    ) : (
                        <div className="absolute inset-0 bg-zinc-300/40 dark:bg-zinc-700/40 flex items-center justify-center">
                            <Disc size={48} className="opacity-20" style={{ color: 'var(--text-primary)' }} />
                        </div>
                    )}

                    {/* Unavailable Mask/Badge */}
                    {isUnavailable && (
                        <div className="absolute inset-0 bg-black/40 flex items-center justify-center p-2 text-center z-10">
                            <span className="text-[10px] bg-red-500/80 text-white font-bold px-2 py-1 rounded-full uppercase tracking-wider">
                                {unavailableTagText || 'UNAVAILABLE'}
                            </span>
                        </div>
                    )}

                    {/* Delete button overlay for Edit Mode */}
                    <AnimatePresence>
                        {isEditMode && onRemoveTrack && !isUnavailable && (
                            <motion.button
                                key="delete-btn"
                                initial={{ scale: 0, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                exit={{ scale: 0, opacity: 0 }}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onRemoveTrack();
                                }}
                                className="absolute top-2 right-2 w-7 h-7 rounded-full bg-red-500 hover:bg-red-600 text-white flex items-center justify-center shadow-lg border border-white/20 z-[60] active:scale-90 transition-transform cursor-pointer"
                            >
                                <X size={14} className="stroke-[3]" />
                            </motion.button>
                        )}
                    </AnimatePresence>
                </div>

                {/* Bottom Polaroid Frame Label Details */}
                <div className="w-full flex-1 flex flex-col justify-between pt-3 text-left min-w-0">
                    <div className="space-y-1 mb-2">
                        {/* Index + Title */}
                        <div className="text-xs font-bold tracking-tight opacity-90 max-w-full line-clamp-2 whitespace-normal break-words">
                            {item.subtitle ? `${item.subtitle}. ` : ''}{item.name}
                        </div>
                        {/* Clickable Artists */}
                        {item.description && (
                            <div className="text-[10px] opacity-55 max-w-full font-medium line-clamp-1 whitespace-normal break-words">
                                {mode === 'tracks' && onSelectArtist && item.rawTrack?.ar ? (
                                    <span className="flex gap-1 flex-wrap">
                                        {item.rawTrack.ar.map((artist, idx) => (
                                            <span
                                                key={artist.id}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    if (artist.id) onSelectArtist(artist.id);
                                                }}
                                                className="hover:underline hover:opacity-100 cursor-pointer text-current font-semibold"
                                            >
                                                {artist.name}{idx < item.rawTrack.ar.length - 1 ? ',' : ''}
                                            </span>
                                        ))}
                                    </span>
                                ) : (
                                    item.description
                                )}
                            </div>
                        )}
                    </div>

                    <div className="flex items-end justify-between mt-auto pt-1.5 w-full">
                        {/* Left: Clickable Album name & Duration */}
                        <div className="flex flex-col min-w-0 flex-1 pr-2">
                            {mode === 'tracks' && item.rawTrack && (
                                <>
                                    <span
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            const alId = item.rawTrack?.al?.id || item.rawTrack?.album?.id;
                                            if (alId && onSelectAlbum) {
                                                onSelectAlbum(alId);
                                            }
                                        }}
                                        className="text-[9px] opacity-35 font-mono line-clamp-1 whitespace-normal break-words max-w-full hover:underline hover:opacity-85 cursor-pointer"
                                    >
                                        {item.rawTrack.al?.name || item.rawTrack.album?.name || ''}
                                    </span>
                                    <span className="text-[9px] opacity-35 font-mono">
                                        {(() => {
                                            const dt = item.rawTrack.dt || item.rawTrack.duration || 0;
                                            const min = Math.floor(dt / 60000);
                                            const sec = Math.floor((dt % 60000) / 1000);
                                            return `${min}:${sec < 10 ? '0' : ''}${sec}`;
                                        })()}
                                    </span>
                                </>
                            )}
                        </div>

                        {/* Right: Buttons in bottom right corner */}
                        <div className="flex items-center gap-1.5 shrink-0">
                            {!isUnavailable && !isEditMode && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onSelect();
                                    }}
                                    style={{
                                        opacity: 'var(--play-opacity, 0)',
                                        pointerEvents: 'var(--play-pe, none)' as any,
                                        transform: 'scale(var(--play-scale, 0.8))',
                                        transition: 'opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1), transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), background-color 0.2s ease, color 0.2s ease',
                                    }}
                                    className="w-9 h-9 rounded-full bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-800/20 dark:hover:bg-zinc-100/20 text-current flex items-center justify-center shadow-sm pointer-events-auto z-10"
                                    title={t('playlist.play') || 'Play'}
                                >
                                    <Play size={15} fill="currentColor" className="ml-0.5" />
                                </button>
                            )}
                            {mode === 'tracks' && onAddQueue && !isUnavailable && !isEditMode && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onAddQueue();
                                    }}
                                    style={{ opacity: 'var(--queue-opacity, 1)' as any, pointerEvents: 'var(--queue-pe, auto)' as any }}
                                    className="w-9 h-9 rounded-full bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-800/20 dark:hover:bg-zinc-100/20 text-current flex items-center justify-center transition-colors shadow-sm pointer-events-auto"
                                    title={t('navidrome.addToQueue') || 'Add to Queue'}
                                >
                                    <Plus size={15} />
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    },
    (prev, next) => {
        return (
            prev.item.id === next.item.id &&
            prev.item.name === next.item.name &&
            prev.item.coverUrl === next.item.coverUrl &&
            prev.isDaylight === next.isDaylight &&
            prev.theme === next.theme &&
            prev.mode === next.mode &&
            prev.cardWidth === next.cardWidth &&
            prev.cardHeight === next.cardHeight &&
            prev.isEditMode === next.isEditMode
        );
    }
);

export const GridView: React.FC<GridViewProps> = ({
    title,
    subtitle,
    items = [],
    mode,
    onBack,
    onSelectTrack,
    onSelectCollection,
    onAddTrackToQueue,
    isLoading = false,
    theme,
    isDaylight,
    collection,
    onPlayAll,
    onAddAllToQueue,
    onSelectAlbum,
    onSelectArtist,
    currentUserId,
    onPlaylistMutated
}) => {
    const { t } = useTranslation();
    const containerRef = useRef<HTMLDivElement>(null);
    const [focusedIndex, setFocusedIndex] = useState(0);
    const focusedIndexRef = useRef(0);
    const lastUpdateRef = useRef(0);
    const pendingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const isDraggingRef = useRef(false);
    const pendingBackgroundTracksRef = useRef<SongResult[] | null>(null);
    const pendingBackgroundOffsetRef = useRef(0);

    // Track responsive container size to scale grid card dimensions dynamically
    const [containerSize, setContainerSize] = useState(() => {
        if (typeof window === 'undefined') {
            return { width: 0, height: 0 };
        }
        return { width: window.innerWidth, height: window.innerHeight };
    });

    useEffect(() => {
        const element = containerRef.current;
        if (!element) return;

        const updateContainerSize = () => {
            const nextWidth = element.clientWidth;
            const nextHeight = element.clientHeight;

            setContainerSize((prev) => (
                prev.width === nextWidth && prev.height === nextHeight
                    ? prev
                    : { width: nextWidth, height: nextHeight }
            ));
        };

        updateContainerSize();

        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', updateContainerSize);
            return () => window.removeEventListener('resize', updateContainerSize);
        }

        const observer = new ResizeObserver(() => {
            updateContainerSize();
        });
        observer.observe(element);

        return () => observer.disconnect();
    }, []);

    // Layout values for different container size breakpoints
    const layoutConfig = useMemo(() => {
        const width = containerSize.width;
        if (width < 768) {
            // Mobile/Narrow
            return {
                cardWidth: 180,
                cardHeight: 280,
                spacingX: 205,
                spacingY: 270,
                maxDistance: 420,
                lodStart: 280,
                lodEnd: 320,
            };
        } else if (width < 1440) {
            // Desktop
            return {
                cardWidth: 220,
                cardHeight: 330,
                spacingX: 250,
                spacingY: 320,
                maxDistance: 500,
                lodStart: 340,
                lodEnd: 385,
            };
        } else if (width < 2000) {
            // Large Desktop
            return {
                cardWidth: 250,
                cardHeight: 375,
                spacingX: 285,
                spacingY: 365,
                maxDistance: 580,
                lodStart: 400,
                lodEnd: 450,
            };
        } else {
            // Ultra Desktop
            return {
                cardWidth: 280,
                cardHeight: 420,
                spacingX: 320,
                spacingY: 410,
                maxDistance: 660,
                lodStart: 450,
                lodEnd: 510,
            };
        }
    }, [containerSize.width]);

    // Dynamically calculate visible clipping radius centered on (0,0) viewport coordinates
    const clipRadius = useMemo(() => {
        const { width, height } = containerSize;
        const { cardWidth, cardHeight } = layoutConfig;
        const viewportRadius = Math.sqrt((width / 2) ** 2 + (height / 2) ** 2);
        const cardRadius = Math.sqrt(cardWidth ** 2 + cardHeight ** 2) / 2;
        return viewportRadius + cardRadius + 200; // 200px buffer to prevent visual pop-in during fast drags
    }, [containerSize, layoutConfig]);

    const renderRadius = useMemo(() => (
        clipRadius + Math.max(layoutConfig.spacingX, layoutConfig.spacingY) * 1.5
    ), [clipRadius, layoutConfig.spacingX, layoutConfig.spacingY]);

    const renderRing = useMemo(() => (
        Math.ceil(renderRadius / Math.min(layoutConfig.spacingX, layoutConfig.spacingY)) + 1
    ), [layoutConfig.spacingX, layoutConfig.spacingY, renderRadius]);

    // Self-loading track states for tracks mode
    const [tracks, setTracks] = useState<SongResult[]>([]);
    const [loading, setLoading] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    const [offset, setOffset] = useState(0);
    const [isEditMode, setIsEditMode] = useState(false);
    const [showCutInPanel, setShowCutInPanel] = useState(false);

    useEffect(() => {
        focusedIndexRef.current = focusedIndex;
    }, [focusedIndex]);

    const playableTracks = useMemo(() => tracks.filter(track => !isSongMarkedUnavailable(track)), [tracks]);
    const CACHE_SCHEMA_VERSION = 3;

    const isCloudDrive = collection ? (collection.specialType === 'cloud' || Number(collection.id) === -100) : false;
    const CACHE_KEY = collection ? (isCloudDrive
        ? `playlist_tracks_cloud_${currentUserId ?? 'anonymous'}`
        : `playlist_tracks_${collection.id}`) : '';

    const flushPendingBackgroundTracks = useCallback(() => {
        const pendingTracks = pendingBackgroundTracksRef.current;
        if (!pendingTracks) return;

        pendingBackgroundTracksRef.current = null;
        setTracks(pendingTracks);
        setOffset(pendingBackgroundOffsetRef.current);
    }, []);

    const loadTracks = async (reset = false) => {
        if (!collection || loading || (!hasMore && !reset)) return;
        setLoading(true);

        try {
            const currentOffset = reset ? 0 : offset;
            const targetTime = collection.trackUpdateTime || collection.updateTime || 0;

            if (reset) {
                pendingBackgroundTracksRef.current = null;
                pendingBackgroundOffsetRef.current = 0;
                const cached = await getFromCache<{ tracks: SongResult[], snapshotTime: number; schemaVersion?: number; } | SongResult[]>(CACHE_KEY);

                let cachedTracks: SongResult[] = [];
                let cachedTime = 0;
                let cachedSchemaVersion = 0;

                if (Array.isArray(cached)) {
                    cachedTracks = cached;
                } else if (cached && cached.tracks) {
                    cachedTracks = cached.tracks;
                    cachedTime = cached.snapshotTime;
                    cachedSchemaVersion = cached.schemaVersion ?? 0;
                }

                if (cachedTracks.length > 0 && targetTime > 0 && cachedTime === targetTime && cachedSchemaVersion === CACHE_SCHEMA_VERSION) {
                    setTracks(cachedTracks);
                    setOffset(cachedTracks.length);
                    setLoading(false);
                    setHasMore(cachedTracks.length < (collection.trackCount || collection.size || 0));
                    return;
                }

                let responseTracks: SongResult[] = [];
                let hasMoreSync = false;

                if (collection.type === 'album') {
                    const res = await neteaseApi.getAlbum(Number(collection.id));
                    if (res.code === 200 && res.songs) {
                        responseTracks = res.songs.map((song: SongResult) => ({
                            ...song,
                            al: { id: res.album.id, name: res.album.name, picUrl: song.al?.picUrl || res.album.picUrl },
                            album: { id: res.album.id, name: res.album.name, picUrl: song.album?.picUrl || res.album.picUrl }
                        }));
                    }
                } else if (collection.type === 'radio' && collection.id === 'personal_fm') {
                    const fmRes = await neteaseApi.getPersonalFm();
                    if (fmRes.data) {
                        responseTracks = fmRes.data;
                    }
                } else {
                    const res = isCloudDrive
                        ? await neteaseApi.getUserCloud(150, 0)
                        : await neteaseApi.getPlaylistTracks(Number(collection.id), 150, 0);
                    responseTracks = res.songs || [];
                    hasMoreSync = isCloudDrive ? Boolean(res.hasMore) : responseTracks.length < (collection.trackCount || 0);
                }

                if (responseTracks.length > 0) {
                    setTracks(responseTracks);
                    setOffset(responseTracks.length);
                    setHasMore(hasMoreSync);

                    saveToCache(CACHE_KEY, { tracks: responseTracks, snapshotTime: targetTime, schemaVersion: CACHE_SCHEMA_VERSION });

                    if (hasMoreSync) {
                        fetchRemainingTracks(responseTracks, targetTime);
                    }
                } else {
                    setHasMore(false);
                    setTracks([]);
                }
            } else {
                // Manual Load More
                if (collection.type !== 'album' && collection.type !== 'radio') {
                    const res = isCloudDrive
                        ? await neteaseApi.getUserCloud(1000, currentOffset)
                        : await neteaseApi.getPlaylistTracks(Number(collection.id), 1000, currentOffset);
                    if (res.songs && res.songs.length > 0) {
                        setTracks(prev => {
                            const combined = [...prev, ...res.songs];
                            saveToCache(CACHE_KEY, { tracks: combined, snapshotTime: targetTime, schemaVersion: CACHE_SCHEMA_VERSION });
                            return combined;
                        });
                        setOffset(currentOffset + res.songs.length);
                        setHasMore(isCloudDrive ? Boolean(res.hasMore) : res.songs.length === 1000);
                    } else {
                        setHasMore(false);
                    }
                }
            }
        } catch (error) {
            console.error("GridView failed to load tracks:", error);
        } finally {
            setLoading(false);
        }
    };

    const fetchRemainingTracks = async (initialTracks: SongResult[], targetTime: number) => {
        let currentTracks = [...initialTracks];
        let currentOffset = initialTracks.length;
        let fetching = true;
        let safetyCount = 0;
        const MAX_LOOPS = 50;

        const totalTracks = collection.trackCount || collection.size || 0;

        while (fetching && currentTracks.length < totalTracks && safetyCount < MAX_LOOPS) {
            safetyCount++;
            try {
                await new Promise(r => setTimeout(r, 100));
                const res = isCloudDrive
                    ? await neteaseApi.getUserCloud(1000, currentOffset)
                    : await neteaseApi.getPlaylistTracks(Number(collection.id), 1000, currentOffset);
                if (res.songs && res.songs.length > 0) {
                    const newChunk = res.songs;
                    currentTracks = [...currentTracks, ...newChunk];
                    currentOffset += newChunk.length;
                    const nextTracks = [...currentTracks];
                    if (isDraggingRef.current) {
                        pendingBackgroundTracksRef.current = nextTracks;
                        pendingBackgroundOffsetRef.current = currentOffset;
                    } else {
                        setTracks(nextTracks);
                        setOffset(currentOffset);
                    }
                    saveToCache(CACHE_KEY, { tracks: currentTracks, snapshotTime: targetTime, schemaVersion: CACHE_SCHEMA_VERSION });

                    if ((isCloudDrive && !res.hasMore) || (!isCloudDrive && newChunk.length < 1000)) {
                        fetching = false;
                    }
                } else {
                    fetching = false;
                }
            } catch (e) {
                console.error("GridView background sync failed:", e);
                fetching = false;
            }
        }
        setHasMore(false);
    };

    useEffect(() => {
        if (mode === 'tracks' && collection) {
            loadTracks(true);
        }
    }, [collection?.id]);

    const canEditPlaylist = collection && collection.specialType !== 'cloud' && Boolean(currentUserId && collection.creator?.userId === currentUserId);

    const handleRemoveTrack = useCallback(async (trackId: number) => {
        if (!collection) return;
        try {
            const isLiked = collection.isLiked || collection.name === '我喜欢的音乐' || collection.specialType === 'liked';
            if (isLiked) {
                await neteaseApi.likeSong(trackId, false);
            } else {
                await neteaseApi.updatePlaylistTracks('del', collection.id, [trackId]);
            }
            const nextTracks = tracks.filter(track => track.id !== trackId);
            setTracks(nextTracks);
            await saveToCache(CACHE_KEY, { tracks: nextTracks, snapshotTime: Date.now(), schemaVersion: CACHE_SCHEMA_VERSION });
            await removeFromCache(`playlist_detail_${collection.id}`);
            await onPlaylistMutated?.();
        } catch (error) {
            console.error('Failed to remove track in GridView', error);
        }
    }, [collection, tracks, CACHE_KEY, onPlaylistMutated]);

    // Build the grid spiral coordinates mapping using responsive spacing
    const gridItems = useMemo(() => {
        if (mode === 'collection') {
            return items || [];
        }
        return tracks.map((track, idx) => ({
            id: `${track.id}-${idx}`,
            name: formatSongName(track),
            coverUrl: track.al?.picUrl || track.album?.picUrl,
            subtitle: String(idx + 1).padStart(2, '0'),
            description: track.ar?.map(a => a.name).join(', '),
            rawTrack: track
        }));
    }, [mode, items, tracks]);

    // Coordinate motion values mapping grid drags
    const dragX = useMotionValue(0);
    const dragY = useMotionValue(0);

    const baseCoords = useMemo<HexGridCoord[]>(() => {
        const cubics = getHexCubicSpiral(gridItems.length);
        const { spacingX, spacingY } = layoutConfig;
        return cubics.map((cubic, index) => {
            const baseX = cubic.x * spacingX + (cubic.z * spacingX) / 2;
            const baseY = cubic.z * spacingY;
            return { index, cube: cubic, baseX, baseY };
        });
    }, [gridItems.length, layoutConfig]);

    const coordByKey = useMemo(() => {
        return new Map(baseCoords.map((coord) => [toCubeKey(coord.cube), coord.index]));
    }, [baseCoords]);

    const [renderedIndexes, setRenderedIndexes] = useState<number[]>([]);
    const renderedIndexesRef = useRef<number[]>([]);
    const lastVisibleCenterKeyRef = useRef('');

    useEffect(() => {
        renderedIndexesRef.current = renderedIndexes;
    }, [renderedIndexes]);

    const updateRenderedIndexesForViewport = useCallback((dx = dragX.get(), dy = dragY.get(), force = false) => {
        if (baseCoords.length === 0) {
            if (renderedIndexesRef.current.length > 0) {
                renderedIndexesRef.current = [];
                setRenderedIndexes([]);
            }
            return;
        }

        const worldX = -dx;
        const worldY = -dy;
        const centerCube = pixelToCubeCenter(worldX, worldY, layoutConfig.spacingX, layoutConfig.spacingY);
        const centerKey = toCubeKey(centerCube);
        if (!force && centerKey === lastVisibleCenterKeyRef.current) return;

        const nextIndexes = resolveVisibleHexIndexes(
            centerCube,
            renderRing,
            coordByKey,
            baseCoords,
            worldX,
            worldY,
            renderRadius
        );

        const fallbackFocusedIndex = focusedIndexRef.current;
        if (nextIndexes.length === 0 && fallbackFocusedIndex >= 0 && fallbackFocusedIndex < baseCoords.length) {
            nextIndexes.push(fallbackFocusedIndex);
        }

        if (areIndexListsEqual(renderedIndexesRef.current, nextIndexes)) {
            lastVisibleCenterKeyRef.current = centerKey;
            return;
        }

        lastVisibleCenterKeyRef.current = centerKey;
        renderedIndexesRef.current = nextIndexes;
        startTransition(() => {
            setRenderedIndexes(nextIndexes);
        });
    }, [
        baseCoords,
        coordByKey,
        dragX,
        dragY,
        layoutConfig.spacingX,
        layoutConfig.spacingY,
        renderRadius,
        renderRing,
    ]);

    // Keep the active focusedIndex centered when baseCoords changes on resize
    useEffect(() => {
        if (baseCoords.length > 0 && focusedIndex >= 0 && focusedIndex < baseCoords.length) {
            const targetX = -baseCoords[focusedIndex].baseX;
            const targetY = -baseCoords[focusedIndex].baseY;
            dragX.set(targetX);
            dragY.set(targetY);
            updateRenderedIndexesForViewport(targetX, targetY, true);
        }
    }, [baseCoords, updateRenderedIndexesForViewport]);

    // Recenter the viewport on target item coordinate offset
    const centerOnIndex = (index: number, snap = true) => {
        if (index < 0 || index >= baseCoords.length) return;
        const targetX = -baseCoords[index].baseX;
        const targetY = -baseCoords[index].baseY;

        if (pendingTimeoutRef.current) {
            clearTimeout(pendingTimeoutRef.current);
            pendingTimeoutRef.current = null;
        }
        setFocusedIndex(index);
        focusedIndexRef.current = index;
        lastUpdateRef.current = performance.now();
        updateRenderedIndexesForViewport(targetX, targetY, true);

        if (snap) {
            animate(dragX, targetX, { type: 'spring', stiffness: 220, damping: 28 });
            animate(dragY, targetY, { type: 'spring', stiffness: 220, damping: 28 });
        } else {
            dragX.set(targetX);
            dragY.set(targetY);
        }
    };

    // Center on the first item initially
    useEffect(() => {
        if (gridItems.length > 0) {
            centerOnIndex(0, false);
        }
    }, [gridItems.length]);

    useEffect(() => {
        updateRenderedIndexesForViewport(dragX.get(), dragY.get(), true);
    }, [dragX, dragY, updateRenderedIndexesForViewport]);

    // Memoize only the nearby card set so React keeps heavy image/button trees out of the drag hot path
    const memoizedCards = useMemo(() => {
        return renderedIndexes.map((idx) => {
            const item = gridItems[idx];
            const coord = baseCoords[idx];
            if (!item || !coord) return null;

            return (
                <div
                    key={item.id}
                    ref={(el) => { cardWrapperRefs.current[idx] = el; }}
                    className="absolute select-none pointer-events-auto"
                    style={{
                        transformOrigin: 'center center',
                        willChange: 'transform, opacity',
                    }}
                >
                    <PolaroidCard
                        item={item}
                        isDaylight={isDaylight}
                        theme={theme}
                        mode={mode}
                        t={t}
                        cardWidth={layoutConfig.cardWidth}
                        cardHeight={layoutConfig.cardHeight}
                        isEditMode={isEditMode}
                        onRemoveTrack={() => {
                            if (item.rawTrack) handleRemoveTrack(item.rawTrack.id);
                        }}
                        onSelectArtist={onSelectArtist}
                        onSelectAlbum={onSelectAlbum}
                        onSelect={() => {
                            if (mode === 'tracks' && onSelectTrack && item.rawTrack) {
                                onSelectTrack(item.rawTrack, tracks);
                            } else if (mode === 'collection' && onSelectCollection) {
                                onSelectCollection(item.rawCollection || item);
                            }
                        }}
                        onCenter={() => {
                            if (isDraggingRef.current) return;
                            centerOnIndex(idx, true);
                        }}
                        onAddQueue={() => {
                            if (mode === 'tracks' && onAddTrackToQueue && item.rawTrack) {
                                onAddTrackToQueue(item.rawTrack);
                            }
                        }}
                    />
                </div>
            );
        });
    }, [
        renderedIndexes,
        gridItems,
        baseCoords,
        isDaylight,
        theme,
        mode,
        t,
        layoutConfig.cardWidth,
        layoutConfig.cardHeight,
        isEditMode,
        tracks,
        onSelectTrack,
        onSelectCollection,
        onSelectArtist,
        onSelectAlbum,
        onAddTrackToQueue,
        handleRemoveTrack
    ]);

    // Refs for direct DOM manipulation — eliminates per-card useTransform subscriptions
    const cardWrapperRefs = useRef<(HTMLDivElement | null)[]>([]);

    // Cleanup throttled state updates on unmount
    useEffect(() => {
        return () => {
            if (pendingTimeoutRef.current) {
                clearTimeout(pendingTimeoutRef.current);
            }
        };
    }, []);

    /**
     * Single centralized rAF loop: subscribes to dragX/dragY ONCE and only
     * updates the mounted viewport-near card set resolved from the hex grid.
     */
    useEffect(() => {
        let rafId: number | null = null;

        const updateFocusedIndexThrottled = (newIndex: number) => {
            if (pendingTimeoutRef.current) {
                clearTimeout(pendingTimeoutRef.current);
                pendingTimeoutRef.current = null;
            }

            const now = performance.now();
            const timeSinceLast = now - lastUpdateRef.current;

            if (timeSinceLast >= 200) {
                setFocusedIndex(newIndex);
                focusedIndexRef.current = newIndex;
                lastUpdateRef.current = now;
            } else {
                const remaining = 200 - timeSinceLast;
                pendingTimeoutRef.current = setTimeout(() => {
                    setFocusedIndex(newIndex);
                    focusedIndexRef.current = newIndex;
                    lastUpdateRef.current = performance.now();
                }, remaining);
            }
        };

        const update = () => {
            if (rafId !== null) return;
            rafId = requestAnimationFrame(() => {
                rafId = null;
                const dx = dragX.get();
                const dy = dragY.get();
                const { maxDistance, lodStart, lodEnd } = layoutConfig;
                updateRenderedIndexesForViewport(dx, dy);

                let closestIdx = focusedIndexRef.current;
                let minDistSq = Infinity;
                const activeIndexes = renderedIndexesRef.current;

                for (let activeIndex = 0; activeIndex < activeIndexes.length; activeIndex++) {
                    const i = activeIndexes[activeIndex];
                    const coord = baseCoords[i];
                    if (!coord) continue;
                    const cx = coord.baseX + dx;
                    const cy = coord.baseY + dy;
                    const distSq = cx * cx + cy * cy;

                    // Track closest card for focusedIndex
                    if (distSq < minDistSq) {
                        minDistSq = distSq;
                        closestIdx = i;
                    }

                    const el = cardWrapperRefs.current[i];
                    if (!el) continue;

                    const dist = Math.sqrt(distSq);

                    // Viewport clipping — skip off-screen cards entirely
                    if (dist > clipRadius) {
                        el.style.display = 'none';
                        continue;
                    }

                    el.style.display = '';
                    const t = Math.min(dist / maxDistance, 1);
                    const scale = 1.1 - 0.65 * t;   // lerp(1.1, 0.45, t)
                    const opac = 1.0 - 0.72 * t;     // lerp(1.0, 0.28, t)
                    const z = Math.round(50 - 49 * t); // lerp(50, 1, t)

                    el.style.transform = `translate(${coord.baseX}px, ${coord.baseY}px) scale(${scale})`;
                    el.style.opacity = String(opac);
                    el.style.zIndex = String(z);

                    // Queue button visibility via CSS custom properties
                    if (dist > lodEnd) {
                        el.style.setProperty('--queue-opacity', '0');
                        el.style.setProperty('--queue-pe', 'none');
                    } else if (dist < lodStart) {
                        el.style.setProperty('--queue-opacity', '1');
                        el.style.setProperty('--queue-pe', 'auto');
                    } else {
                        const qt = (dist - lodStart) / (lodEnd - lodStart);
                        el.style.setProperty('--queue-opacity', String(1 - qt));
                        el.style.setProperty('--queue-pe', 'auto');
                    }

                    // Play button visibility via CSS custom properties
                    if (dist < 40) {
                        const pt = dist / 40;
                        el.style.setProperty('--play-opacity', String(1 - pt));
                        el.style.setProperty('--play-scale', String(1 - 0.2 * pt));
                        el.style.setProperty('--play-pe', 'auto');
                    } else {
                        el.style.setProperty('--play-opacity', '0');
                        el.style.setProperty('--play-scale', '0.8');
                        el.style.setProperty('--play-pe', 'none');
                    }
                }

                // Update focusedIndex with throttle to eliminate React drag lags
                updateFocusedIndexThrottled(closestIdx);
            });
        };

        // Run once immediately to position all cards
        update();

        const unsubX = dragX.on('change', update);
        const unsubY = dragY.on('change', update);
        return () => {
            unsubX();
            unsubY();
            if (rafId !== null) cancelAnimationFrame(rafId);
        };
    }, [dragX, dragY, baseCoords, layoutConfig, clipRadius, renderedIndexes, updateRenderedIndexesForViewport]);

    // Setup arrow keyboard navigation
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
                e.preventDefault();
                if (gridItems.length === 0) return;

                const curr = baseCoords[focusedIndex];
                let bestNextIdx = focusedIndex;
                let minDist = Infinity;

                baseCoords.forEach((coord, idx) => {
                    if (idx === focusedIndex) return;

                    const dx = coord.baseX - curr.baseX;
                    const dy = coord.baseY - curr.baseY;

                    let isMatch = false;
                    if (e.key === 'ArrowLeft' && dx < -50 && Math.abs(dy) < 180) isMatch = true;
                    if (e.key === 'ArrowRight' && dx > 50 && Math.abs(dy) < 180) isMatch = true;
                    if (e.key === 'ArrowUp' && dy < -50 && Math.abs(dx) < 200) isMatch = true;
                    if (e.key === 'ArrowDown' && dy > 50 && Math.abs(dx) < 200) isMatch = true;

                    if (isMatch) {
                        const dist = dx * dx + dy * dy;
                        if (dist < minDist) {
                            minDist = dist;
                            bestNextIdx = idx;
                        }
                    }
                });

                if (bestNextIdx !== focusedIndex) {
                    centerOnIndex(bestNextIdx, true);
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [focusedIndex, baseCoords, gridItems.length]);

    const showLoading = isLoading || (mode === 'tracks' && loading && tracks.length === 0);

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex flex-col justify-between overflow-hidden select-none"
            style={{
                backgroundColor: isDaylight ? 'rgba(250, 249, 246, 0.95)' : 'rgba(9, 9, 11, 0.95)',
                color: 'var(--text-primary)',
                backdropFilter: 'blur(24px)'
            }}
        >
            {/* Top Floating Glass Header */}
            <div className="w-full flex items-center justify-between px-6 py-5 z-[70] bg-gradient-to-b from-black/10 to-transparent pointer-events-none">
                <button
                    onClick={onBack}
                    className="w-10 h-10 rounded-full flex items-center justify-center transition-all pointer-events-auto shadow-lg hover:scale-105 active:scale-95"
                    style={{
                        backgroundColor: isDaylight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.08)',
                        backdropFilter: 'blur(8px)',
                    }}
                >
                    <ChevronLeft size={20} />
                </button>

                <div
                    onClick={() => {
                        if (mode === 'tracks' && collection) {
                            setShowCutInPanel(!showCutInPanel);
                        }
                    }}
                    className={`text-center flex flex-col items-center select-none pointer-events-auto ${mode === 'tracks' && collection ? 'cursor-pointer hover:opacity-85 active:scale-98 transition-all px-4 py-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/5' : ''}`}
                >
                    <h2 className="text-lg font-bold tracking-tight flex items-center gap-1.5 justify-center">
                        {title}
                        {mode === 'tracks' && collection && (
                            <span className="text-[9px] bg-zinc-500/20 text-current px-1.5 py-0.5 rounded-full font-normal opacity-60">
                                {showCutInPanel ? '收起信息' : '歌单信息'}
                            </span>
                        )}
                    </h2>
                    {subtitle && <p className="text-xs opacity-50 mt-0.5">{subtitle}</p>}
                </div>

                <div className="w-10 h-10" /> {/* Spacer */}
            </div>

            {/* Honeycomb Drag/Viewport Canvas Area */}
            <div
                ref={containerRef}
                className="w-full flex-1 relative flex items-center justify-center cursor-grab active:cursor-grabbing overflow-hidden"
            >
                {showLoading ? (
                    <div className="flex flex-col items-center gap-4 opacity-50">
                        <Loader2 className="animate-spin" size={32} />
                        <span className="text-sm font-semibold font-sans">{t('playlist.loading') || 'Loading...'}</span>
                    </div>
                ) : gridItems.length === 0 ? (
                    <div className="opacity-40 text-sm font-sans">{t('home.loadingLibrary') || 'No items found'}</div>
                ) : (
                    <motion.div
                        drag
                        dragConstraints={false}
                        dragElastic={0.05}
                        dragTransition={{ power: 0.16, timeConstant: 220 }}
                        onDragStart={() => {
                            isDraggingRef.current = true;
                        }}
                        onDragEnd={() => {
                            setTimeout(() => {
                                isDraggingRef.current = false;
                                flushPendingBackgroundTracks();
                            }, 50);
                        }}
                        style={{ x: dragX, y: dragY, background: 'rgba(0,0,0,0)' }}
                        className="absolute inset-0 flex items-center justify-center cursor-grab active:cursor-grabbing bg-transparent"
                    >
                        {memoizedCards}
                    </motion.div>
                )}

                {/* Cut-in Info Panel Overlay */}
                <AnimatePresence>
                    {showCutInPanel && mode === 'tracks' && collection && (
                        <motion.div
                            initial={{ opacity: 0, x: -60, scale: 0.95 }}
                            animate={{ opacity: 1, x: 0, scale: 1 }}
                            exit={{ opacity: 0, x: -60, scale: 0.95 }}
                            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                            className="absolute left-6 top-24 bottom-6 w-80 rounded-3xl z-[80] overflow-hidden flex flex-col p-6 shadow-2xl border border-white/20 dark:border-zinc-800/80 bg-white/70 dark:bg-zinc-900/70 backdrop-blur-2xl pointer-events-auto"
                            style={{
                                boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.2)',
                            }}
                        >
                            {/* Cover Image */}
                            <div className="w-full aspect-square rounded-2xl overflow-hidden shadow-lg mb-4 bg-zinc-800/20 relative shrink-0">
                                {(collection.coverImgUrl || collection.coverUrl || collection.picUrl) ? (
                                    <img src={(collection.coverImgUrl || collection.coverUrl || collection.picUrl).replace('http:', 'https:')} alt={collection.name} className="w-full h-full object-cover select-none pointer-events-none" />
                                ) : (
                                    <Disc size={64} className="opacity-20 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
                                )}
                            </div>

                            {/* Title & Creator */}
                            <div className="flex-1 overflow-y-auto custom-scrollbar pr-1 space-y-4 text-left min-w-0">
                                <div>
                                    <h3 className="text-xl font-bold line-clamp-2 leading-snug">{collection.name}</h3>
                                    {collection.creator && (
                                        <div className="flex items-center gap-2 mt-2 text-xs opacity-60">
                                            <div className="w-5 h-5 rounded-full overflow-hidden">
                                                <img src={collection.creator.avatarUrl?.replace('http:', 'https:')} alt="avatar" className="w-full h-full object-cover" />
                                            </div>
                                            <span className="font-semibold">{collection.creator.nickname}</span>
                                        </div>
                                    )}
                                    <div className="text-[10px] opacity-40 mt-1.5">
                                        {collection.trackCount !== undefined && <span>{collection.trackCount} 首歌</span>}
                                        {collection.playCount !== undefined && <span> • {collection.playCount} 次播放</span>}
                                    </div>
                                </div>

                                {/* Description */}
                                {collection.description && (
                                    <p className="text-xs opacity-65 leading-relaxed break-words whitespace-pre-wrap max-h-40 overflow-y-auto pr-1">
                                        {collection.description}
                                    </p>
                                )}
                            </div>

                            {/* Buttons Area */}
                            <div className="space-y-2 mt-4 pt-4 border-t border-zinc-200/20 dark:border-zinc-800/40 shrink-0">
                                <button
                                    onClick={() => {
                                        if (onPlayAll && playableTracks.length > 0) {
                                            onPlayAll(playableTracks);
                                        }
                                    }}
                                    disabled={playableTracks.length === 0}
                                    className="w-full py-3 rounded-full font-bold text-xs transition-transform hover:scale-102 active:scale-98 flex items-center justify-center gap-1.5 shadow-md disabled:opacity-40 disabled:hover:scale-100 cursor-pointer"
                                    style={{ backgroundColor: 'var(--text-primary)', color: 'var(--bg-color)' }}
                                >
                                    <Play size={14} fill="currentColor" />
                                    播放全部
                                </button>
                                <button
                                    onClick={() => {
                                        if (onAddAllToQueue && playableTracks.length > 0) {
                                            onAddAllToQueue(playableTracks);
                                        }
                                    }}
                                    disabled={playableTracks.length === 0}
                                    className="w-full py-2.5 rounded-full text-xs font-semibold bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-800/20 dark:hover:bg-zinc-100/20 transition-all flex items-center justify-center gap-1.5 disabled:opacity-40 cursor-pointer"
                                >
                                    <ListPlus size={14} />
                                    加入队列
                                </button>
                                {canEditPlaylist && (
                                    <button
                                        onClick={() => setIsEditMode(prev => !prev)}
                                        className={`w-full py-2.5 rounded-full text-xs font-semibold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${isEditMode ? 'bg-red-500/20 text-red-500 border border-red-500/30' : 'bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-800/20 dark:hover:bg-zinc-100/20'}`}
                                    >
                                        <Pencil size={14} />
                                        {isEditMode ? '完成编辑' : '编辑歌单'}
                                    </button>
                                )}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </motion.div>
    );
};

export default GridView;
