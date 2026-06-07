import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Disc } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSettingsUiStore } from '../../stores/useSettingsUiStore';

// src/components/folia-grid/Grid3DSlider.tsx
// A reusable horizontal Polaroid/Image slider component with spring physics, scale-on-center interpolation, drag inertia/velocity tracking, mouse wheel translation, and keyboard arrow support.

export interface Grid3DSliderItem {
    id: string | number;
    name: React.ReactNode;
    coverUrl?: string;
    description?: string;
    summary?: string;
    trackCount?: number;
    type?: string;
    raw?: any;
}

interface Grid3DSliderProps {
    items: Grid3DSliderItem[];
    onSelect: (item: Grid3DSliderItem, index: number) => void;
    isLoading?: boolean;
    emptyMessage?: string;
    isDaylight: boolean;
    hasFloatingPlayer?: boolean;
    initialFocusedIndex?: number;
    onFocusedIndexChange?: (index: number) => void;
}

const compactDescription = (description?: string, maxLength = 72) => {
    if (!description) return '';
    const normalized = description.replace(/\s+/g, ' ').trim();
    return normalized.length > maxLength ? `${normalized.substring(0, maxLength)}...` : normalized;
};

const clampFocusedIndex = (index: number, itemCount: number) => {
    if (itemCount <= 0 || !Number.isFinite(index)) {
        return 0;
    }

    return Math.min(Math.max(0, Math.trunc(index)), itemCount - 1);
};

