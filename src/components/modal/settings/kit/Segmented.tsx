import React, { useId, useRef } from 'react';
import { motion, useMotionValue, useSpring } from 'framer-motion';
import { kitTransition, useKitReducedMotion } from './motion';
import { useRowAria } from './Row';

// src/components/modal/settings/kit/Segmented.tsx
// A choice between two to four short options, all of them in view. The raised mark under the
// chosen one slides to a new choice. It is as wide as its options need, or, asked to fill, as wide
// as the place it is in.
//
// 滑动选择：按住后在选项间横向滑动，滑到哪个选项就选中哪个（胶囊跟着 layout 动画滑过去）；
// 松手即停在滑到的那个。竖向滑动不抢——手势开始后竖向位移先超过横向就放弃，把指针还给滚动。
// 滑动时胶囊带一点果冻形变：按拖动方向拉伸，松手弹簧回弹（幅度收着，别盖过选中态本身）。

type SegmentedProps<T extends string> = {
    /** The chosen value; none is marked when it is not among the options. */
    value: T;
    /** `icon`: a small picture before the option's label. */
    options: ReadonlyArray<{ value: T; label: string; disabled?: boolean; icon?: React.ReactNode }>;
    /** Called for a new choice, not for a click on the one already chosen. */
    onChange: (value: T) => void;
    /** As wide as the place it is in, each option an equal share of it. */
    fill?: boolean;
    /** The whole choice is dimmed and out of reach; one option alone has its own `disabled`. */
    disabled?: boolean;
};

/** 起手容差（px）：横向滑过这个距离才算选中手势，短促的点按不触发滑动逻辑。 */
const SWEEP_SLOP = 6;
/** 竖向让位（px）：竖向位移超过这个比例的横向位移时放手给滚动。 */
const SWEEP_YIELD_RATIO = 1.2;

