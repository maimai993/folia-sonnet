import { useEffect } from 'react';
import { usePonderStore } from '../stores/usePonderStore';
import { openCurrentPagePonder } from '../utils/ponder/pagePonderTarget';

// src/hooks/usePagePonderShortcut.ts

/** Ctrl+G is page-scoped, so it remains safe while an input (including the command palette) is focused. */
export const usePagePonderShortcut = (): void => {
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (
                event.code !== 'KeyG'
                || !event.ctrlKey
                || event.altKey
                || event.metaKey
                || event.shiftKey
                || event.repeat
                || event.isComposing
                || usePonderStore.getState().session
            ) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            openCurrentPagePonder();
        };

        window.addEventListener('keydown', handleKeyDown, { capture: true });
        return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
    }, []);
};

export default usePagePonderShortcut;
