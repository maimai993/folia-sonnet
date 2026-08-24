import { buildPickerMatches } from '../commands/pickerOptions';
import type { CommandPaletteSurface, CommandSurfaceArgs } from './types';

// src/components/command-palette/surfaces/pickerSurface.ts
// Icon-grid pickers: the input filters, arrows move, Enter or a click applies. Selection itself
// runs through the normal match pipeline; only arrow navigation is overridden, because the
// default list steps one item per press and a grid needs rows.

/**
 * Fixed rather than responsive: keyboard navigation has to agree with what is on screen, and a
 * breakpoint-dependent column count cannot be known here. PickerSurfaceView lays the grid out
 * from this same constant.
 */
export const PICKER_GRID_COLUMNS = 3;

const ARROW_STEPS: Record<string, number> = {
    ArrowLeft: -1,
    ArrowRight: 1,
    ArrowUp: -PICKER_GRID_COLUMNS,
    ArrowDown: PICKER_GRID_COLUMNS,
};

const navigateGrid = (event: KeyboardEvent, { matches, activeIndex, setActiveIndex }: CommandSurfaceArgs) => {
    const step = ARROW_STEPS[event.key];
    if (step === undefined || matches.length === 0) {
        return false;
    }

    // Clamping rather than wrapping keeps a partial last row from jumping across the grid.
    setActiveIndex(Math.max(0, Math.min(matches.length - 1, activeIndex + step)));
    return true;
};

const createPickerSurface = (kind: 'visualizer' | 'background'): CommandPaletteSurface => ({
    load: () => import('./PickerSurfaceView'),
    useLiveQuery: true,
    buildMatches: ({ context, query }) => buildPickerMatches(kind, context, query),
    onKeyDown: navigateGrid,
    mapProps: ({ matches, activeIndex, setActiveIndex, executeMatch, isDaylight, theme, isExecuting }) => ({
        kind,
        matches,
        activeIndex,
        setActiveIndex,
        executeMatch,
        isDaylight,
        theme,
        isExecuting,
    }),
});

export const visualizerPickerSurface = createPickerSurface('visualizer');
export const backgroundPickerSurface = createPickerSurface('background');
