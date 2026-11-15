import React, { useCallback, useRef, useState } from 'react';
import { GESTURE_SLOP_PX } from '../modal/settings/kit/sliderGesture';

// src/components/ui/Slider.tsx
//
// 应用自己的横滑杆。Folia 的滑杆只有这一种长相与手感，任何地方要一根滑杆都用它。
//
// ## 为什么不用浏览器原生 <input type="range">
//
// 原生滑杆在各平台长得都不一样（Android 上是一颗灰点 + 一段灰线），和 Folia 的主题
// 完全挂不上钩；而且它是「按下即跳」的，放在可滚动的面板里，手指想上下翻页、蹭到滑杆
// 就把值改了。自绘以后这两件事都由自己说了算。
//
// ## 手势：先判方向，再决定跟不跟手
//
// 和设置页那套（kit/sliderGesture）是同一个判定，因为要解决的是同一个问题：
//
//   - 按下后先攒够 GESTURE_SLOP_PX（手指落下去总会抖）；
//   - 竖向占主导 → 这是想滚面板，整个手势作废，值一个字都不动；
//   - 横向占主导 → 这是想调这个数，从这一刻起跟手；
//   - 一直是点一下 → 不动（鼠标例外：鼠标按哪就是哪，和原生一致）。
//
// ## 触摸热区
//
// 画出来的轨道只有 24px 高，但热区给到 44px（手指点按的通用下限）。按在轨道上下
// 一点点也仍然落在滑杆上，不会漏给外面的滚动容器 —— 漏出去的那一下在用户看来
// 就是「滑不动」。
//
// ## 配色
//
// 一律取主题变量（--st-accent / --st-track / --st-on-accent / --st-t1 / --st-t2），
// 不写死任何颜色：改主题色、切日夜这里都跟着变。圆点用强调色填充，不再是纯白 ——
// 纯白圆点在深色主题下是一块异物。

/** 轨道画出来的高度（rem）。 */
const TRACK_REM = 0.25;
/** 圆点直径（rem）。跟着根字号走：界面缩放调大，圆点跟着变宽。 */
const THUMB_REM = 1;
/** 触摸热区高度（rem）。比轨道高得多，手指按歪一点也算按中。 */
const HIT_REM = 2.75;
/** 方向键一次走多少。 */
const KEY_STEP = 0.05;

const rootFontPx = (): number => (
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
);

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

export type SliderProps = {
    /** 0..1。滑块只认这个区间，换算成实际刻度由调用方负责。 */
    value: number;
    /** 拖动过程中持续回调（用来实时预览）。 */
    onPreview: (value: number) => void;
    /** 松手 / 键盘落下时回调一次（用来落盘）。 */
    onCommit: () => void;
    /** 无障碍名称。 */
    label: string;
    /** 读数的文字，例如 "72%"。只给读屏用，视觉上由调用方自己排版。 */
    valueText?: string;
    /** 够不着：变淡，指针与键盘都动不了它；仍然可聚焦，读屏能读到它是不可用的。 */
    disabled?: boolean;
    /** 是否画出左侧那根默认值刻度（0..1）；不给就不画。 */
    defaultValue?: number;
    className?: string;
};

/**
 * 一根 Folia 滑杆。
 *
 * 只画滑杆本体（轨道 + 圆点），标题与读数由调用方排版 —— 这样它既能放进设置页那种
 * 「左边名称、右边读数、下面滑杆」的行里，也能放进更紧凑的地方。
 */
