import { useEffect, useRef, type RefObject } from 'react';
import { usePonderStore } from '../stores/usePonderStore';
import { hasBlockingWindow, isTextEntryTarget } from '../utils/keyboardTargets';

// src/hooks/usePonderHoldToEnter.ts
// 长按 G 进入思索的状态机。
//
// 进度用 WAAPI（element.animate）而不是 anime.js：胶囊在常驻链路上，把 animejs 拉进来
// 等于把那个 ~38KB 的 chunk 塞回 bootstrap，正是 App.tsx:20-22 那条注释在防的事。
// element.animate 本来也是这个仓库做这类释放反馈的手法（UnifiedPanel 的滑动回弹）。
//
// @note 长按 G 只属于非文本控件。输入框（包括命令面板搜索框）必须继续正常输入 g；
// 页面级入口由 Ctrl+G 承担，因此这里不需要再从文本输入中抢走可打印字符。

const HOLD_DURATION_MS = 400;

const BLOCKING_WINDOW_SELECTOR = '[data-folia-keyboard-window="true"]';

type PonderHoldRefs = {
    hoveredElementRef: RefObject<Element | null>;
    /** 胶囊里那道从左到右的高亮擦除。 */
    wipeRef: RefObject<HTMLElement | null>;
    /** 「按 G 思索」。 */
    labelRef: RefObject<HTMLElement | null>;
    /** 「进入思索」，压在上面淡入。 */
    holdLabelRef: RefObject<HTMLElement | null>;
};

export const usePonderHoldToEnter = ({
    hoveredElementRef,
    wipeRef,
    labelRef,
    holdLabelRef,
}: PonderHoldRefs) => {
    const hoveredTargetId = usePonderStore(state => state.hoveredTargetId);
    const animationsRef = useRef<Animation[]>([]);
    const timerRef = useRef<number | null>(null);

    useEffect(() => {
        if (!hoveredTargetId || typeof window === 'undefined') {
            return;
        }

        // 提示一出现就把教程层那个 chunk 预热，400ms 按满时通常已经就绪。
        void import('../components/ponder/PonderStage');

        const cancelHold = () => {
            animationsRef.current.forEach(animation => animation.cancel());
            animationsRef.current = [];
            if (timerRef.current !== null) {
                window.clearTimeout(timerRef.current);
                timerRef.current = null;
            }
        };

        const isArmed = () => timerRef.current !== null;

        const armHold = () => {
            const wipe = wipeRef.current;
            const label = labelRef.current;
            const holdLabel = holdLabelRef.current;
            const timing: KeyframeAnimationOptions = {
                duration: HOLD_DURATION_MS,
                easing: 'linear',
                fill: 'forwards',
            };

            // 进度反馈是功能性的，不是装饰 —— 即使用户关了微动效也要看得见还要按多久，
            // 所以这里不读 reduced motion，只用最朴素的线性变换。
            if (wipe) {
                animationsRef.current.push(wipe.animate(
                    [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
                    timing,
                ));
            }
            if (label) {
                animationsRef.current.push(label.animate([{ opacity: 1 }, { opacity: 0 }], timing));
            }
            if (holdLabel) {
                animationsRef.current.push(holdLabel.animate([{ opacity: 0 }, { opacity: 1 }], timing));
            }

            timerRef.current = window.setTimeout(() => {
                timerRef.current = null;
                animationsRef.current = [];
                // 按满的这一刻再确认一次：这 400ms 里指针可能已经移开了。
                if (usePonderStore.getState().hoveredTargetId !== hoveredTargetId) {
                    return;
                }
                usePonderStore.getState().openPonder(hoveredTargetId);
            }, HOLD_DURATION_MS);
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.code !== 'KeyG' || event.repeat || event.isComposing) {
                return;
            }
            if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
                return;
            }

            // 可教学性看「悬停到的元素」，是否在打字看「焦点元素」—— 两者必须分开判断，
            // 否则命令面板那种输入框长期持有焦点的情况永远进不来。
            if (isTextEntryTarget(event.target)) {
                return;
            }
            const insideBlocking = Boolean(hoveredElementRef.current?.closest(BLOCKING_WINDOW_SELECTOR));
            if (!insideBlocking && hasBlockingWindow()) {
                return;
            }

            // 到这里 G 归我们了：吃掉它，别让字符落进底下的输入框。
            event.preventDefault();
            event.stopPropagation();

            if (!isArmed()) {
                armHold();
            }
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            if (event.code === 'KeyG') {
                cancelHold();
            }
        };

        const handleVisibilityChange = () => {
            if (document.hidden) cancelHold();
        };

        window.addEventListener('keydown', handleKeyDown, { capture: true });
        window.addEventListener('keyup', handleKeyUp, { capture: true });
        window.addEventListener('blur', cancelHold);
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            window.removeEventListener('keydown', handleKeyDown, { capture: true });
            window.removeEventListener('keyup', handleKeyUp, { capture: true });
            window.removeEventListener('blur', cancelHold);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            cancelHold();
        };
    }, [hoveredTargetId, hoveredElementRef, wipeRef, labelRef, holdLabelRef]);
};

export default usePonderHoldToEnter;
