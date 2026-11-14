import { useCallback, useEffect, useRef, useState } from 'react';
import {
    HDR_EXIT_CONFIRM_WINDOW_MS,
    readStoredHdrProjection,
    subscribeHdrProjection,
} from '../services/hdrProjection';
import { setStatusMessage } from '../stores/useStatusMessageStore';

// src/hooks/useHdrProjectionExit.ts
// HUD 投影下「点一下空白把界面收起来」的二次确认。
//
// 投到挡风玻璃上时屏幕是反着看的，误触的概率比平时高得多：界面一收，反射里就只剩
// 一块黑，用户连该点哪儿把它叫回来都看不出来。所以第一次点只弹一句提示，再点一次
// 才真的收。
//
// **不铺全屏遮罩**：确认层一旦自己接管指针事件，歌词页的左右滑动切歌就被它吃掉了
// （而且不止横向 —— 纵向拖歌词轨那一路也会被拦）。这里只弹一条不吃事件的提示条，
// click 仍然是视觉层那一个，滑动照旧走 usePlayerSwipeGesture 那套指针事件 ——
// 切完歌浏览器补的那个 click 也照旧被 consumeSuppressedClick 吃掉，不会被当成
// 「点了第二次」。

/** 当前是不是 HUD 投影（跟着开关走，改了会通知）。 */
export const useHdrProjectionActive = (): boolean => {
    const [active, setActive] = useState(() => readStoredHdrProjection());
    useEffect(() => subscribeHdrProjection(setActive), []);
    return active;
};

/**
 * 把「点空白要做的事」包一层确认。
 *
 * 返回的函数吃一个动作：HDR 关着就直接做；开着的话第一次只弹提示，窗口期内第二次才做。
 */
export const useHdrExitConfirm = (options: {
    enabled: boolean;
    /** 第一次点弹的那句话。 */
    hint: string;
}): ((action: () => void) => void) => {
    const { enabled, hint } = options;
    const armedRef = useRef(false);
    const timerRef = useRef<number | null>(null);

    const disarm = useCallback(() => {
        armedRef.current = false;
        if (timerRef.current !== null) {
            window.clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    useEffect(() => disarm, [disarm]);

    /*
     * 动作从参数进，不进依赖：调用方每帧给的都是一个新的箭头函数，进依赖的话这层
     * 确认会跟着重建，刚攒起来的「已提示」当场失效。
     */
    return useCallback((action: () => void) => {
        if (!enabled) {
            action();
            return;
        }
        if (armedRef.current) {
            disarm();
            action();
            return;
        }
        armedRef.current = true;
        /*
         * 这条提示**不吃点击**（`inert`）。
         *
         * 提示条浮在可视化那一层上面，默认是 `pointer-events: auto` —— 用户顺着刚才点
         * 的地方再补一下，那一下会被提示条自己吃掉，根本到不了视觉层；3 秒窗口一过又
         * 回到「第一次点」，于是就成了「一直提示再点一次，怎么也退不出去」。
         * 让点击穿过去，点它跟点空白是同一回事，「点任意处继续退出」才成立。
         */
        setStatusMessage({ type: 'info', text: hint, nonce: Date.now(), inert: true });
        timerRef.current = window.setTimeout(() => {
            // 过期就回到「第一次点」：那一下多半是误触（手机在颠，屏幕还是反的）。
            disarm();
        }, HDR_EXIT_CONFIRM_WINDOW_MS);
    }, [disarm, enabled, hint]);
};
