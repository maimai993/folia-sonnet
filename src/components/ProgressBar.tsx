import React, { useCallback, useLayoutEffect, useRef } from 'react';
import { type MotionValue, useMotionValueEvent } from 'framer-motion';
import { FoliumProgressButtons, FoliumProgressLayers, useFoliumProgressContext } from '../mods/folium/registries/progress';
import { getProgressFillStep, getProgressFillStepFraction } from './progressFillStep';

// Folium public parts (mods/README.md): `data-folium-part` marks what mod CSS may
// restyle — progress.root / track / fill / thumb / time / duration. Colors come
// in as CSS custom properties rather than inline colors, so a mod stylesheet in
// `@layer folium-mods` can override them without !important. Everything else
// about this markup is not API.

interface ProgressBarProps {
    currentTime: MotionValue<number>;
    duration: number;
    onSeek: (time: number) => void;
    onSeekStart?: () => void;
    onSeekEnd?: () => void;
    primaryColor?: string;
    secondaryColor?: string;
    trackColor?: string;
    disabled?: boolean;
    edgeStyle?: 'rounded' | 'square';
    /** The collapsed floating capsule: mod buttons with hideWhenCollapsed stay out. */
    collapsed?: boolean;
    /**
     * 'line': the thin bar under the song in the compact capsule (progress-bar v3): no time labels,
     * a 3px track, and a taller invisible hit area so it can still be dragged.
     */
    variant?: 'default' | 'line';
}


/*
 * 松手之后播放器回传真实位置要一点时间（要缓冲时更久）。这段窗口内继续停在刚拖到的位置上，
 * 否则进度条会先弹回旧位置再跳过去 —— 看着就是「拖了没反应」（安卓真机反馈 2026-11-13）。
 */
const SEEK_SETTLE_MS = 700;
const SEEK_SETTLE_TOLERANCE_SEC = 0.4;

const formatTime = (time: number) => {
    if (isNaN(time)) return '00:00';
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
};

