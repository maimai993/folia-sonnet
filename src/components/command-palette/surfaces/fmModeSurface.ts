import { PERSONAL_FM_SCENE_CATEGORIES, getPersonalFmSceneEntry } from '../../../services/onlineMusic/fmModes';
import { buildPersonalFmMatches, readPersonalFmOption } from '../commands/fmModeOptions';
import type { CommandPaletteMatch } from '../types';
import type { CommandPaletteSurface, CommandSurfaceArgs } from './types';

// src/components/command-palette/surfaces/fmModeSurface.ts
// Personal FM mode picker: the input filters, arrows move, Enter or a click applies. Pills wrap
// freely, so visual rows cannot be predicted here the way the fixed-column icon picker does;
// left/right walks the flat list instead, and up/down hops between sections.

export type PersonalFmSection = {
    key: string;
    labelKey: string;
    labelFallback: string;
    /** Indices into the match list, so navigation and rendering share one source of truth. */
    indices: number[];
};

const SECTION_ORDER = [
    { key: 'mode', labelKey: 'personalFmMode.category.mode', labelFallback: 'Mode' },
    ...PERSONAL_FM_SCENE_CATEGORIES.map(category => ({
        key: category.id as string,
        labelKey: category.labelKey,
        labelFallback: category.labelFallback,
    })),
];

const sectionKeyOf = (match: CommandPaletteMatch): string | null => {
    const option = readPersonalFmOption(match.command.id);
    if (!option) return null;
    if (option.kind === 'mode') return 'mode';
    return getPersonalFmSceneEntry(option.id)?.category ?? null;
};

/** Only sections with surviving matches are kept, so a filtered list has no empty headers. */
export const buildPersonalFmSections = (matches: CommandPaletteMatch[]): PersonalFmSection[] => {
    const byKey = new Map<string, number[]>();
    matches.forEach((match, index) => {
        const key = sectionKeyOf(match);
        if (!key) return;
        const existing = byKey.get(key);
        if (existing) {
            existing.push(index);
        } else {
            byKey.set(key, [index]);
        }
    });
    return SECTION_ORDER
        .map(section => ({ ...section, indices: byKey.get(section.key) ?? [] }))
        .filter(section => section.indices.length > 0);
};

const HORIZONTAL_STEPS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };
const VERTICAL_STEPS: Record<string, number> = { ArrowUp: -1, ArrowDown: 1 };

const navigate = (event: KeyboardEvent, { matches, activeIndex, setActiveIndex }: CommandSurfaceArgs) => {
    if (matches.length === 0) {
        return false;
    }

    const horizontalStep = HORIZONTAL_STEPS[event.key];
    if (horizontalStep !== undefined) {
        // Clamping rather than wrapping: jumping from the last language back to the first mode
        // reads as a glitch when the two are far apart on screen.
        setActiveIndex(Math.max(0, Math.min(matches.length - 1, activeIndex + horizontalStep)));
        return true;
    }

    const verticalStep = VERTICAL_STEPS[event.key];
    if (verticalStep === undefined) {
        return false;
    }

    const sections = buildPersonalFmSections(matches);
    const currentSection = sections.findIndex(section => section.indices.includes(activeIndex));
    if (currentSection < 0) {
        setActiveIndex(0);
        return true;
    }

    const nextSection = sections[currentSection + verticalStep];
    if (!nextSection) {
        return true;
    }

    // Keeping the offset within the section makes vertical movement feel like a column walk even
    // though the pills below are a different width than the ones above.
    const offset = sections[currentSection].indices.indexOf(activeIndex);
    setActiveIndex(nextSection.indices[Math.min(offset, nextSection.indices.length - 1)]);
    return true;
};

export const fmModeSurface: CommandPaletteSurface = {
    load: () => import('./FmModeSurfaceView'),
    useLiveQuery: true,
    buildMatches: ({ context, query }) => buildPersonalFmMatches(context, query),
    onKeyDown: navigate,
    mapProps: ({ context, matches, activeIndex, setActiveIndex, executeMatch, isDaylight, theme, isExecuting }) => ({
        matches,
        activeIndex,
        setActiveIndex,
        executeMatch,
        isDaylight,
        isExecuting,
        theme,
        selection: context.playback.personalFmSelection,
    }),
};
