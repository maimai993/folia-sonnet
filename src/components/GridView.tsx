import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, useMotionValue, useTransform, animate, AnimatePresence } from 'framer-motion';
import { ChevronLeft, Disc, Play, Plus, Loader2, Heart } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SongResult, Theme } from '../types';
import { isSongMarkedUnavailable, getSongUnavailableTagText, neteaseApi } from '../services/netease';
import { getNavidromeConfig, navidromeApi } from '../services/navidromeService';
import { formatSongName } from '../utils/songNameFormatter';
import { colorWithAlpha } from './visualizer/colorMix';

// C:\Users\123xi\.gemini\antigravity-ide\brain\5ddc5af2-6cab-4638-828b-1773ffe7d556
// src/components/GridView.tsx
// High-performance 2D honeycomb layout grid matching the Apple Watch album grid layout.
// Displays items as Polaroid-style photo cards containing cover art, metadata, and controls.

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
    items: GridItem[];
    mode: 'collection' | 'tracks';
    onBack: () => void;
    onSelectTrack?: (track: SongResult, queue: SongResult[]) => void;
    onSelectCollection?: (item: any) => void;
    onAddTrackToQueue?: (track: SongResult) => void;
    isLoading?: boolean;
    theme: Theme;
    isDaylight: boolean;
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

