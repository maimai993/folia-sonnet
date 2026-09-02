import type { CommandPaletteSurface } from './types';

// src/components/command-palette/surfaces/filterViewSurface.ts
// The palette standing in as the on-screen filter box for whichever surface registered one.
//
// There is no body to render: the input row *is* the filter box, drawn inline where the surface
// says it belongs. Everything below is about matching what the grids' own box used to do, so that
// moving the input into the palette changes nothing the listener can feel.

export const filterViewSurface: CommandPaletteSurface = {
    presentation: 'inline',
    // Filtering is character by character; waiting for the match debounce would make typing lag.
    useLiveQuery: true,
    onQueryChange: ({ context, query }) => {
        context.scope.filter?.setQuery(query);
        return false;
    },
    // Enter was swallowed by the grids' own box too — the box stays up, and with it the only sign
    // that the view is filtered at all. Closing on Enter would leave a filtered grid with nothing
    // on screen saying so.
    onSubmit: () => true,
    // Escape clears the filter and puts the box away, in that order, exactly as the grids did.
    onEscape: ({ context }) => {
        context.scope.filter?.setQuery('');
        return false;
    },
};
