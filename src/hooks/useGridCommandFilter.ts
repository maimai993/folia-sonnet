import { useEffect, useRef, type RefObject } from 'react';
import { registerCommandFilter, useAppViewStore } from '../stores/useAppViewStore';

// src/hooks/useGridCommandFilter.ts
// Hands one grid's filter box over to the command palette.
//
// The three grids each used to carry a window keydown listener that turned any printable character
// into "open my search panel", plus their own `<input>`. That is three copies of one idea, and it
// is also why the palette could not open on home: a bare key meant two different things at once.
// Now the grid says "I read typing, here is where the text goes and where the box belongs", and the
// palette does the rest.

type UseGridCommandFilterParams = {
    /** Only the grid the listener is actually looking at should claim the keyboard. */
    isInteractive: boolean;
    query: string;
    setQuery: (query: string) => void;
    /** The element the filter box used to be positioned against; the palette portals into it. */
    anchorRef: RefObject<HTMLElement | null>;
};

export const useGridCommandFilter = ({ isInteractive, query, setQuery, anchorRef }: UseGridCommandFilterParams) => {
    // Assigned during render, not in an effect: an effect leaves a window in which the palette
    // would write through the previous render's setter.
    const latestRef = useRef({ query, setQuery });
    latestRef.current = { query, setQuery };
    const isFiltering = useAppViewStore(state => state.isCommandFilterOpen);

    useEffect(() => {
        if (!isInteractive) {
            return;
        }

        return registerCommandFilter({
            getQuery: () => latestRef.current.query,
            setQuery: (next) => latestRef.current.setQuery(next),
            getAnchor: () => anchorRef.current,
        });
    }, [anchorRef, isInteractive]);

    /** True while the palette is filtering this grid, i.e. the old `showSearchPanel`. */
    return isFiltering;
};