export const Grid3DSlider: React.FC<Grid3DSliderProps> = ({
    items = [],
    onSelect,
    isLoading = false,
    emptyMessage = 'No items found',
    isDaylight,
    hasFloatingPlayer = false,
    initialFocusedIndex = 0,
    onFocusedIndexChange
}) => {
    const { t } = useTranslation();
    const grid3dCardStyle = useSettingsUiStore(state => state.grid3dCardStyle);

    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const [focusedIndex, setFocusedIndex] = useState(() => clampFocusedIndex(initialFocusedIndex, items.length));
    const focusedIndexRef = useRef(focusedIndex);
    const lastReportedIndexRef = useRef(focusedIndex);
    const skippedReportIndexRef = useRef<number | null>(null);
    const onFocusedIndexChangeRef = useRef(onFocusedIndexChange);
    focusedIndexRef.current = focusedIndex;

    // UI Interaction states
    const [isSliding, setIsSliding] = useState(false);
    const slidingTimeoutRef = useRef<any>(null);

    const containerRef = useRef<HTMLDivElement>(null);
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

    const isDesktopWidth = containerSize.width >= 768;
    const isNarrowLayout = containerSize.width > 0 && containerSize.width < 768;
    const isShortLayout = containerSize.height > 0 && containerSize.height < (hasFloatingPlayer ? 420 : 380);
    const useCompactMetrics = isNarrowLayout || isShortLayout;
    const isLargeDesktop = !useCompactMetrics
        && isDesktopWidth
        && containerSize.width >= 1440
        && containerSize.height >= (hasFloatingPlayer ? 660 : 600);
    const isUltraDesktop = !useCompactMetrics
        && isDesktopWidth
        && containerSize.width >= 2000
        && containerSize.height >= (hasFloatingPlayer ? 780 : 720);

    const coverSize = useCompactMetrics
        ? (isDesktopWidth ? 208 : 192)
        : (isDesktopWidth ? (isUltraDesktop ? 360 : isLargeDesktop ? 312 : 218) : 224);

    useEffect(() => {
        onFocusedIndexChangeRef.current = onFocusedIndexChange;
    }, [onFocusedIndexChange]);

    const updateFocusedIndex = useCallback((index: number, shouldReport = true) => {
        const nextIndex = clampFocusedIndex(index, items.length);

        setFocusedIndex((prev) => {
            if (prev === nextIndex) return prev;
            if (!shouldReport) {
                skippedReportIndexRef.current = nextIndex;
                lastReportedIndexRef.current = nextIndex;
            }
            return nextIndex;
        });
    }, [items.length]);

    // Sync focusedIndex changes up to parent only when the index really changed.
    useEffect(() => {
        if (skippedReportIndexRef.current === focusedIndex) {
            skippedReportIndexRef.current = null;
            return;
        }

        if (lastReportedIndexRef.current === focusedIndex) {
            return;
        }

        onFocusedIndexChangeRef.current?.(focusedIndex);
        lastReportedIndexRef.current = focusedIndex;
    }, [focusedIndex]);

    // Trigger sliding fade indicators
    const handleSliding = () => {
        setIsSliding(true);
        if (slidingTimeoutRef.current) clearTimeout(slidingTimeoutRef.current);
        slidingTimeoutRef.current = setTimeout(() => {
            setIsSliding(false);
        }, 300);
    };

    /**
     * Directly update every card's transform/opacity based on its pixel distance
     * from the viewport center. Called on every scroll frame for continuous scaling.
     */
    const updateCardTransforms = useCallback(() => {
        const container = scrollContainerRef.current;
        if (!container) return;
        const flexWrapper = container.firstElementChild;
        if (!flexWrapper) return;

        const containerCenter = container.scrollLeft + container.clientWidth / 2;
        const maxDist = 600; // distance (px) at which cards reach minimum scale
        const isImage = grid3dCardStyle === 'image';
        const peakScale = isImage ? 1.25 : 1.2;
        const minScale = 0.5;
        const cards = flexWrapper.children;

        let closestIndex = 0;
        let minPixelDist = Infinity;

        for (let i = 0; i < cards.length; i++) {
            const el = cards[i] as HTMLElement;
            const cardCenter = el.offsetLeft + el.offsetWidth / 2;
            const pixelDist = Math.abs(cardCenter - containerCenter);
            const t = Math.min(pixelDist / maxDist, 1);

            const scale = peakScale - (peakScale - minScale) * t;
            const opacity = Math.max(0.15, 1.0 - 0.85 * t);
            const y = -6 * (1 - t);
            const z = Math.max(1, Math.round(10 - 9 * t));

            el.style.transform = `scale(${scale}) translateY(${y}px)`;
            el.style.opacity = String(opacity);
            el.style.zIndex = String(z);

            if (pixelDist < minPixelDist) {
                minPixelDist = pixelDist;
                closestIndex = i;
            }
        }

        return closestIndex;
    }, [grid3dCardStyle]);

    const itemsSignature = useMemo(() => items.map(item => item.id).join(','), [items]);

    // Handle scroll target resets on items change
    useEffect(() => {
        const nextIndex = clampFocusedIndex(initialFocusedIndex, items.length);
        updateFocusedIndex(nextIndex, false);
        const container = scrollContainerRef.current;
        if (container) {
            const flexWrapper = container.firstElementChild;
            const cardElement = flexWrapper?.children[nextIndex] as HTMLElement | undefined;
            container.scrollLeft = cardElement
                ? cardElement.offsetLeft + cardElement.offsetWidth / 2 - container.clientWidth / 2
                : 0;
        }
        requestAnimationFrame(() => updateCardTransforms());
    }, [initialFocusedIndex, items.length, itemsSignature, updateCardTransforms, updateFocusedIndex]);

    const isProgrammaticScrollRef = useRef(false);
    const programmaticTargetLeftRef = useRef<number | null>(null);
    const programmaticScrollTimeoutRef = useRef<any>(null);
    const lastKeyboardNavTimeRef = useRef<number>(0);

    /**
     * Scroll the horizontal container smoothly to center the selected card.
     */
    const scrollToIndex = useCallback((idx: number, shouldReport = true) => {
        if (idx < 0 || idx >= items.length) return;
        updateFocusedIndex(idx, shouldReport);
        const container = scrollContainerRef.current;
        if (container) {
            const flexWrapper = container.firstElementChild;
            const cardElement = flexWrapper?.children[idx] as HTMLElement;
            if (cardElement) {
                const targetScrollLeft = cardElement.offsetLeft + cardElement.offsetWidth / 2 - container.clientWidth / 2;

                isProgrammaticScrollRef.current = true;
                programmaticTargetLeftRef.current = targetScrollLeft;
                if (programmaticScrollTimeoutRef.current) clearTimeout(programmaticScrollTimeoutRef.current);
                programmaticScrollTimeoutRef.current = setTimeout(() => {
                    isProgrammaticScrollRef.current = false;
                    programmaticTargetLeftRef.current = null;
                }, 600);

                container.scrollTo({
                    left: targetScrollLeft,
                    behavior: 'smooth'
                });
            }
        }
    }, [items.length, updateFocusedIndex]);

    useEffect(() => {
        const nextIndex = clampFocusedIndex(initialFocusedIndex, items.length);

        if (nextIndex !== focusedIndexRef.current) {
            scrollToIndex(nextIndex, false);
        }
    }, [initialFocusedIndex, items.length, scrollToIndex]);

    /**
     * Handles scrolling by triggering visual fade timeouts, updating card transforms,
     * and calculating the card that is currently closest to the horizontal center.
     */
    const handleScroll = () => {
        handleSliding();

        const container = scrollContainerRef.current;
        if (!container) return;

        const closestIndex = updateCardTransforms();

        if (isProgrammaticScrollRef.current) {
            if (programmaticTargetLeftRef.current !== null) {
                const diff = Math.abs(container.scrollLeft - programmaticTargetLeftRef.current);
                if (diff < 3) {
                    isProgrammaticScrollRef.current = false;
                    programmaticTargetLeftRef.current = null;
                    if (programmaticScrollTimeoutRef.current) {
                        clearTimeout(programmaticScrollTimeoutRef.current);
                        programmaticScrollTimeoutRef.current = null;
                    }
                }
            } else {
                isProgrammaticScrollRef.current = false;
            }
            return;
        }

        if (closestIndex !== undefined) {
            updateFocusedIndex(closestIndex);
        }
    };

    // --- Momentum / inertia engine shared by drag and wheel ---
    const momentumVelocityRef = useRef(0);
    const momentumRafRef = useRef<number | null>(null);

    const stopMomentum = () => {
        if (momentumRafRef.current !== null) {
            cancelAnimationFrame(momentumRafRef.current);
            momentumRafRef.current = null;
        }
        momentumVelocityRef.current = 0;
    };

    const startMomentum = () => {
        const container = scrollContainerRef.current;
        if (!container || Math.abs(momentumVelocityRef.current) < 0.5) return;

        let lastTime = performance.now();
        const FRICTION = 0.80;

        const tick = (now: number) => {
            const elapsed = now - lastTime;
            lastTime = now;
            const frames = elapsed / 16.67;
            momentumVelocityRef.current *= Math.pow(FRICTION, frames);

            if (Math.abs(momentumVelocityRef.current) < 0.5) {
                momentumVelocityRef.current = 0;
                momentumRafRef.current = null;
                return;
            }

            container.scrollLeft += momentumVelocityRef.current;
            momentumRafRef.current = requestAnimationFrame(tick);
        };

        momentumRafRef.current = requestAnimationFrame(tick);
    };

    // Mouse drag-to-scroll with velocity tracking
    const isDraggingRef = useRef(false);
    const startXRef = useRef(0);
    const scrollLeftRef = useRef(0);
    const dragDistanceRef = useRef(0);
    const lastDragScrollRef = useRef(0);
    const lastDragTimeRef = useRef(0);

    const handleMouseDown = (e: React.MouseEvent) => {
        if (!scrollContainerRef.current) return;
        if (e.button !== 0) return; // Only left click
        stopMomentum();
        isDraggingRef.current = true;
        startXRef.current = e.pageX - scrollContainerRef.current.offsetLeft;
        scrollLeftRef.current = scrollContainerRef.current.scrollLeft;
        dragDistanceRef.current = 0;
        lastDragScrollRef.current = scrollContainerRef.current.scrollLeft;
        lastDragTimeRef.current = performance.now();
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (!isDraggingRef.current || !scrollContainerRef.current) return;
        e.preventDefault();
        const x = e.pageX - scrollContainerRef.current.offsetLeft;
        const walk = (x - startXRef.current) * 1.5;
        dragDistanceRef.current = Math.abs(walk);

        const prevScroll = scrollContainerRef.current.scrollLeft;
        scrollContainerRef.current.scrollLeft = scrollLeftRef.current - walk;
        const nowScroll = scrollContainerRef.current.scrollLeft;

        const now = performance.now();
        const dt = now - lastDragTimeRef.current;
        if (dt > 0) {
            momentumVelocityRef.current = (nowScroll - lastDragScrollRef.current) / dt * 16;
        }
        lastDragScrollRef.current = nowScroll;
        lastDragTimeRef.current = now;
        handleSliding();
    };

    const handleMouseUpOrLeave = () => {
        if (!isDraggingRef.current) return;
        isDraggingRef.current = false;
        startMomentum();
    };

    // Keyboard navigation listener
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (
                e.target instanceof HTMLInputElement ||
                e.target instanceof HTMLTextAreaElement ||
                (e.target instanceof HTMLElement && e.target.isContentEditable)
            ) {
                return;
            }

            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                const now = performance.now();
                if (now - lastKeyboardNavTimeRef.current < 200) return;
                lastKeyboardNavTimeRef.current = now;
                scrollToIndex(focusedIndex - 1);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                const now = performance.now();
                if (now - lastKeyboardNavTimeRef.current < 200) return;
                lastKeyboardNavTimeRef.current = now;
                scrollToIndex(focusedIndex + 1);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [focusedIndex, scrollToIndex]);

    // Wheel listener
    const wheelIdleTimerRef = useRef<any>(null);

    useEffect(() => {
        const container = scrollContainerRef.current;
        if (!container) return;

        const handleWheelEvent = (e: WheelEvent) => {
            e.preventDefault();
            handleSliding();

            if (momentumRafRef.current !== null) {
                cancelAnimationFrame(momentumRafRef.current);
                momentumRafRef.current = null;
            }

            const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
            const scaled = delta * 0.6;
            container.scrollLeft += scaled;

            momentumVelocityRef.current = scaled;

            if (wheelIdleTimerRef.current) clearTimeout(wheelIdleTimerRef.current);
            wheelIdleTimerRef.current = setTimeout(() => {
                startMomentum();
            }, 80);
        };

        container.addEventListener('wheel', handleWheelEvent, { passive: false });
        return () => {
            container.removeEventListener('wheel', handleWheelEvent);
            if (wheelIdleTimerRef.current) clearTimeout(wheelIdleTimerRef.current);
        };
    }, [items]);

    // Cleanup scrolling momentum on unmount
    useEffect(() => {
        return () => {
            if (slidingTimeoutRef.current) clearTimeout(slidingTimeoutRef.current);
            if (programmaticScrollTimeoutRef.current) clearTimeout(programmaticScrollTimeoutRef.current);
            stopMomentum();
        };
    }, []);

    // Rerunning updates on component list mounts
    useEffect(() => {
        requestAnimationFrame(() => updateCardTransforms());
    }, [items, isLoading, updateCardTransforms]);

    return (
        <div ref={containerRef} className="w-full flex-1 flex flex-col justify-center relative min-h-0 select-none">
            <div
                ref={scrollContainerRef}
                onScroll={handleScroll}
                onTouchStart={handleSliding}
                onTouchMove={handleSliding}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUpOrLeave}
                onMouseLeave={handleMouseUpOrLeave}
                className="w-full flex items-center overflow-x-auto overflow-y-hidden py-24 custom-scrollbar cursor-grab active:cursor-grabbing"
                style={{ scrollbarWidth: 'none' }}
            >
                <div className="flex px-[40vw] gap-12">
                    {isLoading ? (
                        Array.from({ length: 5 }).map((_, idx) => (
                            <div key={`skeleton-${idx}`} className="shrink-0 pointer-events-none select-none">
                                {grid3dCardStyle === 'image' ? (
                                    <div
                                        className="aspect-square rounded-2xl animate-pulse bg-zinc-200/20 dark:bg-zinc-800/20 border border-white/5 shadow-inner"
                                        style={{ width: coverSize, height: coverSize }}
                                    />
                                ) : (
                                    <div
                                        className="rounded-xl border border-white/5 p-4 flex flex-col items-center backdrop-blur-md shadow-lg"
                                        style={{ width: coverSize }}
                                    >
                                        <div
                                            className="w-full aspect-square rounded-lg animate-pulse bg-zinc-200/20 dark:bg-zinc-800/20 mb-4"
                                        />
                                        <div className="w-full text-left pt-2 space-y-2">
                                            <div className="h-4 w-3/4 animate-pulse bg-zinc-200/20 dark:bg-zinc-800/20 rounded-md" />
                                            <div className="h-3 w-1/2 animate-pulse bg-zinc-200/20 dark:bg-zinc-800/20 rounded-md" />
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))
                    ) : items.length === 0 ? (
                        <div className="opacity-40 text-sm font-sans flex items-center justify-center w-[20vw] shrink-0 text-center">
                            {emptyMessage}
                        </div>
                    ) : (
                        items.map((item, idx) => {
                            const isFocused = idx === focusedIndex;

                            return (
                                <div
                                    key={item.id}
                                    className="shrink-0 cursor-pointer pointer-events-auto select-none"
                                    onClick={() => {
                                        if (dragDistanceRef.current < 8) {
                                            if (isFocused) {
                                                onSelect(item, idx);
                                            } else {
                                                scrollToIndex(idx);
                                            }
                                        }
                                    }}
                                >
                                    {grid3dCardStyle === 'image' ? (
                                        <div
                                            className={`aspect-square rounded-2xl overflow-hidden shadow-2xl relative border border-white/10 ${
                                                isFocused ? 'ring-2 ring-white/30' : ''
                                            }`}
                                            style={{ width: coverSize, height: coverSize }}
                                        >
                                            {item.coverUrl ? (
                                                <img src={item.coverUrl} alt={typeof item.name === 'string' ? item.name : ''} className="w-full h-full object-cover pointer-events-none select-none" />
                                            ) : (
                                                <div className="w-full h-full bg-zinc-800/20 flex items-center justify-center">
                                                    <Disc size={64} className="opacity-20" />
                                                </div>
                                            )}
                                            <div className="absolute inset-0 bg-gradient-to-tr from-white/10 to-transparent opacity-0 hover:opacity-100 transition-opacity" />
                                        </div>
                                    ) : (
                                        <div
                                            className="rounded-xl border p-4 flex flex-col items-center backdrop-blur-md shadow-lg hover:shadow-2xl theme-polaroid-card"
                                            style={{ width: coverSize }}
                                        >
                                            <div className="w-full aspect-square rounded-lg overflow-hidden bg-zinc-800/20 relative shadow-inner mb-4 flex items-center justify-center">
                                                {item.coverUrl ? (
                                                    <img src={item.coverUrl} alt={typeof item.name === 'string' ? item.name : ''} className="w-full h-full object-cover pointer-events-none select-none" />
                                                ) : (
                                                    <Disc size={64} className="opacity-20" />
                                                )}
                                            </div>

                                            <div className="w-full text-left pt-2 min-w-0">
                                                <h3 className="font-bold text-sm truncate max-w-full tracking-tight">
                                                    {item.name}
                                                </h3>
                                                {((item.type !== 'playlist' && item.description) || !compactDescription(item.summary)) && (
                                                    <p className="text-xs opacity-50 truncate max-w-full mt-1 font-medium">
                                                        {item.type !== 'playlist' && item.description ? item.description : '♫'}
                                                    </p>
                                                )}
                                                {compactDescription(item.summary) && (
                                                    <p className="text-[10px] leading-snug opacity-45 mt-2 line-clamp-2">
                                                        {compactDescription(item.summary)}
                                                    </p>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>
            </div>
            
            {/* Title details at the bottom of the slider */}
            {!isLoading && items.length > 0 && items[focusedIndex] && (
                <div
                    className={`relative shrink-0 text-center z-10 px-8 pointer-events-none ${
                        hasFloatingPlayer ? 'pt-6 md:pt-8 pb-0 -mb-4 md:-mb-6' : 'pt-5 md:pt-6 pb-4'
                    }`}
                >
                    <h3 className="font-bold text-2xl truncate max-w-xl mx-auto" style={{ color: 'var(--text-primary)' }}>
                        {items[focusedIndex].name}
                    </h3>
                    <p className="text-xs opacity-50 font-mono mt-1" style={{ color: 'var(--text-secondary)' }}>
                        {items[focusedIndex].trackCount !== undefined ? `${items[focusedIndex].trackCount} ${t('playlist.tracks') || 'songs'}` : ''}
                        {items[focusedIndex].description ? ` • ${items[focusedIndex].description}` : ''}
                    </p>
                </div>
            )}
        </div>
    );
};
