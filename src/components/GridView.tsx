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

const PolaroidCard: React.FC<{
    item: GridItem;
    baseX: number;
    baseY: number;
    dragX: any;
    dragY: any;
    isDaylight: boolean;
    theme: Theme;
    onSelect: () => void;
    onAddQueue?: () => void;
    mode: 'collection' | 'tracks';
    t: any;
}> = ({ item, baseX, baseY, dragX, dragY, isDaylight, theme, onSelect, onAddQueue, mode, t }) => {
    // Map motion values to calculate distance from current center outside of React render lifecycle
    const distance = useTransform([dragX, dragY], ([x, y]) => {
        const currentX = baseX + Number(x);
        const currentY = baseY + Number(y);
        return Math.sqrt(currentX * currentX + currentY * currentY);
    });

    const scale = useTransform(distance, [0, 480], [1.1, 0.45]);
    const opacity = useTransform(distance, [0, 480], [1.0, 0.28]);
    const zIndex = useTransform(distance, [0, 480], [50, 1]);

    const isUnavailable = mode === 'tracks' && item.rawTrack ? isSongMarkedUnavailable(item.rawTrack) : false;
    const unavailableTagText = (mode === 'tracks' && item.rawTrack)
        ? getSongUnavailableTagText(item.rawTrack, t('status.songUnavailableTag'))
        : '';

    // Polaroid card frame coloring depending on theme
    const cardBg = isDaylight 
        ? 'bg-[#faf9f6] text-zinc-900 border-zinc-200/50 shadow-lg' 
        : 'bg-zinc-900 text-zinc-100 border-zinc-800/80 shadow-2xl';

    const cardBorderHover = isDaylight
        ? 'hover:border-zinc-300'
        : 'hover:border-zinc-700';

    return (
        <motion.div
            className={`absolute select-none pointer-events-auto rounded-xl p-3 flex flex-col items-center border transition-shadow duration-300 ${cardBg} ${cardBorderHover}`}
            style={{
                x: baseX,
                y: baseY,
                scale,
                opacity,
                zIndex,
                width: 200,
                height: 275,
                transformOrigin: 'center center',
            }}
            onClick={onSelect}
        >
            {/* Square Polaroid Photo Area */}
            <div className="w-full aspect-square rounded-lg overflow-hidden bg-zinc-800/40 relative shadow-inner flex items-center justify-center shrink-0">
                {item.coverUrl ? (
                    <img 
                        src={item.coverUrl} 
                        alt={item.name} 
                        className={`w-full h-full object-cover transition-opacity duration-300 pointer-events-none select-none ${isUnavailable ? 'opacity-30' : 'opacity-100'}`}
                        loading="lazy"
                    />
                ) : (
                    <Disc size={64} className="opacity-20" style={{ color: 'var(--text-primary)' }} />
                )}

                {/* Unavailable Mask/Badge */}
                {isUnavailable && (
                    <div className="absolute inset-0 bg-black/40 flex items-center justify-center p-2 text-center">
                        <span className="text-[10px] bg-red-500/80 text-white font-bold px-2 py-1 rounded-full uppercase tracking-wider">
                            {unavailableTagText || 'UNAVAILABLE'}
                        </span>
                    </div>
                )}

                {/* Hover Quick Action Buttons */}
                {!isUnavailable && (
                    <div className="absolute inset-0 bg-black/35 opacity-0 hover:opacity-100 transition-opacity flex items-center justify-center gap-3">
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onSelect();
                            }}
                            className="w-10 h-10 rounded-full bg-white/95 text-black hover:scale-110 active:scale-95 transition-transform flex items-center justify-center shadow-lg"
                            title={t('playlist.play') || 'Play'}
                        >
                            <Play size={16} fill="currentColor" className="ml-0.5" />
                        </button>
                        {mode === 'tracks' && onAddQueue && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onAddQueue();
                                }}
                                className="w-10 h-10 rounded-full bg-white/90 text-zinc-900 hover:scale-110 active:scale-95 transition-transform flex items-center justify-center shadow-lg"
                                title={t('navidrome.addToQueue') || 'Add to Queue'}
                            >
                                <Plus size={16} />
                            </button>
                        )}
                    </div>
                )}
            </div>

            {/* Bottom Polaroid Frame Label Details */}
            <div className="w-full flex-1 flex flex-col justify-between pt-3 text-left min-w-0">
                <div className="space-y-0.5">
                    {/* Index + Title */}
                    <div className="text-xs font-bold truncate tracking-tight opacity-90 max-w-full">
                        {item.subtitle ? `${item.subtitle}. ` : ''}{item.name}
                    </div>
                    {/* Artists */}
                    {item.description && (
                        <div className="text-[10px] opacity-55 truncate max-w-full font-medium">
                            {item.description}
                        </div>
                    )}
                </div>

                {/* Bottom metadata details row (album or duration) */}
                {mode === 'tracks' && item.rawTrack && (
                    <div className="flex items-center justify-between text-[9px] opacity-35 font-mono pt-1">
                        <span className="truncate max-w-[120px]">
                            {item.rawTrack.al?.name || item.rawTrack.album?.name || ''}
                        </span>
                        <span>
                            {(() => {
                                const dt = item.rawTrack.dt || item.rawTrack.duration || 0;
                                const min = Math.floor(dt / 60000);
                                const sec = Math.floor((dt % 60000) / 1000);
                                return `${min}:${sec < 10 ? '0' : ''}${sec}`;
                            })()}
                        </span>
                    </div>
                )}
            </div>
        </motion.div>
    );
};

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

    // Coordinate motion values mapping grid drags
    const dragX = useMotionValue(0);
    const dragY = useMotionValue(0);

    const spacingX = 230;
    const spacingY = 300;

    // Build the grid spiral coordinates mapping
    const baseCoords = useMemo(() => {
        const cubics = getHexCubicSpiral(items.length);
        return cubics.map((cubic) => {
            const baseX = cubic.x * spacingX + (cubic.z * spacingX) / 2;
            const baseY = cubic.z * spacingY;
            return { baseX, baseY };
        });
    }, [items.length]);

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

    // Handle drag end inertia deceleration and center target alignment
    const handleDragEnd = (event: any, info: any) => {
        const x = dragX.get();
        const y = dragY.get();

        // Project stopping coordinates based on current speed and drag direction
        const projectedX = x + info.velocity.x * 0.12;
        const projectedY = y + info.velocity.y * 0.12;

        // Find closest grid element to settling coordinate projection
        let closestIdx = 0;
        let minDist = Infinity;

        baseCoords.forEach((coord, idx) => {
            const dx = coord.baseX + projectedX;
            const dy = coord.baseY + projectedY;
            const dist = dx * dx + dy * dy;
            if (dist < minDist) {
                minDist = dist;
                closestIdx = idx;
            }
        });

        centerOnIndex(closestIdx, true);
    };

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

    const activeItem = items[focusedIndex];

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
                {/* Center target cursor decoration */}
                <div 
                    className="absolute w-64 h-80 rounded-2xl border-2 border-dashed pointer-events-none -z-10 transition-colors"
                    style={{
                        borderColor: isDaylight ? 'rgba(24, 24, 27, 0.08)' : 'rgba(255, 255, 255, 0.08)'
                    }}
                />

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
                        onDragEnd={handleDragEnd}
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
                                    onSelect={() => {
                                        if (focusedIndex === idx) {
                                            if (mode === 'tracks' && onSelectTrack && item.rawTrack) {
                                                const trackList = items
                                                    .map(it => it.rawTrack)
                                                    .filter((it): it is SongResult => !!it);
                                                onSelectTrack(item.rawTrack, trackList);
                                            } else if (mode === 'collection' && onSelectCollection) {
                                                onSelectCollection(item.rawCollection || item);
                                            }
                                        } else {
                                            centerOnIndex(idx, true);
                                        }
                                    }}
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

            {/* Bottom Metadata focus hud card */}
            <AnimatePresence>
                {activeItem && !isLoading && (
                    <motion.div
                        key={activeItem.id}
                        initial={{ opacity: 0, y: 15 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 15 }}
                        transition={{ duration: 0.3 }}
                        className="w-full flex flex-col items-center justify-center p-6 pb-8 z-50 text-center pointer-events-none select-none"
                        style={{
                            background: `linear-gradient(to t, ${isDaylight ? 'rgba(250, 249, 246, 0.98)' : 'rgba(9, 9, 11, 0.98)'} 70%, transparent)`
                        }}
                    >
                        <h3 className="font-bold text-xl truncate max-w-xl mx-auto">
                            {activeItem.name}
                        </h3>
                        {activeItem.description && (
                            <p className="text-xs opacity-50 font-mono mt-1 max-w-md truncate">
                                {activeItem.description}
                            </p>
                        )}
                        {mode === 'tracks' && activeItem.rawTrack && (
                            <div className="flex items-center gap-3 mt-3 text-xs opacity-40 font-mono pointer-events-auto">
                                <span>{activeItem.rawTrack.al?.name || activeItem.rawTrack.album?.name || ''}</span>
                                <span>•</span>
                                <span>{t('playlist.headerTime') || 'Time'}: {(() => {
                                    const dt = activeItem.rawTrack.dt || activeItem.rawTrack.duration || 0;
                                    const min = Math.floor(dt / 60000);
                                    const sec = Math.floor((dt % 60000) / 1000);
                                    return `${min}:${sec < 10 ? '0' : ''}${sec}`;
                                })()}</span>
                            </div>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    );
};

export default GridView;
