import type React from 'react';
import type { Theme } from '../../../types';
import type { CommandPaletteCommand, CommandPaletteContext, CommandPaletteMatch } from '../types';

// src/components/command-palette/surfaces/types.ts
// Declarative contract for commands that take over the palette body instead of showing the
// default match list. Everything the old id-based branches in CommandPalette.tsx and
// useCommandPalette.ts did is expressed here, so a new rich command is one module.

/** Everything a surface needs to reason about input and execution. */
export type CommandSurfaceArgs = {
    context: CommandPaletteContext;
    query: string;
    /** Writes query and matchQuery together, skipping the debounce. */
    setQuery: (next: string) => void;
    matches: CommandPaletteMatch[];
    activeIndex: number;
    setActiveIndex: (index: number) => void;
    isExecuting: boolean;
    executeMatch: (index: number) => Promise<boolean>;
    /** Runs one command through the normal pipeline, or enters it when it takes input. */
    executeCommand: (command: CommandPaletteCommand) => Promise<boolean>;
    close: () => void;
};

/** Adds the palette's presentation state, which only the rendering path can supply. */
export type CommandSurfaceRenderArgs = CommandSurfaceArgs & {
    isDaylight: boolean;
    theme: Theme;
};

/** Args available before matches exist, used by surfaces that produce their own list. */
export type CommandSurfaceMatchArgs = {
    context: CommandPaletteContext;
    query: string;
};

export type CommandPaletteSurface = {
    /**
     * Lazily imported so the registry stays a pure-TS module: pulling react-window,
     * react-i18next or the eager visualizer glob into the module graph would break the
     * node-environment registry tests.
     */
    load: () => Promise<{ default: React.ComponentType<any> }>;
    mapProps: (args: CommandSurfaceRenderArgs) => Record<string, unknown>;
    /** Input element overrides, e.g. the volume command's numeric input. */
    inputProps?: (args: CommandSurfaceRenderArgs) => React.InputHTMLAttributes<HTMLInputElement>;
    /** Replaces the default match list source, e.g. the queue command's songs. */
    buildMatches?: (args: CommandSurfaceMatchArgs) => CommandPaletteMatch[];
    /** Enter handling; return null to fall through to the default executeMatch. */
    onSubmit?: (args: CommandSurfaceArgs) => Promise<boolean> | boolean | null;
    /** Runs whenever the query changes; return true when it already executed and closed. */
    onQueryChange?: (args: CommandSurfaceArgs) => Promise<boolean> | boolean | null;
    /** Staged escape: return true to keep the palette open. */
    onEscape?: (args: CommandSurfaceArgs) => boolean;
    /** Extra key bindings; return true when the event is consumed. */
    onKeyDown?: (event: KeyboardEvent, args: CommandSurfaceArgs) => boolean;
    /** Read the live query instead of the 120ms debounced matchQuery. */
    useLiveQuery?: boolean;
};
