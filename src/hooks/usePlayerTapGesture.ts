import { useCallback, useEffect, useRef } from 'react';
import { DOUBLE_TAP_MS, isDoubleTap, type TapEvent, type TapPoint } from '../utils/doubleTap';

// src/hooks/usePlayerTapGesture.ts
// 播放页可视层上的单击 / 双击：单击还是控件显隐，双击暂停 / 继续。
//
// 为什么单击要晚一个双击窗口再执行：单击和双击共用一个 click。第一下就立刻翻控件显隐的话，
// 双击暂停会顺带翻一次控件，用户看到的暂停状态和控件显隐对不上。所以第一下先压住，
// 等窗口过去确认没有第二下再执行；第二下落在窗口里就把它取消，只做暂停。
//
// 为什么数 click 而不是用 dblclick：安卓 WebView 里 dblclick 在 touch-action 定住的画布上
// 不一定落得下来，而 click 一定会有（见 utils/doubleTap）。
//
// 双击暂停在 HDR 投影和面板打开时关掉：那两处各自把「连点两下」用在了别处（HDR 是二次确认
// 退出投影，面板是第一下关面板）。这时单击不延迟，那两处的手感保持原样。

interface UsePlayerTapGestureOptions {
    enabled: boolean;
    onTap: () => void;
    onDoubleTap: () => void;
}

export interface PlayerTapGestureBinding {
    onClick: (event: TapEvent) => void;
    /** 滑动已经触发：取消还没执行的单击，也把双击的第一击清掉。 */
    resetTapSequence: () => void;
}

export function usePlayerTapGesture({ enabled, onTap, onDoubleTap }: UsePlayerTapGestureOptions): PlayerTapGestureBinding {
    const timerRef = useRef<number | null>(null);
    const lastTapRef = useRef<TapPoint | null>(null);

    const clearPendingTimer = useCallback(() => {
        if (timerRef.current === null) return;
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
    }, []);

    const resetTapSequence = useCallback(() => {
        clearPendingTimer();
        lastTapRef.current = null;
    }, [clearPendingTimer]);

    // 关掉（切视图、开面板、进 HDR）时，上一处压着的单击不该等回来再执行。
    useEffect(() => {
        if (!enabled) resetTapSequence();
    }, [enabled, resetTapSequence]);
    useEffect(() => clearPendingTimer, [clearPendingTimer]);

    const onClick = useCallback((event: TapEvent) => {
        if (!enabled) {
            onTap();
            return;
        }

        const now: TapPoint = { at: Date.now(), x: event.clientX, y: event.clientY };
        if (isDoubleTap(lastTapRef.current, now)) {
            clearPendingTimer();
            lastTapRef.current = null;
            onDoubleTap();
            return;
        }

        /*
         * 第二下离得远或来晚了，就是两次单击。先把上一次还压着的那一下补上，
         * 再让这一下进入自己的等待窗口。
         */
        if (timerRef.current !== null) {
            clearPendingTimer();
            onTap();
        }

        lastTapRef.current = now;
        // 多等 1ms：正好卡在窗口边上的第二下仍算双击（判定用 <=），不能抢先执行了第一下。
        timerRef.current = window.setTimeout(() => {
            timerRef.current = null;
            lastTapRef.current = null;
            onTap();
        }, DOUBLE_TAP_MS + 1);
    }, [clearPendingTimer, enabled, onDoubleTap, onTap]);

    return { onClick, resetTapSequence };
}