const PolaroidCard = React.memo<{
    item: GridItem;
    baseX: number;
    baseY: number;
    dragX: any;
    dragY: any;
    isDaylight: boolean;
    theme: Theme;
    onSelect: () => void;
    onCenter: () => void;
    onAddQueue?: () => void;
    mode: 'collection' | 'tracks';
    t: any;
    isCentered: boolean;
    cardWidth: number;
    cardHeight: number;
    maxDistance: number;
    lodStart: number;
    lodEnd: number;
}>(
    ({
        item,
        baseX,
        baseY,
        dragX,
        dragY,
        isDaylight,
        theme,
        onSelect,
        onCenter,
        onAddQueue,
        mode,
        t,
        isCentered,
        cardWidth,
        cardHeight,
        maxDistance,
        lodStart,
        lodEnd
    }) => {
        // Map motion values to calculate distance from current center outside of React render lifecycle
        const distance = useTransform([dragX, dragY], ([x, y]) => {
            const currentX = baseX + Number(x);
            const currentY = baseY + Number(y);
            return Math.sqrt(currentX * currentX + currentY * currentY);
        });

        const scale = useTransform(distance, [0, maxDistance], [1.1, 0.45]);
        const opacity = useTransform(distance, [0, maxDistance], [1.0, 0.28]);
        const zIndex = useTransform(distance, [0, maxDistance], [50, 1]);

        // LOD: Hide queue buttons for cards outside the second outer ring (distance > lodEnd)
        const queueButtonOpacity = useTransform(distance, [lodStart, lodEnd], [1, 0]);
        const queueButtonPointerEvents = useTransform(distance, (d) => Number(d) > lodEnd ? 'none' : 'auto');

        const isUnavailable = mode === 'tracks' && item.rawTrack ? isSongMarkedUnavailable(item.rawTrack) : false;
        const unavailableTagText = (mode === 'tracks' && item.rawTrack)
            ? getSongUnavailableTagText(item.rawTrack, t('status.songUnavailableTag'))
            : '';

        const [isVisible, setIsVisible] = useState(false);
        const [isLoaded, setIsLoaded] = useState(false);
        const cardRef = useRef<HTMLDivElement>(null);

        useEffect(() => {
            if (!cardRef.current) return;
            const observer = new IntersectionObserver(
                ([entry]) => {
                    if (entry.isIntersecting) {
                        setIsVisible(true);
                        observer.disconnect();
                    }
                },
                {
                    rootMargin: '250px',
                }
            );
            observer.observe(cardRef.current);
            return () => observer.disconnect();
        }, []);

        // Polaroid card frame coloring depending on theme
        const cardBg = isDaylight 
            ? 'bg-[#faf9f6] text-zinc-900 border-zinc-200/50 shadow-lg' 
            : 'bg-zinc-900 text-zinc-100 border-zinc-800/80 shadow-2xl';

        const cardBorderHover = isDaylight
            ? 'hover:border-zinc-300'
            : 'hover:border-zinc-700';

        return (
            <motion.div
                ref={cardRef}
                className={`absolute select-none pointer-events-auto rounded-xl p-3 flex flex-col items-center border transition-shadow duration-300 ${cardBg} ${cardBorderHover}`}
                style={{
                    x: baseX,
                    y: baseY,
                    scale,
                    opacity,
                    zIndex,
                    width: cardWidth,
                    minHeight: cardHeight,
                    height: 'auto',
                    transformOrigin: 'center center',
                }}
                onClick={onCenter}
            >
                {/* Square Polaroid Photo Area */}
                <div className="w-full aspect-square rounded-lg overflow-hidden bg-zinc-200/60 dark:bg-zinc-800/60 relative shadow-inner flex items-center justify-center shrink-0">
                    {item.coverUrl && isVisible ? (
                        <>
                            <img 
                                src={item.coverUrl} 
                                alt={item.name} 
                                onLoad={() => setIsLoaded(true)}
                                className={`w-full h-full object-cover transition-opacity duration-350 pointer-events-none select-none ${isLoaded ? (isUnavailable ? 'opacity-30' : 'opacity-100') : 'opacity-0'}`}
                            />
                            {!isLoaded && (
                                <div className="absolute inset-0 bg-zinc-300/40 dark:bg-zinc-700/40 animate-pulse flex items-center justify-center">
                                    <Disc size={48} className="opacity-20 animate-spin" style={{ animationDuration: '3s', color: 'var(--text-primary)' }} />
                                </div>
                            )}
                        </>
                    ) : (
                        <div className="absolute inset-0 bg-zinc-300/40 dark:bg-zinc-700/40 animate-pulse flex items-center justify-center">
                            <Disc size={48} className="opacity-20" style={{ color: 'var(--text-primary)' }} />
                        </div>
                    )}

                    {/* Unavailable Mask/Badge */}
                    {isUnavailable && isLoaded && (
                        <div className="absolute inset-0 bg-black/40 flex items-center justify-center p-2 text-center">
                            <span className="text-[10px] bg-red-500/80 text-white font-bold px-2 py-1 rounded-full uppercase tracking-wider">
                                {unavailableTagText || 'UNAVAILABLE'}
                            </span>
                        </div>
                    )}
                </div>

                {/* Bottom Polaroid Frame Label Details */}
                <div className="w-full flex-1 flex flex-col justify-between pt-3 text-left min-w-0">
                    <div className="space-y-1 mb-2">
                        {/* Index + Title */}
                        <div className="text-xs font-bold tracking-tight opacity-90 max-w-full line-clamp-2 whitespace-normal break-words">
                            {item.subtitle ? `${item.subtitle}. ` : ''}{item.name}
                        </div>
                        {/* Artists */}
                        {item.description && (
                            <div className="text-[10px] opacity-55 max-w-full font-medium line-clamp-1 whitespace-normal break-words">
                                {item.description}
                            </div>
                        )}
                    </div>

                    <div className="flex items-end justify-between mt-auto pt-1.5 w-full">
                        {/* Left: Album name & Duration */}
                        <div className="flex flex-col min-w-0 flex-1 pr-2">
                            {mode === 'tracks' && item.rawTrack && (
                                <>
                                    <span className="text-[9px] opacity-35 font-mono line-clamp-1 whitespace-normal break-words max-w-full">
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
                            <AnimatePresence>
                                {isCentered && !isUnavailable && (
                                    <motion.button
                                        key="play-btn"
                                        initial={{ opacity: 0, scale: 0.8 }}
                                        animate={{ opacity: 1, scale: 1 }}
                                        exit={{ opacity: 0, scale: 0.8 }}
                                        transition={{ duration: 0.2, ease: 'easeOut' }}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onSelect();
                                        }}
                                        className="w-9 h-9 rounded-full bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-800/20 dark:hover:bg-zinc-100/20 text-current flex items-center justify-center transition-colors shadow-sm pointer-events-auto z-10"
                                        title={t('playlist.play') || 'Play'}
                                    >
                                        <Play size={15} fill="currentColor" className="ml-0.5" />
                                    </motion.button>
                                )}
                            </AnimatePresence>
                            {mode === 'tracks' && onAddQueue && !isUnavailable && (
                                <motion.button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onAddQueue();
                                    }}
                                    style={{ opacity: queueButtonOpacity, pointerEvents: queueButtonPointerEvents as any }}
                                    className="w-9 h-9 rounded-full bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-800/20 dark:hover:bg-zinc-100/20 text-current flex items-center justify-center transition-colors shadow-sm pointer-events-auto"
                                    title={t('navidrome.addToQueue') || 'Add to Queue'}
                                >
                                    <Plus size={15} />
                                </motion.button>
                            )}
                        </div>
                    </div>
                </div>
            </motion.div>
        );
    },
    (prev, next) => {
        return (
            prev.item.id === next.item.id &&
            prev.item.name === next.item.name &&
            prev.item.coverUrl === next.item.coverUrl &&
            prev.baseX === next.baseX &&
            prev.baseY === next.baseY &&
            prev.isCentered === next.isCentered &&
            prev.isDaylight === next.isDaylight &&
            prev.theme === next.theme &&
            prev.mode === next.mode &&
            prev.cardWidth === next.cardWidth &&
            prev.cardHeight === next.cardHeight &&
            prev.maxDistance === next.maxDistance &&
            prev.lodStart === next.lodStart &&
            prev.lodEnd === next.lodEnd
        );
    }
);

