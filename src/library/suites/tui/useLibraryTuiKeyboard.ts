import { useEffect, useRef } from 'react';
import { hasBlockingWindow } from '../../../utils/keyboardTargets';

// src/library/suites/tui/useLibraryTuiKeyboard.ts
// TUI 的按键。只用不可打印键：只要注册了命令筛选，单字符键都归命令面板（打字即筛选），
// 空格又是全局的播放 / 暂停。守卫与网格一致：输入框和按钮里的按键不算，上层窗口打开时不抢，
// Enter / Escape 不响应长按重复。

type LibraryTuiKeyboardHandlers = {
    isActive: boolean;
    /** 命令面板的筛选框正开着：Enter 归它。 */
    isFiltering: boolean;
    rowCount: number;
    pageSize: number;
    moveFocus: (resolve: (current: number) => number) => void;
    onPlayFocused: () => void;
    onEnqueueFocused: () => void;
    onPlayScope: () => void;
    onEnqueueScope: () => void;
    onEscape: () => void;
};

const isEditableTarget = (target: EventTarget | null) => (
    target instanceof HTMLElement
    && (target.isContentEditable || Boolean(target.closest('input, textarea, select')))
);

const isControlTarget = (target: EventTarget | null) => (
    target instanceof HTMLElement && Boolean(target.closest('button, a[href]'))
);

export const useLibraryTuiKeyboard = (handlers: LibraryTuiKeyboardHandlers) => {
    // 监听只装一次，回调每次渲染换成最新的。
    const latest = useRef(handlers);
    latest.current = handlers;

    useEffect(() => {
        if (!handlers.isActive) return;

        const handleKeyDown = (event: KeyboardEvent) => {
            const current = latest.current;
            if (isEditableTarget(event.target) || hasBlockingWindow()) return;

            if (event.key === 'Escape') {
                if (event.repeat) return;
                event.preventDefault();
                current.onEscape();
                return;
            }
            if (isControlTarget(event.target)) return;

            const last = Math.max(current.rowCount - 1, 0);
            const clamp = (index: number) => Math.max(0, Math.min(index, last));
            switch (event.key) {
                case 'ArrowDown':
                    current.moveFocus(index => clamp(index + 1));
                    break;
                case 'ArrowUp':
                    current.moveFocus(index => clamp(index - 1));
                    break;
                case 'PageDown':
                    current.moveFocus(index => clamp(index + current.pageSize));
                    break;
                case 'PageUp':
                    current.moveFocus(index => clamp(index - current.pageSize));
                    break;
                case 'Home':
                    current.moveFocus(() => 0);
                    break;
                case 'End':
                    current.moveFocus(() => last);
                    break;
                case 'Enter':
                    if (event.repeat || current.isFiltering) return;
                    if (event.ctrlKey || event.metaKey) {
                        if (event.shiftKey) current.onEnqueueScope();
                        else current.onPlayScope();
                    } else if (event.shiftKey) {
                        current.onEnqueueFocused();
                    } else {
                        current.onPlayFocused();
                    }
                    break;
                default:
                    return;
            }
            event.preventDefault();
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handlers.isActive]);
};
