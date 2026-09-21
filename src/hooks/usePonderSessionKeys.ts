import { useEffect, type RefObject } from 'react';
import { usePonderStore } from '../stores/usePonderStore';
import type { PonderTimelineControls } from '../components/ponder/usePonderTimeline';

// src/hooks/usePonderSessionKeys.ts
// 教程开着时的键盘：Esc 退出、←/→ 跳关键帧、[ ] 换场景、空格暂停。
//
// 用 capture 阶段并对处理掉的键 stopImmediatePropagation，是为了不依赖 effect 注册顺序。
// 底下那些全局热键本来也会因为教程层挂了 data-folia-keyboard-window 而让路，这里是第二道保险。
// 没处理的键一律放过 —— 没必要连开发者工具的快捷键一起吃掉。

type UsePonderSessionKeysParams = {
    isActive: boolean;
    sceneCount: number;
    controlsRef: RefObject<PonderTimelineControls | null>;
};

export const usePonderSessionKeys = ({ isActive, sceneCount, controlsRef }: UsePonderSessionKeysParams) => {
    useEffect(() => {
        if (!isActive || typeof window === 'undefined') {
            return;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.ctrlKey || event.altKey || event.metaKey) {
                return;
            }

            const controls = controlsRef.current;
            const store = usePonderStore.getState();

            switch (event.code) {
                case 'Escape':
                    store.closePonder();
                    break;
                case 'ArrowLeft':
                    controls?.seekPrevKeyframe();
                    break;
                case 'ArrowRight':
                    controls?.seekNextKeyframe();
                    break;
                case 'BracketLeft':
                    store.stepScene(-1, sceneCount);
                    break;
                case 'BracketRight':
                    store.stepScene(1, sceneCount);
                    break;
                case 'Space':
                    if (controls) {
                        store.setPaused(controls.toggle());
                    }
                    break;
                default:
                    return;
            }

            event.preventDefault();
            event.stopImmediatePropagation();
        };

        window.addEventListener('keydown', handleKeyDown, { capture: true });
        return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
    }, [isActive, sceneCount, controlsRef]);
};

export default usePonderSessionKeys;