const ProgressBar: React.FC<ProgressBarProps> = ({
    currentTime,
    duration,
    onSeek,
    onSeekStart,
    onSeekEnd,
    primaryColor = 'white',
    secondaryColor = 'rgba(255,255,255,0.5)',
    trackColor = 'rgba(255,255,255,0.1)',
    disabled = false,
    edgeStyle = 'rounded',
    collapsed = false,
    variant = 'default',
}) => {
    const isLine = variant === 'line';
    const progressRef = useRef<HTMLDivElement>(null);
    const thumbRef = useRef<HTMLDivElement>(null);
    const timeRef = useRef<HTMLSpanElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const isDraggingRef = useRef(false);
    /** 刚拖到的位置与它的保鲜期；见 SEEK_SETTLE_MS。 */
    const settleRef = useRef<{ value: number; expiresAt: number } | null>(null);
    const lastDisplayedSecondRef = useRef<number | null>(null);
    const lastInputSecondRef = useRef<number | null>(null);
    const trackDeviceWidthRef = useRef(0);
    const lastFillStepRef = useRef<number | null>(null);

    // Keeps continuous progress on the compositor while coarse values update only when needed.
    const updateUI = useCallback((value: number, force = false, syncInput = true, bypassDrag = false) => {
        if (!bypassDrag) {
            if (isDraggingRef.current) return;
            // 松手后的保鲜期：还在窗口里、且回传的位置没追上来，就先不听播放器的。见 handleSeekEnd。
            const settle = settleRef.current;
            if (settle && !force) {
                const arrived = Math.abs(Math.max(0, value) - settle.value) <= SEEK_SETTLE_TOLERANCE_SEC;
                if (arrived || Date.now() >= settle.expiresAt) {
                    settleRef.current = null;
                } else {
                    return;
                }
            }
        }

        const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
        const clampedValue = duration > 0 ? Math.min(safeValue, duration) : safeValue;
        const displayedSecond = Math.floor(clampedValue);

        // Nothing is painted without a duration, and that is the fix for the flash at the start of
        // a blend: the app switches to the incoming track the moment the overlap begins, but its
        // duration arrives a beat later - automix logs the same gap as `no duration for this track
        // yet`. Treating unknown as zero drew one frame of empty bar and then snapped back, which
        // reads as the bar being re-created. Holding the last fill for those few frames is the only
        // honest option: the fraction is genuinely unknown until the denominator exists.
        // The capsule sits on a backdrop blur, so every clip-path write repaints it. A 4-minute song
        // moves the edge about two device pixels a second, so the fill is written only when its edge
        // reaches the next quarter device pixel instead of on every frame.
        const deviceWidth = trackDeviceWidthRef.current;
        const step = duration > 0 ? getProgressFillStep(clampedValue / duration, deviceWidth) : null;
        const fillMoved = force || step === null || step !== lastFillStepRef.current;
        if (progressRef.current && duration > 0 && fillMoved) {
            lastFillStepRef.current = step;
            const progress = step === null
                ? Math.min(1, clampedValue / duration)
                : getProgressFillStepFraction(step, deviceWidth);
            const hiddenPercent = ((1 - progress) * 100).toFixed(4);
            progressRef.current.style.clipPath = edgeStyle === 'square'
                ? `inset(0 ${hiddenPercent}% 0 0)`
                : `inset(0 ${hiddenPercent}% 0 0 round 999px)`;
            // The thumb is invisible unless a mod styles it. Its full-width carrier moves by
            // translateX (percent of its own width = the track), so this stays compositor-only.
            if (thumbRef.current) {
                thumbRef.current.style.transform = `translateX(${(progress * 100).toFixed(4)}%)`;
            }
        }

        if (timeRef.current && (force || lastDisplayedSecondRef.current !== displayedSecond)) {
            timeRef.current.textContent = formatTime(clampedValue);
            lastDisplayedSecondRef.current = displayedSecond;
        }

        if (syncInput && inputRef.current && (force || lastInputSecondRef.current !== displayedSecond)) {
            inputRef.current.value = clampedValue.toString();
            lastInputSecondRef.current = displayedSecond;
        }
    }, [duration, edgeStyle]);

    useLayoutEffect(() => {
        updateUI(currentTime.get(), true);
    }, [currentTime, updateUI]);

    useMotionValueEvent(currentTime, 'change', (latest: number) => {
        updateUI(latest);
    });

    // Tracks the fill's width in device pixels for the quarter-pixel steps; a resize repaints once.
    useLayoutEffect(() => {
        const fill = progressRef.current;
        if (!fill || typeof ResizeObserver === 'undefined') return;
        // device-pixel-content-box also fires when the window moves to a screen with another scale.
        const observer = new ResizeObserver(([entry]) => {
            const deviceWidth = entry?.devicePixelContentBoxSize?.[0]?.inlineSize
                ?? fill.getBoundingClientRect().width * (window.devicePixelRatio || 1);
            if (deviceWidth === trackDeviceWidthRef.current) return;
            trackDeviceWidthRef.current = deviceWidth;
            updateUI(currentTime.get(), true);
        });
        try {
            observer.observe(fill, { box: 'device-pixel-content-box' });
        } catch {
            observer.observe(fill);
        }
        return () => observer.disconnect();
    }, [currentTime, updateUI]);

    const handleInput = (e: React.FormEvent<HTMLInputElement>) => {
        if (disabled) {
            return;
        }
        const val = Number(e.currentTarget.value);
        updateUI(val, false, false, true);
        // iOS Safari bug: 点击的时候触发 pointerup 事件会早于 input 事件，导致点击失效
        // chromium：pointerdown → input → pointerup
        // iOS Safari：pointerdown → pointerup → input （why?）
        // 这里补偿一次 onSeek 进行适配
        if (!isDraggingRef.current) {
            onSeek(val);
        }
    };

    const handleSeekStart = (e: React.PointerEvent<HTMLInputElement>) => {
        // 只认主键：右键/中间键落到 range 上是浏览器自己的行为，不该进拖动态。
        if (disabled || e.button !== 0) return;
        isDraggingRef.current = true;
        settleRef.current = null;
        try {
            e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
            // 指针已经没了（例如被系统手势抢走、元素在这一下被卸载）。捕获失败不影响
            // input 事件本身；这里必须吞掉 —— 抛出去的话下面的 onSeekStart 不会执行，
            // 而 isDraggingRef 已经置真、没人复位，updateUI 会永远早退（进度条冻住）。
        }
        onSeekStart?.();
    };

    const handleSeekEnd = (e: React.PointerEvent<HTMLInputElement>) => {
        if (disabled) return;
        const value = Number(e.currentTarget.value);
        isDraggingRef.current = false;
        updateUI(value, true);
        onSeek(value);
        /*
         * 松手之后播放器回传真实位置要一点时间（要缓冲时更久）。这段窗口内继续停在新位置，
         * 否则进度条会先弹回旧位置再跳过去——看着就是「拖了没反应」（安卓真机反馈）。
         */
        settleRef.current = { value, expiresAt: Date.now() + SEEK_SETTLE_MS };
        onSeekEnd?.();
    };

    const handleSeekCancel = () => {
        isDraggingRef.current = false;
        updateUI(currentTime.get(), true);
        onSeekEnd?.();
    };

    const foliumCtx = useFoliumProgressContext({
        currentTime,
        duration,
        onSeek,
        disabled,
        colors: { fill: primaryColor, track: trackColor, text: secondaryColor },
    });

    return (
        <div
            className={`flex items-center w-full select-none ${isLine ? 'gap-2' : 'gap-3'}`}
            data-folium-part="progress.root"
            style={{
                '--folium-progress-fill': primaryColor,
                '--folium-progress-track': trackColor,
                '--folium-progress-text': secondaryColor,
            } as React.CSSProperties}
        >
            <FoliumProgressButtons slot="progress.leading" ctx={foliumCtx} collapsed={collapsed} />

            <span
                ref={timeRef}
                className={`text-[10px] font-mono font-medium opacity-60 w-8 text-right text-[var(--folium-progress-text)] ${isLine ? 'hidden' : ''}`}
                data-folium-part="progress.time"
            >
                00:00
            </span>

            <div
                className={`relative flex-1 flex items-center group bg-[var(--folium-progress-track)] ${isLine ? 'h-[3px]' : 'h-1.5'} ${edgeStyle === 'rounded' ? 'rounded-sm md:rounded-full' : ''} ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
                data-folium-part="progress.track"
            >
                <div
                    ref={progressRef}
                    className={`absolute top-0 left-0 h-full pointer-events-none bg-[var(--folium-progress-fill)] ${edgeStyle === 'rounded' ? 'rounded-sm md:rounded-full' : ''}`}
                    data-folium-part="progress.fill"
                    style={{
                        width: '100%',
                        clipPath: edgeStyle === 'square'
                            ? 'inset(0 100% 0 0)'
                            : 'inset(0 100% 0 0 round 999px)',
                        willChange: 'clip-path',
                    }}
                />
                <div
                    ref={thumbRef}
                    className="absolute inset-0 pointer-events-none"
                    style={{ transform: 'translateX(0%)', willChange: 'transform' }}
                >
                    <div
                        className="absolute top-1/2 left-0 w-3 h-3 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-0 bg-[var(--folium-progress-fill)]"
                        data-folium-part="progress.thumb"
                    />
                </div>
                <input
                    ref={inputRef}
                    type="range"
                    min={0} max={duration || 100}
                    step={0.1}
                    disabled={disabled}
                    defaultValue={0}
                    onPointerDown={handleSeekStart}
                    onPointerUp={handleSeekEnd}
                    onPointerCancel={handleSeekCancel}
                    onInput={handleInput}
                    onChange={() => { }} // React requires this
                    onClick={(e) => e.stopPropagation()}
                    /*
                     * `touch-none` 不能去掉：没有它，安卓会把这次拖动判成滚动并发出 pointercancel，
                     * 拖到一半就被取消，表现就是「拖不动」。
                     * 命中区要撑到轨道之外：默认档的轨道只有 6px 高，手指根本抓不住，所以上下各多给 8px。
                     */
                    className={`absolute w-full opacity-0 touch-none ${isLine ? 'inset-x-0 -top-1.5 h-[calc(100%+12px)]' : '-inset-y-2 h-[calc(100%+16px)]'} ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                />
                <FoliumProgressLayers ctx={foliumCtx} />
            </div>

            <span
                className={`text-[10px] font-mono font-medium opacity-60 w-8 text-[var(--folium-progress-text)] ${isLine ? 'hidden' : ''}`}
                data-folium-part="progress.duration"
            >
                {formatTime(duration)}
            </span>

            <FoliumProgressButtons slot="progress.trailing" ctx={foliumCtx} collapsed={collapsed} />
        </div>
    );
};

export default ProgressBar;
