import { useCallback, useRef } from 'react';

// src/components/modal/settings/kit/sliderGesture.ts
// 滑条的手势判定：按下去先不动，看第一段位移往哪走，再决定这一下算什么。
//
// 原生 `<input type="range">` 是「按下即跳」的 —— 指针一落到轨道上值就变了，onChange 当场
// 发出去。放在设置页里就是：手指本来是想上下滚页面的，蹭到滑条就把数值改掉了，而界面上不
// 给一点提示，等发现时已经不知道原来是多少。
//
// 所以按下之后先攒着，判出方向再说：
//   竖向占主导 → 这是想滚页面，整个手势作废，值一个字都不动；
//   横向占主导 → 这是想调这个数值，从这一刻起跟手；
//   一直没攒够门槛（就是点了一下而已）→ 同样不动。
//
// 判方向只决定「要不要把这一下算成改值」，不改原生拖动本身：横向拖的时候原生照旧带着
// 拇指走，竖向拖的时候浏览器把这次手势收去滚页面（touch-action: pan-y，见 kit.css），
// 元素收到的 pointercancel 把手势收尾。

/** 判出方向之前要攒够的位移：手指落下去总会抖一下，这一小段不算数。 */
export const GESTURE_SLOP_PX = 8;

/** 拇指 16px 宽：它的中心停在离轨道两端这么远的地方。 */
export const SLIDER_THUMB_INSET = 8;

/** 离一个刻度多近（px，按拇指的行程折算成值的单位）算贴住它。 */
const MARK_REACH = 6;

const decimalsOf = (value: number) => (String(value).split('.')[1] ?? '').length;

/** `value` 落回轨道能表示的样子：夹在 min 与 max 之间，且是从 min 数起的整步。 */
export const sliderValueOnTrack = (value: number, min: number, max: number, step: number): number => {
    const stepped = min + Math.round((Math.min(max, Math.max(min, value)) - min) / step) * step;
    return Number(Math.min(max, stepped).toFixed(Math.max(decimalsOf(step), decimalsOf(min))));
};

/** 一次拖动落在哪：离某个刻度够近就吸上去，否则落在指针处。 */
export const landOnMark = (value: number, marks: ReadonlyArray<number>, reach: number): number => {
    const nearest = marks.reduce<number | null>((best, mark) => (
        best === null || Math.abs(mark - value) < Math.abs(best - value) ? mark : best
    ), null);
    return nearest !== null && Math.abs(nearest - value) <= reach ? nearest : value;
};

/**
 * What a press on a slider means, decided from the first stretch it moves. A press that is let go
 * where it landed is a click, so a mouse still jumps the thumb there as the native control does; a
 * finger gets nothing, because a finger landing on a track is far more often a scroll of the page
 * that happened to touch it.
 */
type GesturePhase = 'idle' | 'wait' | 'adjust' | 'scroll';

type UseSliderGestureArgs = {
    min: number;
    max: number;
    step: number;
    onChange: (value: number) => void;
    disabled?: boolean;
    /** Marks the thumb lands on while a pointer drags it; the arrow keys still walk the step. */
    marks?: ReadonlyArray<number>;
};

/** The handlers a range input is spread with, and the ref it is reached through. */
export type SliderGesture = {
    inputRef: React.RefObject<HTMLInputElement | null>;
    handlers: {
        onPointerDown: (event: React.PointerEvent<HTMLInputElement>) => void;
        onPointerMove: (event: React.PointerEvent<HTMLInputElement>) => void;
        onPointerUp: (event: React.PointerEvent<HTMLInputElement>) => void;
        onPointerCancel: (event: React.PointerEvent<HTMLInputElement>) => void;
        onLostPointerCapture: (event: React.PointerEvent<HTMLInputElement>) => void;
        onBlur: () => void;
        onKeyDown: () => void;
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
    };
};

export const useSliderGesture = ({ min, max, step, onChange, disabled, marks }: UseSliderGestureArgs): SliderGesture => {
    const inputRef = useRef<HTMLInputElement>(null);
    const phase = useRef<GesturePhase>('idle');
    const origin = useRef({ x: 0, y: 0, id: -1 });

    /** Where the pointer stands, in the value's unit: the thumb's travel, from one end to the other. */
    const valueAt = useCallback((clientX: number, element: HTMLInputElement) => {
        const rect = element.getBoundingClientRect();
        const travel = Math.max(1, rect.width - 2 * SLIDER_THUMB_INSET);
        const ratio = Math.min(1, Math.max(0, (clientX - rect.left - SLIDER_THUMB_INSET) / travel));
        const landed = sliderValueOnTrack(min + ratio * (max - min), min, max, step);
        if (!marks?.length) return landed;
        return landOnMark(landed, marks, ((max - min) * MARK_REACH) / travel);
    }, [marks, max, min, step]);

    const reset = useCallback(() => {
        phase.current = 'idle';
        origin.current = { x: 0, y: 0, id: -1 };
    }, []);

    const onPointerDown = useCallback((event: React.PointerEvent<HTMLInputElement>) => {
        if (disabled) return;
        // A press on a mark's name: that is a button, and it says where to go itself.
        if ((event.target as Element).closest?.('button')) return;
        origin.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
        // Taken so the arrow keys work from here on; the pointer's own moves are told below. Taken
        // without a scroll, or a tap low in the page would pull the row up to the thumb's height.
        inputRef.current?.focus({ preventScroll: true });
        if (event.pointerType === 'mouse') {
            // A mouse presses where it means: jump there, as the native control does.
            phase.current = 'adjust';
            onChange(valueAt(event.clientX, event.currentTarget));
        } else {
            phase.current = 'wait';
        }
    }, [disabled, onChange, valueAt]);

    const onPointerMove = useCallback((event: React.PointerEvent<HTMLInputElement>) => {
        if (phase.current === 'idle' || origin.current.id !== event.pointerId) return;
        if (phase.current === 'wait') {
            const dx = event.clientX - origin.current.x;
            const dy = event.clientY - origin.current.y;
            if (Math.abs(dx) < GESTURE_SLOP_PX && Math.abs(dy) < GESTURE_SLOP_PX) return;
            // Mostly up or down: a scroll of the page, not a hand on the thumb.
            if (Math.abs(dy) > Math.abs(dx)) {
                phase.current = 'scroll';
                return;
            }
            phase.current = 'adjust';
        } else if (phase.current === 'scroll') {
            return;
        }
        onChange(valueAt(event.clientX, event.currentTarget));
    }, [onChange, valueAt]);

    const onChangeFromKeyboard = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        // While a pointer is down the value comes from its moves; only the keyboard (no pointer
        // about) goes through the input's own change.
        if (phase.current !== 'idle') return;
        onChange(Number(event.currentTarget.value));
    }, [onChange]);

    return {
        inputRef,
        handlers: {
            onPointerDown,
            onPointerMove,
            onPointerUp: reset,
            onPointerCancel: reset,
            onLostPointerCapture: reset,
            onBlur: reset,
            onKeyDown: reset,
            onChange: onChangeFromKeyboard,
        },
    };
};