export const Segmented = <T extends string>({ value, options, onChange, fill, disabled }: SegmentedProps<T>): React.ReactElement => {
    const markId = useId();
    const reduced = useKitReducedMotion();
    const rootRef = useRef<HTMLDivElement>(null);

    // —— 滑动选择会话 ——
    const pointerIdRef = useRef<number | null>(null);
    const startXRef = useRef(0);
    const startYRef = useRef(0);
    const activeRef = useRef(false); // 过了 slop、正式开始的滑动
    const deadRef = useRef(false); // 竖向让位，本次按下不再做滑动选择
    // 本次滑动最近一次真正切换过去的选项：拖动中同一选项不重复调 onChange。
    const lastSweptRef = useRef<T | null>(null);

    // —— 胶囊果冻 ——
    // scaleX 沿拖动方向拉伸，scaleY 反向回缩（果冻的体积感）；都走弹簧，松手回 1。
    const scaleX = useMotionValue(1);
    const scaleY = useMotionValue(1);
    const springConfig = { stiffness: 700, damping: 30, mass: 0.5 };
    const springX = useSpring(scaleX, springConfig);
    const springY = useSpring(scaleY, springConfig);

    /** 指针当前落在哪个选项上；不在任何选项里返回 null。 */
    const optionAt = (clientX: number, clientY: number): T | null => {
        const root = rootRef.current;
        if (!root) return null;
        for (const option of options) {
            if (option.disabled) continue;
            const el = root.querySelector<HTMLElement>(`[data-seg-value="${option.value}"]`);
            if (!el) continue;
            const rect = el.getBoundingClientRect();
            if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
                return option.value;
            }
        }
        return null;
    };

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (disabled || pointerIdRef.current !== null) return;
        // 触屏的多指只认主指针；触摸由 touchmove 续跟（浏览器接管手势会发 pointercancel）。
        if (e.pointerType === 'touch' && !e.isPrimary) return;
        pointerIdRef.current = e.pointerId;
        startXRef.current = e.clientX;
        startYRef.current = e.clientY;
        activeRef.current = false;
        deadRef.current = false;
        lastSweptRef.current = null;
    };

    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (pointerIdRef.current !== e.pointerId || deadRef.current) return;
        const dx = e.clientX - startXRef.current;
        const dy = e.clientY - startYRef.current;
        // 竖向让位要一直判，不能只在起手时判一次：起手是横向、后面转成竖向（页面滚动）时
        // 也得放手，否则滚动中手指划过别的选项会偷偷改设置。
        if (Math.abs(dy) > Math.abs(dx) * SWEEP_YIELD_RATIO + SWEEP_SLOP) {
            deadRef.current = true;
            scaleX.set(1);
            scaleY.set(1);
            return;
        }
        if (!activeRef.current) {
            if (Math.abs(dx) < SWEEP_SLOP) return;
            activeRef.current = true;
        }
        // 果冻：拉伸量跟横向位移，封顶 ~6%；纵向轻微回缩。
        const stretch = Math.max(-0.06, Math.min(0.06, dx / 900));
        scaleX.set(1 + Math.abs(stretch));
        scaleY.set(1 - Math.abs(stretch) * 0.6);
        // 滑到哪个选项就选中哪个。只在越过选项边界时才调一次 onChange：拖动期间每个
        // pointermove 都写一次会让切主题/切语言这类重的 onChange 反复执行。
        const hovered = optionAt(e.clientX, e.clientY);
        if (hovered && hovered !== value && hovered !== lastSweptRef.current) {
            lastSweptRef.current = hovered;
            onChange(hovered);
        }
    };

    const endGesture = () => {
        if (pointerIdRef.current === null) return;
        pointerIdRef.current = null;
        activeRef.current = false;
        deadRef.current = false;
        // 松手：果冻目标回 1，弹簧把形变收回去。
        scaleX.set(1);
        scaleY.set(1);
    };

    return (
        <div
            ref={rootRef}
            role="group"
            {...useRowAria()}
            aria-disabled={disabled || undefined}
            className={`${fill ? 'flex w-full' : 'inline-flex max-w-full flex-wrap'} min-h-8 touch-pan-y rounded-lg bg-[var(--st-fill)] p-0.5${disabled ? ' pointer-events-none opacity-40' : ''}`}
            onPointerDown={disabled ? undefined : onPointerDown}
            onPointerMove={disabled ? undefined : onPointerMove}
            onPointerUp={disabled ? undefined : endGesture}
            onPointerCancel={disabled ? undefined : endGesture}
            onPointerLeave={disabled ? undefined : (e) => {
                // 触屏上 pointer 会被浏览器接管（滚动），离开即收摊；鼠标离开仍继续跟（回到容器继续选）。
                if (e.pointerType !== 'mouse') endGesture();
            }}
        >
            {options.map(option => {
                const selected = option.value === value;
                return (
                    <button
                        key={option.value}
                        type="button"
                        data-seg-value={option.value}
                        aria-pressed={selected}
                        disabled={disabled || option.disabled}
                        onClick={() => {
                            if (!selected) onChange(option.value);
                        }}
                        className={`st-t-fast relative h-7 whitespace-nowrap rounded-md text-[13px] transition-colors disabled:cursor-not-allowed ${fill ? 'min-w-0 flex-1 px-1.5' : 'px-3'}${option.disabled ? ' opacity-40' : ''} ${selected ? 'text-[color:var(--st-t1)]' : 'text-[color:var(--st-t2)] enabled:hover:text-[color:var(--st-t1)]'}`}
                    >
                        {selected && (
                            // One element shared by the options: framer-motion moves it from the old
                            // choice to the new one, and only when the choice changes. Radius and
                            // shadow are in `style` so it can keep them true while it stretches
                            // between options of different widths.
                            // 滑动时果冻形变挂在胶囊上：scaleX/scaleY 走弹簧，与 layout 动画叠加
                            //（framer 的 layout 管位移，这里的 scale 管形变，互不干扰）。
                            <motion.span
                                layoutId={markId}
                                layoutDependency={value}
                                transition={kitTransition('move', reduced)}
                                style={{
                                    borderRadius: 6,
                                    boxShadow: '0 1px 2px rgba(0, 0, 0, 0.2)',
                                    scaleX: springX,
                                    scaleY: springY,
                                }}
                                className="absolute inset-0 bg-[var(--st-raise)]"
                            />
                        )}
                        {option.icon
                            ? <span className="relative inline-flex min-w-0 items-center gap-1.5">{option.icon}<span className="truncate">{option.label}</span></span>
                            : <span className={fill ? 'relative block truncate' : 'relative'}>{option.label}</span>}
                    </button>
                );
            })}
        </div>
    );
};

export default Segmented;
