import { Filter } from 'lucide-react';
import type { CommandPaletteCommand } from '../types';
import { filterViewSurface } from '../surfaces/filterViewSurface';

// src/components/command-palette/commands/filterViewCommand.ts
// Filters whatever surface currently reads typed characters — the home grids, today.

export const FILTER_VIEW_COMMAND_ID = 'filter-view';

export const filterViewCommand: CommandPaletteCommand = {
    id: FILTER_VIEW_COMMAND_ID,
    group: 'search',
    title: 'Filter this view',
    description: 'Narrow the cards on screen by name',
    icon: Filter,
    keywords: ['filter', 'filter view', 'narrow', '筛选', '过滤', '筛选视图'],
    // Ctrl/Cmd+F was already how GridMap opened its box; it keeps working, now registry-wide.
    openHotkey: { key: 'f', ctrl: true },
    surface: filterViewSurface,
    // Nothing registers a filter on the player, so the command is only offered where it can act.
    scope: 'filtering-surface',
    requiresInput: true,
    // Picking the command out of the list resumes the filter already in place rather than
    // silently discarding it.
    getInitialInput: context => context.scope.filter?.getQuery() ?? '',
    placeholder: context => context.shared.t('home.gridSearchPlaceholder', 'Filter this view'),
    // The surface writes on every keystroke, so there is nothing left for Enter to commit.
    execute: () => true,
};
