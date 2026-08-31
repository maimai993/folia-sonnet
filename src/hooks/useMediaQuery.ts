import { useCallback, useSyncExternalStore } from 'react';

// src/hooks/useMediaQuery.ts
// Shared media query subscription so layout branches can read a breakpoint without hand-rolling matchMedia.

/**
 * Tracks whether `query` currently matches, staying in sync as the viewport changes.
 *
 * Reads the initial value straight from `matchMedia` through `useSyncExternalStore` rather than
 * settling it in an effect: a component that branches its markup on the result would otherwise
 * render the wrong branch on the first frame and visibly snap to the right one.
 */
export const useMediaQuery = (query: string): boolean => {
    const subscribe = useCallback((onStoreChange: () => void) => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            return () => {};
        }

        const mediaQuery = window.matchMedia(query);
        mediaQuery.addEventListener('change', onStoreChange);
        return () => mediaQuery.removeEventListener('change', onStoreChange);
    }, [query]);

    const getSnapshot = useCallback(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            return false;
        }

        return window.matchMedia(query).matches;
    }, [query]);

    return useSyncExternalStore(subscribe, getSnapshot, () => false);
};

export default useMediaQuery;