export const Slider: React.FC<SliderProps> = ({
    value,
    onPreview,
    onCommit,
    label,
    valueText,
    disabled = false,
    defaultValue,
    className,
}) => {
    const trackRef = useRef<HTMLDivElement>(null);
    const [isHeld, setIsHeld] = useState(false);
    const shown = clampUnit(value);
    /** 按下时指针离圆点中心多远（按在轨道上就是 0）。 */
    const grabRef = useRef(0);
    /** 上一次指针的位置，两个轴都记：完全没有位移的那些 move 不发值。 */
    const lastPointRef = useRef({ x: 0, y: 0 });
    /** 这一下手势被判成了什么。 */
    const phaseRef = useRef<'idle' | 'wait' | 'adjust' | 'scroll'>('idle');

    /** 圆点中心在 `centreX` 时对应的值（0..1）。 */
    const valueAt = useCallback((centreX: number): number => {
        const element = trackRef.current;
        if (!element) return shown;
        const rect = element.getBoundingClientRect();
        const thumb = rootFontPx() * THUMB_REM;
        const travel = Math.max(1, rect.width - thumb);
        return Math.round(clampUnit((centreX - rect.left - thumb / 2) / travel) * 100) / 100;
    }, [shown]);

    const release = useCallback(() => {
        // 够不着时，只有「变淡之前就已经按下去」的那一次才补一个 commit。
        if (disabled && !isHeld) {
            phaseRef.current = 'idle';
            return;
        }
        phaseRef.current = 'idle';
        setIsHeld(false);
        onCommit();
    }, [disabled, isHeld, onCommit]);

    const handleKeyDown = (event: React.KeyboardEvent) => {
        if (disabled) return;
        // 跳到下一格，而不是加一个步长：落在两个刻度之间的值能回到整数上。
        const next = event.key === 'ArrowRight' || event.key === 'ArrowUp'
            ? (Math.floor(shown / KEY_STEP + 1e-6) + 1) * KEY_STEP
            : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
                ? (Math.ceil(shown / KEY_STEP - 1e-6) - 1) * KEY_STEP
                : event.key === 'Home' ? 0
                    : event.key === 'End' ? 1
                        : null;
        if (next === null) return;
        event.preventDefault();
        onPreview(Math.round(clampUnit(next) * 100) / 100);
    };

    const thumb = rootFontPx() * THUMB_REM;

    return (
        <div
            ref={trackRef}
            role="slider"
            tabIndex={0}
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(shown * 100)}
            aria-valuetext={valueText}
            aria-disabled={disabled || undefined}
            onPointerDown={(event) => {
                if (disabled || event.button !== 0) return;
                lastPointRef.current = { x: event.clientX, y: event.clientY };
                const rect = event.currentTarget.getBoundingClientRect();
                const fromCentre = event.clientX - (rect.left + thumb / 2 + shown * (rect.width - thumb));
                if (event.pointerType === 'mouse') {
                    // 鼠标按哪就是哪，和原生控件一致；按在圆点上则保持原位，不动到抬手为止。
                    phaseRef.current = 'adjust';
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setIsHeld(true);
                    if (Math.abs(fromCentre) <= thumb / 2) {
                        grabRef.current = fromCentre;
                        return;
                    }
                    grabRef.current = 0;
                    onPreview(valueAt(event.clientX));
                    return;
                }
                /*
                 * 手指：先攒着，别急着改值。
                 *
                 * 这里**不立刻** setPointerCapture —— 要让竖向滑动交给外面那个滚动容器，
                 * 判出「横向」之后才接管。
                 */
                phaseRef.current = 'wait';
            }}
            onPointerMove={(event) => {
                if (disabled || phaseRef.current === 'idle') return;

                if (phaseRef.current === 'wait') {
                    const dx = event.clientX - lastPointRef.current.x;
                    const dy = event.clientY - lastPointRef.current.y;
                    if (Math.abs(dx) < GESTURE_SLOP_PX && Math.abs(dy) < GESTURE_SLOP_PX) return;
                    if (Math.abs(dy) > Math.abs(dx)) {
                        // 主要在上下走：这是想滚面板，这一下不算调值。
                        phaseRef.current = 'scroll';
                        return;
                    }
                    // 判为横向：从这里接管手势，之后无论怎么拖都不再交还给滚动容器。
                    phaseRef.current = 'adjust';
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setIsHeld(true);
                    const rect = event.currentTarget.getBoundingClientRect();
                    const centre = rect.left + thumb / 2 + shown * (rect.width - thumb);
                    const fromCentre = event.clientX - (event.clientX - lastPointRef.current.x) - centre;
                    grabRef.current = Math.abs(fromCentre) <= thumb / 2 ? fromCentre : 0;
                }

                if (phaseRef.current === 'scroll') return;

                const dx = event.clientX - lastPointRef.current.x;
                const dy = event.clientY - lastPointRef.current.y;
                if (dx === 0 && dy === 0) return;
                lastPointRef.current = { x: event.clientX, y: event.clientY };
                onPreview(valueAt(event.clientX - grabRef.current));
            }}
            onPointerUp={release}
            onPointerCancel={release}
            onLostPointerCapture={release}
            onKeyDown={handleKeyDown}
            onKeyUp={disabled ? undefined : onCommit}
            onBlur={release}
            className={`relative min-w-0 flex-1 touch-pan-y select-none ${disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'} ${className ?? ''}`}
            style={{ height: `${HIT_REM}rem` }}
        >
            {/* 轨道：颜色取主题变量，改主题色 / 切日夜都跟着变 */}
            <span
                className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 overflow-hidden rounded-full bg-[var(--st-track)]"
                style={{ height: `${TRACK_REM}rem` }}
            >
                <span
                    className="absolute inset-0 origin-left rounded-full bg-[var(--st-accent)]"
                    style={{ transform: `scaleX(${shown})` }}
                />
            </span>
            {/* 默认值刻度：一根细线贴着轨道，位置与圆点的行程一致 */}
            {defaultValue !== undefined && (
                <span
                    aria-hidden
                    className="pointer-events-none absolute top-1/2 h-2 w-px -translate-y-1/2 rounded-full bg-[var(--st-t3)] opacity-60"
                    style={{ left: `calc(${clampUnit(defaultValue)} * (100% - ${THUMB_REM}rem) + ${THUMB_REM / 2}rem)` }}
                />
            )}
            {/* 圆点：强调色填充，外圈取「强调色上该用的前景色」，不是一块写死的白 */}
            <span
                className="pointer-events-none absolute top-1/2 rounded-full transition-transform duration-150"
                style={{
                    left: `calc(${shown} * (100% - ${THUMB_REM}rem))`,
                    width: `${THUMB_REM}rem`,
                    height: `${THUMB_REM}rem`,
                    transform: `translateY(-50%)${isHeld ? ' scale(1.15)' : ''}`,
                    background: 'var(--st-accent)',
                    boxShadow: '0 0 0 1px color-mix(in srgb, var(--st-on-accent) 45%, transparent), 0 1px 4px rgba(0, 0, 0, 0.28)',
                }}
            />
        </div>
    );
};

export default Slider;