export const GridView: React.FC<GridViewProps> = ({
    title,
    subtitle,
    items,
    mode,
    onBack,
    onSelectTrack,
    onSelectCollection,
    onAddTrackToQueue,
    isLoading = false,
    theme,
    isDaylight
}) => {
    const { t } = useTranslation();
    const containerRef = useRef<HTMLDivElement>(null);
    const [focusedIndex, setFocusedIndex] = useState(0);

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

    // Coordinate motion values mapping grid drags
    const dragX = useMotionValue(0);
    const dragY = useMotionValue(0);

    // Build the grid spiral coordinates mapping using responsive spacing
    const baseCoords = useMemo(() => {
        const cubics = getHexCubicSpiral(items.length);
        const { spacingX, spacingY } = layoutConfig;
        return cubics.map((cubic) => {
            const baseX = cubic.x * spacingX + (cubic.z * spacingX) / 2;
            const baseY = cubic.z * spacingY;
            return { baseX, baseY };
        });
    }, [items.length, layoutConfig]);

    // Keep the active focusedIndex centered when baseCoords changes on resize
    useEffect(() => {
        if (baseCoords.length > 0 && focusedIndex >= 0 && focusedIndex < baseCoords.length) {
            const targetX = -baseCoords[focusedIndex].baseX;
            const targetY = -baseCoords[focusedIndex].baseY;
            dragX.set(targetX);
            dragY.set(targetY);
        }
    }, [baseCoords]);

    // Recenter the viewport on target item coordinate offset
    const centerOnIndex = (index: number, snap = true) => {
        if (index < 0 || index >= baseCoords.length) return;
        const targetX = -baseCoords[index].baseX;
        const targetY = -baseCoords[index].baseY;

        setFocusedIndex(index);

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
        if (items.length > 0) {
            centerOnIndex(0, false);
        }
    }, [items.length]);

    // Track coordinate changes to dynamically update the active centered item HUD
    useEffect(() => {
        let frameId: number | null = null;

        const updateClosestFocus = () => {
            if (frameId !== null) return;
            
            frameId = requestAnimationFrame(() => {
                frameId = null;
                const currentX = dragX.get();
                const currentY = dragY.get();
                
                let closestIdx = 0;
                let minDist = Infinity;
                baseCoords.forEach((coord, idx) => {
                    const dx = coord.baseX + currentX;
                    const dy = coord.baseY + currentY;
                    const dist = dx * dx + dy * dy;
                    if (dist < minDist) {
                        minDist = dist;
                        closestIdx = idx;
                    }
                });
                
                setFocusedIndex((prev) => {
                    if (prev !== closestIdx) {
                        return closestIdx;
                    }
                    return prev;
                });
            });
        };

        const unsubX = dragX.on('change', updateClosestFocus);
        const unsubY = dragY.on('change', updateClosestFocus);
        return () => {
            unsubX();
            unsubY();
            if (frameId !== null) cancelAnimationFrame(frameId);
        };
    }, [dragX, dragY, baseCoords]);

    // Setup arrow keyboard navigation
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

            // Find current hexagonal coordinate axes neighbors based on direction keys
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
                e.preventDefault();
                if (items.length === 0) return;

                const curr = baseCoords[focusedIndex];
                let bestNextIdx = focusedIndex;
                let minDist = Infinity;

                baseCoords.forEach((coord, idx) => {
                    if (idx === focusedIndex) return;

                    const dx = coord.baseX - curr.baseX;
                    const dy = coord.baseY - curr.baseY;

                    // Filter based on directional axis quadrant alignment
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
    }, [focusedIndex, baseCoords, items.length]);



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

                <div className="text-center">
                    <h2 className="text-lg font-bold tracking-tight">{title}</h2>
                    {subtitle && <p className="text-xs opacity-50 mt-0.5">{subtitle}</p>}
                </div>

                <div className="w-10 h-10" /> {/* Spacer */}
            </div>

            {/* Honeycomb Drag/Viewport Canvas Area */}
            <div
                ref={containerRef}
                className="w-full flex-1 relative flex items-center justify-center cursor-grab active:cursor-grabbing overflow-hidden"
            >


                {isLoading ? (
                    <div className="flex flex-col items-center gap-4 opacity-50">
                        <Loader2 className="animate-spin" size={32} />
                        <span className="text-sm font-semibold font-sans">{t('playlist.loading') || 'Loading...'}</span>
                    </div>
                ) : items.length === 0 ? (
                    <div className="opacity-40 text-sm font-sans">{t('home.loadingLibrary') || 'No items found'}</div>
                ) : (
                    <motion.div
                        drag
                        dragConstraints={false}
                        dragElastic={0.05}
                        dragTransition={{ power: 0.16, timeConstant: 220 }}
                        style={{ x: dragX, y: dragY }}
                        className="absolute inset-0 flex items-center justify-center cursor-grab active:cursor-grabbing"
                    >
                        {items.map((item, idx) => {
                            const coord = baseCoords[idx];
                            if (!coord) return null;

                            return (
                                <PolaroidCard
                                    key={item.id}
                                    item={item}
                                    baseX={coord.baseX}
                                    baseY={coord.baseY}
                                    dragX={dragX}
                                    dragY={dragY}
                                    isDaylight={isDaylight}
                                    theme={theme}
                                    mode={mode}
                                    t={t}
                                    isCentered={focusedIndex === idx}
                                    cardWidth={layoutConfig.cardWidth}
                                    cardHeight={layoutConfig.cardHeight}
                                    maxDistance={layoutConfig.maxDistance}
                                    lodStart={layoutConfig.lodStart}
                                    lodEnd={layoutConfig.lodEnd}
                                    onSelect={() => {
                                        if (mode === 'tracks' && onSelectTrack && item.rawTrack) {
                                            const trackList = items
                                                .map(it => it.rawTrack)
                                                .filter((it): it is SongResult => !!it);
                                            onSelectTrack(item.rawTrack, trackList);
                                        } else if (mode === 'collection' && onSelectCollection) {
                                            onSelectCollection(item.rawCollection || item);
                                        }
                                    }}
                                    onCenter={() => centerOnIndex(idx, true)}
                                    onAddQueue={() => {
                                        if (mode === 'tracks' && onAddTrackToQueue && item.rawTrack) {
                                            onAddTrackToQueue(item.rawTrack);
                                        }
                                    }}
                                />
                            );
                        })}
                    </motion.div>
                )}
            </div>


        </motion.div>
    );
};

export default GridView;
