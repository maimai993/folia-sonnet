import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, useMotionValue, animate, AnimatePresence } from 'framer-motion';
import { ChevronLeft, Disc } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Theme } from '../types';

// C:\Users\123xi\.gemini\antigravity-ide\brain\9ec24ac8-12cb-4fe4-9bba-fb52fb47aecc
// src/components/GridMap.tsx
// Hexagonal honeycomb layout showing all collections (playlists, albums, radios).
// Click on any collection card to select it and jump/center to it in Grid3D view.

export interface GridMapItem {
    id: string | number;
    name: string;
    coverUrl?: string;
    description?: string;
    rawCollection?: any;
}

interface GridMapProps {
    title: string;
    subtitle?: string;
    items: GridMapItem[];
    onBack: () => void;
    onSelectCollection: (collection: any, index: number) => void;
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

/**
 * Renders a simplified polaroid-style card representing a collection.
 * Designed to be clicked to immediately select and center the item.
 */
const MapCard = React.memo<{
    item: GridMapItem;
    isDaylight: boolean;
    onSelect: () => void;
    cardWidth: number;
    cardHeight: number;
}>(
    ({ item, isDaylight, onSelect, cardWidth, cardHeight }) => {
        const cardBg = isDaylight
            ? 'bg-[#faf9f6] text-zinc-900 border-zinc-200/50 shadow-lg'
            : 'bg-zinc-900 text-zinc-100 border-zinc-800/80 shadow-2xl';

        const cardBorderHover = isDaylight
            ? 'hover:border-zinc-300'
            : 'hover:border-zinc-700';

        return (
            <div
                className={`rounded-xl p-3 flex flex-col items-center border transition-shadow duration-300 cursor-pointer ${cardBg} ${cardBorderHover}`}
                style={{
                    width: cardWidth,
                    minHeight: cardHeight,
                    height: 'auto',
                }}
                onClick={(e) => {
                    e.stopPropagation();
                    onSelect();
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
                                        el.style.opacity = '1';
                                        const placeholder = el.nextElementSibling as HTMLElement;
                                        if (placeholder) {
                                            placeholder.style.opacity = '0';
                                            placeholder.style.display = 'none';
                                        }
                                    }
                                }}
                                onLoad={(e) => {
                                    const img = e.currentTarget;
                                    img.style.opacity = '1';
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
                </div>

                {/* Bottom Polaroid Frame Label Details */}
                <div className="w-full flex-1 flex flex-col justify-between pt-3 text-left min-w-0">
                    <div className="space-y-1 mb-2">
                        <div className="text-xs font-bold tracking-tight opacity-90 max-w-full line-clamp-2 whitespace-normal break-words">
                            {item.name}
                        </div>
                        {item.description && (
                            <div className="text-[10px] opacity-55 max-w-full font-medium line-clamp-1 whitespace-normal break-words">
                                {item.description}
                            </div>
                        )}
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
            prev.cardWidth === next.cardWidth &&
            prev.cardHeight === next.cardHeight
        );
    }
);

export const GridMap: React.FC<GridMapProps> = ({
    title,
    subtitle,
    items = [],
    onBack,
    onSelectCollection,
    isDaylight,
}) => {
    const { t } = useTranslation();
    const containerRef = useRef<HTMLDivElement>(null);
    const [focusedIndex, setFocusedIndex] = useState(0);
    const lastUpdateRef = useRef(0);
    const pendingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const isDraggingRef = useRef(false);

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
            return {
                cardWidth: 180,
                cardHeight: 250,
                spacingX: 205,
                spacingY: 240,
                maxDistance: 420,
            };
        } else if (width < 1440) {
            return {
                cardWidth: 220,
                cardHeight: 290,
                spacingX: 250,
                spacingY: 280,
                maxDistance: 500,
            };
        } else if (width < 2000) {
            return {
                cardWidth: 250,
                cardHeight: 330,
                spacingX: 285,
                spacingY: 320,
                maxDistance: 580,
            };
        } else {
            return {
                cardWidth: 280,
                cardHeight: 370,
                spacingX: 320,
                spacingY: 360,
                maxDistance: 660,
            };
        }
    }, [containerSize.width]);

    // Dynamically calculate visible clipping radius centered on (0,0) viewport coordinates
    const clipRadius = useMemo(() => {
        const { width, height } = containerSize;
        const { cardWidth, cardHeight } = layoutConfig;
        const viewportRadius = Math.sqrt((width / 2) ** 2 + (height / 2) ** 2);
        const cardRadius = Math.sqrt(cardWidth ** 2 + cardHeight ** 2) / 2;
        return viewportRadius + cardRadius + 200;
    }, [containerSize, layoutConfig]);

    const dragX = useMotionValue(0);
    const dragY = useMotionValue(0);

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

    /**
     * Recenter the honeycomb grid viewport on target item coordinate offset.
     */
    const centerOnIndex = (index: number, snap = true) => {
        if (index < 0 || index >= baseCoords.length) return;
        const targetX = -baseCoords[index].baseX;
        const targetY = -baseCoords[index].baseY;

        if (pendingTimeoutRef.current) {
            clearTimeout(pendingTimeoutRef.current);
            pendingTimeoutRef.current = null;
        }
        setFocusedIndex(index);
        lastUpdateRef.current = performance.now();

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

    const cardWrapperRefs = useRef<(HTMLDivElement | null)[]>([]);

    const memoizedCards = useMemo(() => {
        return items.map((item, idx) => {
            const coord = baseCoords[idx];
            if (!coord) return null;

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
                    <MapCard
                        item={item}
                        isDaylight={isDaylight}
                        cardWidth={layoutConfig.cardWidth}
                        cardHeight={layoutConfig.cardHeight}
                        onSelect={() => {
                            onSelectCollection(item.rawCollection || item, idx);
                        }}
                    />
                </div>
            );
        });
    }, [
        items,
        baseCoords,
        isDaylight,
        layoutConfig.cardWidth,
        layoutConfig.cardHeight,
        onSelectCollection,
    ]);

    useEffect(() => {
        return () => {
            if (pendingTimeoutRef.current) {
                clearTimeout(pendingTimeoutRef.current);
            }
        };
    }, []);

    /**
     * Centralized animation frame callback that coordinates translation,
     * scaling, opacity, and layering of all honeycomb grid cards dynamically.
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
                lastUpdateRef.current = now;
            } else {
                const remaining = 200 - timeSinceLast;
                pendingTimeoutRef.current = setTimeout(() => {
                    setFocusedIndex(newIndex);
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
                const { maxDistance } = layoutConfig;

                let closestIdx = 0;
                let minDistSq = Infinity;

                for (let i = 0; i < baseCoords.length; i++) {
                    const coord = baseCoords[i];
                    const cx = coord.baseX + dx;
                    const cy = coord.baseY + dy;
                    const distSq = cx * cx + cy * cy;

                    if (distSq < minDistSq) {
                        minDistSq = distSq;
                        closestIdx = i;
                    }

                    const el = cardWrapperRefs.current[i];
                    if (!el) continue;

                    const dist = Math.sqrt(distSq);

                    if (dist > clipRadius) {
                        el.style.display = 'none';
                        continue;
                    }

                    el.style.display = '';
                    const t = Math.min(dist / maxDistance, 1);
                    const scale = 1.1 - 0.65 * t;
                    const opac = 1.0 - 0.72 * t;
                    const z = Math.round(50 - 49 * t);

                    el.style.transform = `translate(${coord.baseX}px, ${coord.baseY}px) scale(${scale})`;
                    el.style.opacity = String(opac);
                    el.style.zIndex = String(z);
                }

                updateFocusedIndexThrottled(closestIdx);
            });
        };

        update();

        const unsubX = dragX.on('change', update);
        const unsubY = dragY.on('change', update);
        return () => {
            unsubX();
            unsubY();
            if (rafId !== null) cancelAnimationFrame(rafId);
        };
    }, [dragX, dragY, baseCoords, layoutConfig, clipRadius]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

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

                <div className="text-center flex flex-col items-center select-none pointer-events-auto">
                    <h2 className="text-lg font-bold tracking-tight">
                        {title}
                    </h2>
                    {subtitle && <p className="text-xs opacity-50 mt-0.5">{subtitle}</p>}
                </div>

                <div className="w-10 h-10" />
            </div>

            {/* Honeycomb Drag/Viewport Canvas Area */}
            <div
                ref={containerRef}
                className="w-full flex-1 relative flex items-center justify-center cursor-grab active:cursor-grabbing overflow-hidden"
            >
                {items.length === 0 ? (
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
                            }, 50);
                        }}
                        style={{ x: dragX, y: dragY, background: 'rgba(0,0,0,0)' }}
                        className="absolute inset-0 flex items-center justify-center cursor-grab active:cursor-grabbing bg-transparent"
                    >
                        {memoizedCards}
                    </motion.div>
                )}
            </div>
        </motion.div>
    );
};

export default GridMap;
