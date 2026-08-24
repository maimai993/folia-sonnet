import { VISUALIZER_REGISTRY } from '../../visualizer/registry';
import { VISUALIZER_BACKGROUND_REGISTRY } from '../../visualizer/backgrounds/registry';
import type { VisualizerBackgroundMode, VisualizerMode } from '../../../types';
import type { CommandPaletteCommand, CommandPaletteContext, CommandPaletteMatch } from '../types';

// src/components/command-palette/commands/pickerOptions.ts
// Turns the glob-discovered visualizer and background registries into palette matches, so the
// pickers stay in sync with whatever modes exist without a hand-maintained list. Both registries
// are already in the app's eager graph via VisualizerRenderer, so importing them costs nothing.

const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');

const PICKER_ID_PREFIX = { visualizer: 'visualizer-pick-', background: 'background-pick-' } as const;

// The grid renders each tile's mode glyph, and matches only carry a command. Reading the mode
// back out of the id keeps that private to this module and its view.
export const readPickerMode = (kind: 'visualizer' | 'background', commandId: string) => (
    commandId.startsWith(PICKER_ID_PREFIX[kind]) ? commandId.slice(PICKER_ID_PREFIX[kind].length) : ''
);

type PickerOption = {
    id: string;
    mode: string;
    label: string;
    apply: (mode: string, context: CommandPaletteContext) => void;
};

const buildOptions = (kind: 'visualizer' | 'background', context: CommandPaletteContext): PickerOption[] => (
    kind === 'visualizer'
        ? VISUALIZER_REGISTRY.map(entry => ({
            id: `${PICKER_ID_PREFIX.visualizer}${entry.mode}`,
            mode: entry.mode,
            label: context.shared.t(entry.labelKey, entry.labelFallback),
            apply: (mode: string, ctx: CommandPaletteContext) => ctx.visualizer.setVisualizerMode(mode as VisualizerMode),
        }))
        : VISUALIZER_BACKGROUND_REGISTRY.map(entry => ({
            id: `${PICKER_ID_PREFIX.background}${entry.mode}`,
            mode: String(entry.mode),
            label: context.shared.t(entry.labelKey, entry.labelFallback),
            apply: (mode: string, ctx: CommandPaletteContext) => ctx.visualizer.setVisualizerBackgroundMode(mode as VisualizerBackgroundMode),
        }))
);

const toCommand = (option: PickerOption, kind: 'visualizer' | 'background'): CommandPaletteCommand => ({
    id: option.id,
    group: 'visualizer',
    title: option.label,
    // Labels come from the visualizer registry, not from commandPalette.commands.<id>.
    textSource: 'runtime',
    description: option.label,
    keywords: [option.mode],
    execute: (_input, context) => {
        option.apply(option.mode, context);
        return true;
    },
});

// Matches are ranked by how early the query hits the label or the mode id; an empty query keeps
// registry order so the grid is stable while the user is just looking.
export const buildPickerMatches = (
    kind: 'visualizer' | 'background',
    context: CommandPaletteContext,
    query: string,
): CommandPaletteMatch[] => {
    const normalizedQuery = normalize(query);
    return buildOptions(kind, context)
        .map((option, index) => {
            const haystacks = [normalize(option.label), normalize(option.mode)];
            if (!normalizedQuery) {
                return { option, score: 100 - index };
            }
            const best = haystacks
                .map(haystack => haystack.indexOf(normalizedQuery))
                .filter(position => position >= 0)
                .sort((left, right) => left - right)[0];
            return best === undefined ? null : { option, score: 100 - best };
        })
        .filter((entry): entry is { option: PickerOption; score: number } => entry !== null)
        .map(entry => ({ command: toCommand(entry.option, kind), score: entry.score, input: '' }));
};
