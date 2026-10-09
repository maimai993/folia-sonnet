import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { MotionValue, useMotionValueEvent } from 'framer-motion';
import { FoliumControlButtonSlot, FoliumProgressLayers, useFoliumProgressContext } from '../mods/folium/registries/progress';

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
}


/*
 * 松手之后，播放器回传真实位置要一点时间（要缓冲的时候更久）。这段窗口内继续停在
 * 刚拖到的位置上，否则进度条会先弹回旧位置再跳过去 —— 看着就是「拖了没反应」。
 */
const SEEK_SETTLE_MS = 700;
const SEEK_SETTLE_TOLERANCE_SEC = 0.4;

const formatTime = (time: number) => {
    if (isNaN(time)) return "00:00";
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
}) => {
    const progressRef = useRef<HTMLDivElement>(null);
    const thumbRef = useRef<HTMLDivElement>(null);
    const timeRef = useRef<HTMLSpanElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const isDraggingRef = useRef(false);
    const lastDisplayedSecondRef = useRef<number | null>(null);
    const lastInputSecondRef = useRef<number | null>(null);
    /** 刚拖到的位置与它的保鲜期；见 SEEK_SETTLE_MS。 */
    const settleRef = useRef<{ value: number; expiresAt: number } | null>(null);
    // 拖动中把把手放大。一次拖动只翻转两次，进 React 更新路径的代价可以忽略。
    const [isScrubbing, setIsScrubbing] = useState(false);

    // Keeps continuous progress on the compositor while coarse values update only when needed.
    const updateUI = useCallback((value: number, force = false, syncInput = true, bypassDrag = false) => {
        const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
        const clampedValue = duration > 0 ? Math.min(safeValue, duration) : safeValue;
        const displayedSecond = Math.floor(clampedValue);

        if (!bypassDrag) {
            if (isDraggingRef.current) return;
            const settle = settleRef.current;
            if (settle && !force) {
                const arrived = Math.abs(clampedValue - settle.value) <= SEEK_SETTLE_TOLERANCE_SEC;
                if (arrived || Date.now() >= settle.expiresAt) {
                    settleRef.current = null;
                } else {
                    return;
                }
            }
        }

        // Nothing is painted without a duration, and that is the fix for the flash at the start of
        // a blend: the app switches to the incoming track the moment the overlap begins, but its
        // duration arrives a beat later - automix logs the same gap as `no duration for this track
        // yet`. Treating unknown as zero drew one frame of empty bar and then snapped back, which
        // reads as the bar being re-created. Holding the last fill for those few frames is the only
        // honest option: the fraction is genuinely unknown until the denominator exists.
        if (progressRef.current && duration > 0) {
            const progress = Math.min(1, clampedValue / duration);
            const hiddenPercent = ((1 - progress) * 100).toFixed(4);
            progressRef.current.style.clipPath = edgeStyle === 'square'
                ? `inset(0 ${hiddenPercent}% 0 0)`
                : `inset(0 ${hiddenPercent}% 0 0 round 999px)`;
            // 把手的载体铺满整条轨道，靠 translateX（按自身宽度百分比 = 轨道长度）移动，
            // 全程只在合成器上跑。把手本身默认可见 —— 一条没有把手的细线看不出能拖。
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

    useMotionValueEvent(currentTime, "change", (latest: number) => {
        updateUI(latest);
    });

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
        if (disabled || e.button !== 0) return;
        isDraggingRef.current = true;
        settleRef.current = null;
        setIsScrubbing(true);
        try {
            e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
            // 指针已经没了（例如被系统手势抢走）。捕获失败不影响 input 事件本身。
        }
        onSeekStart?.();
    };

    const handleSeekEnd = (e: React.PointerEvent<HTMLInputElement>) => {
        if (disabled) return;
        const value = Number(e.currentTarget.value);
        isDraggingRef.current = false;
        setIsScrubbing(false);
        settleRef.current = { value, expiresAt: Date.now() + SEEK_SETTLE_MS };
        updateUI(value, true);
        onSeek(value);
        onSeekEnd?.();
    };

    const handleSeekCancel = () => {
        isDraggingRef.current = false;
        setIsScrubbing(false);
        settleRef.current = null;
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
            className="flex items-center gap-3 w-full select-none"
            data-folium-part="progress.root"
            style={{
                '--folium-progress-fill': primaryColor,
                '--folium-progress-track': trackColor,
                '--folium-progress-text': secondaryColor,
            } as React.CSSProperties}
        >
            <FoliumControlButtonSlot slot="progress.leading" ctx={foliumCtx} collapsed={collapsed} />

            <span
                ref={timeRef}
                className="text-[10px] font-mono font-medium opacity-60 w-8 text-right text-[var(--folium-progress-text)]"
                data-folium-part="progress.time"
            >
                00:00
            </span>

            <div
                className={`relative h-1.5 flex-1 flex items-center group bg-[var(--folium-progress-track)] ${edgeStyle === 'rounded' ? 'rounded-sm md:rounded-full' : ''} ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
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
                        className={`absolute top-1/2 left-0 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--folium-progress-fill)] shadow transition-[width,height] duration-150 ${isScrubbing ? 'w-3.5 h-3.5' : 'w-2.5 h-2.5'}`}
                        data-folium-part="progress.thumb"
                        data-scrubbing={isScrubbing ? 'true' : undefined}
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
                    // 命中区向外撑开：轨道只有 6px 高，手指根本抓不住。撑到 22px 为止 ——
                    // 再往上会越过 gap 盖住上面一排按钮的底边，把播放键的点击吃掉。
                    // touch-none 是关键：没有它，Android 会把这次拖动判成滚动并发出
                    // pointercancel，拖到一半就被取消，表现就是「拖不动」。
                    className={`absolute -inset-y-2 inset-x-0 w-full touch-none opacity-0 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                />
                <FoliumProgressLayers ctx={foliumCtx} />
            </div>

            <span
                className="text-[10px] font-mono font-medium opacity-60 w-8 text-[var(--folium-progress-text)]"
                data-folium-part="progress.duration"
            >
                {formatTime(duration)}
            </span>

            <FoliumControlButtonSlot slot="progress.trailing" ctx={foliumCtx} collapsed={collapsed} />
        </div>
    );
};

export default ProgressBar;
