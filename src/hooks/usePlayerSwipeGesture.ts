// src/hooks/usePlayerSwipeGesture.ts
// 歌词页（播放页）视觉层上的左右滑动切歌。
//
// 两条容易踩的线：
//
//  1. 触发后浏览器照旧会在松手时补一个 click。歌词页空白的 click 是「控件显隐
//     翻转」（App.tsx 的 handleVisualSurfaceClick），不吃掉的话每切一首歌控件
//     的显隐就翻一次 —— 所以这里留了 suppressClickRef，由 click 处理器先问一句
//     consumeSuppressedClick()。
//
//  2. 只在横向明显主导时才算数（判定见 utils/playerSwipeGesture），否则会和
//     Monet 歌词轨那种纵向 touchmove 抢事件。
//
// 判定本身是纯函数，不碰 DOM 也不碰 React —— 单测直接测那个。

import { useCallback, useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { resolvePlayerSwipe, type PlayerSwipePoint } from '../utils/playerSwipeGesture';

interface UsePlayerSwipeGestureOptions {
    enabled: boolean;
    onNext: () => void;
    onPrev: () => void;
}

export interface PlayerSwipeGestureBinding {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
    /** click 处理器开头先问一句：这次 click 是刚才那次滑动的尾巴吗？问过即作废。 */
    consumeSuppressedClick: () => boolean;
}

export function usePlayerSwipeGesture({ enabled, onNext, onPrev }: UsePlayerSwipeGestureOptions): PlayerSwipeGestureBinding {
    const startRef = useRef<PlayerSwipePoint | null>(null);
    // 这次手势属于哪根手指。安卓上多指同时触屏很常见（扶着手机的手、搭在屏幕边上的
    // 手指），簿记不分指针的话：第二根手指一落就抢走起点、抹掉 triggeredRef，两根手指
    // 的移动又都拿来跟同一个起点比 —— 静止手指的抖动会乱切歌，同一次触碰还会连切。
    const pointerIdRef = useRef<number | null>(null);
    const triggeredRef = useRef(false);
    // 这个标记要活过 pointerup —— click 是在它之后才到的，所以收尾时不能清它。
    const suppressClickRef = useRef(false);

    const finish = useCallback(() => {
        startRef.current = null;
        pointerIdRef.current = null;
        triggeredRef.current = false;
    }, []);

    const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
        // 已经有手指在跟就不再接新的：换起点会把原手势的几何整个打乱；也不能顺手重置
        // suppressClickRef，那会把刚触发那下滑的 click 放出来。
        /*
         * 上一次手势可能**没收到收尾**：目标元素被换掉（换歌时可视化层重建）、
         * pointerup 落在别的元素上、或者页面在这一手中间重新挂载。那时候 startRef 一直
         * 不为空，之后每一次 pointerdown 都会在这里被忽略 —— 滑动从此彻底不响应，
         * 而且一路带到下一首。同一根指针又来一次 down，就说明那一手早结束了：重置再开始。
         *
         * 兜底主要靠 window 捕获阶段的 pointerup / pointercancel（见下面的 effect），
         * 这里只是「同一根指针又按下」的那一条。
         */
        if (startRef.current !== null) {
            if (event.pointerId !== pointerIdRef.current) return;
            startRef.current = null;
            pointerIdRef.current = null;
            triggeredRef.current = false;
            suppressClickRef.current = false;
        }
        suppressClickRef.current = false;
        if (!enabled) return;
        // 场景（SceneHost）铺满整块播放页时，这一手是拿来转头看的，不是切歌：不接管，
        // 否则往左划一下歌就换了，而用户以为只是把视线转过去。用场景自己的标记，
        // 不能借 data-takes-drag —— 那个的意思是「别转视角」，正相反。
        if (event.target instanceof Element && event.target.closest('[data-scene-look]')) return;
        startRef.current = { x: event.clientX, y: event.clientY };
        pointerIdRef.current = event.pointerId;
        triggeredRef.current = false;
    }, [enabled]);

    const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
        const start = startRef.current;
        if (!enabled || !start || triggeredRef.current || event.pointerId !== pointerIdRef.current) return;
        const direction = resolvePlayerSwipe(start, { x: event.clientX, y: event.clientY });
        if (!direction) return;
        // 一次手势只切一首：手指继续往同一边划不该连切。
        triggeredRef.current = true;
        suppressClickRef.current = true;
        if (direction === 'next') onNext();
        else onPrev();
    }, [enabled, onNext, onPrev]);

    const onPointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
        // 别的手指抬起不算收尾 —— 不然它一松手，还在滑的那根手指就断了。
        if (event.pointerId !== pointerIdRef.current) return;
        finish();
    }, [finish]);
    const onPointerCancel = useCallback((event: ReactPointerEvent<HTMLElement>) => {
        if (event.pointerId !== pointerIdRef.current) return;
        finish();
    }, [finish]);

    /*
     * 收尾兜底：pointerup / pointercancel 也挂在 window 上（捕获阶段）。
     *
     * 视觉层上的那一发在元素被换掉之后不一定会到（换歌会重建可视化层），而收尾丢了就是
     * 「手势从此瘫掉」。这里只认这一手的那根指针，别的手指抬起照旧不算收尾。
     */
    useEffect(() => {
        const release = (event: PointerEvent) => {
            if (pointerIdRef.current === null || event.pointerId !== pointerIdRef.current) return;
            finish();
        };
        window.addEventListener('pointerup', release, true);
        window.addEventListener('pointercancel', release, true);
        return () => {
            window.removeEventListener('pointerup', release, true);
            window.removeEventListener('pointercancel', release, true);
        };
    }, [finish]);

    const consumeSuppressedClick = useCallback(() => {
        if (!suppressClickRef.current) return false;
        suppressClickRef.current = false;
        return true;
    }, []);

    return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, consumeSuppressedClick };
}
