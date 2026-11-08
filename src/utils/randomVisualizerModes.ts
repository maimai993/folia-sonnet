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
    /*
     * 去重，并按 BUILTIN 的声明顺序输出（mod 的排在内建之后）。
     *
     * 顺序不跟着输入走：存下来的是池子，不是播放顺序，按声明顺序落盘才能让
     * 「同一组选择」在存储里是同一个数组，比较起来才有意义。同一个 id 出现两次
     * 只算一次 —— 否则随机池里它的权重会翻倍。
     */
    const chosen = new Set(
        (Array.isArray(value) ? value : []).filter(
            (mode): mode is VisualizerMode => typeof mode === 'string' && isKnown(mode),
        ),
    );
    if (chosen.size === 0) return [...BUILTIN_VISUALIZER_MODES];
    const ordered = BUILTIN_VISUALIZER_MODES.filter(mode => chosen.has(mode));
    // mod 样式不在内建表里，按它们第一次出现的顺序补在后面。
    const extras = [...chosen].filter(mode => !(BUILTIN_VISUALIZER_MODES as readonly string[]).includes(mode));
    return [...ordered, ...extras];
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
