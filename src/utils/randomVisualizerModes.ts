import type { VisualizerMode } from '../types';
import { BUILTIN_VISUALIZER_MODES } from '../types/visualizerModes';

// The built-in styles eligible for per-song random selection; no renderer or tuning state lives here.
export type RandomVisualizerMode = typeof BUILTIN_VISUALIZER_MODES[number];

/**
 * The known modes a pool selection may name: the built-ins plus whatever mod visualizers are
 * registered right now (`mod:<modId>:<id>`). Leaf-layer safe: importing the live registry here
 * would drag the whole visualizer UI into stores and sync schema, so the caller hands the set in.
 */
export const normalizeRandomVisualizerModesWith = (
    value: unknown,
    isKnown: (mode: string) => boolean,
): VisualizerMode[] => {
    const selected = (Array.isArray(value) ? value : []).filter(
        (mode): mode is VisualizerMode => typeof mode === 'string' && isKnown(mode),
    );
    return selected.length > 0 ? selected : [...BUILTIN_VISUALIZER_MODES];
};

/**
 * Storage-safe normalize (store init, sync schema, OBS short codes): no registry access, so only
 * the built-ins count. Mod ids a saved selection carries are re-admitted by the pickers, which
 * run the registry-aware check above.
 */
export const normalizeRandomVisualizerModes = (value: unknown): RandomVisualizerMode[] => (
    normalizeRandomVisualizerModesWith(value, mode => (BUILTIN_VISUALIZER_MODES as readonly string[]).includes(mode)) as RandomVisualizerMode[]
);

/** Picks within the saved selection, excluding the current style whenever another choice exists. */
export const pickRandomVisualizerMode = (
    modes: readonly VisualizerMode[],
    current: VisualizerMode,
    random: () => number = Math.random,
): VisualizerMode => {
    const selected = modes.length > 0 ? [...modes] : [...BUILTIN_VISUALIZER_MODES];
    const alternatives = selected.filter(mode => mode !== current);
    const candidates = alternatives.length > 0 ? alternatives : selected;
    return candidates[Math.floor(random() * candidates.length)];
};
