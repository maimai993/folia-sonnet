import type { VisualizerMode } from '../types';
import { BUILTIN_VISUALIZER_MODES } from '../types/visualizerModes';

// src/utils/randomVisualizerModes.ts
// 参与「每首歌随机一个样式」的那些样式：内置的，以及模组注册进来的。
//
// 这里以前只认内置名单（`BUILTIN_VISUALIZER_MODES`），而随机池是按**注册表**列出来的，
// 于是模组样式（跳一跳、黑胶唱片这些）在池子里看得见、点得中，值也确实发过来了 ——
// 却在这一步被按内置名单重新筛一遍扔掉，紧接着数组变空又退回「全部内置」。
// 用户看到的就是「那两个模组样式点了没反应，也不是默认选中的」。
//
// 现在放行 `mod:` 前缀的样式：它们的 id 由加载器保证是 `mod:<modId>:<id>`，
// 与内置永不撞名。已被卸载的模组留下的陈旧 id 由调用方按当前注册表再收一次
// （见 useRandomPool），这里不做注册表查询，保持这个模块只有纯逻辑、可单独测试。

export type RandomVisualizerMode = VisualizerMode;

/** 模组注册的样式 id 前缀（见 components/visualizer/registry.tsx 的 appendVisualizerEntry）。 */
const MOD_MODE_PREFIX = 'mod:';

const BUILTIN_SET: ReadonlySet<string> = new Set(BUILTIN_VISUALIZER_MODES);

/** 内置样式，或模组注册的样式。 */
export const isSelectableRandomMode = (mode: unknown): mode is VisualizerMode => (
    typeof mode === 'string'
    && (BUILTIN_SET.has(mode) || (mode.startsWith(MOD_MODE_PREFIX) && mode.length > MOD_MODE_PREFIX.length))
);

/**
 * 收拢一份可用的随机池。
 *
 * 顺序：内置的按内置名单的顺序在前，模组的按收到它们的顺序在后 —— 和样式列表里的
 * 排列一致，用户不会看到池子的顺序和自己选的时候不一样。
 *
 * 一个都没有时退回全部内置：这是原来的行为，池子不能空（随机要有东西可抽）。
 * 注意只有**真的一个都没剩下**才退回，否则用户把池子清到只剩一个模组样式，
 * 那一个会被「全部内置」顶掉。
 */
export const normalizeRandomVisualizerModes = (value: unknown): RandomVisualizerMode[] => {
    const selected = new Set(Array.isArray(value) ? value : []);
    const builtin = BUILTIN_VISUALIZER_MODES.filter(mode => selected.has(mode));
    // 模组样式按它们传到这里的顺序保留（Set 会去重，Array 会保序）。
    const fromMods = [...selected].filter(
        (mode): mode is VisualizerMode => isSelectableRandomMode(mode) && !BUILTIN_SET.has(mode),
    );
    const modes = [...builtin, ...fromMods];
    return modes.length > 0 ? modes : [...BUILTIN_VISUALIZER_MODES];
};

/** Picks within the saved selection, excluding the current style whenever another choice exists. */
export const pickRandomVisualizerMode = (
    modes: readonly VisualizerMode[],
    current: VisualizerMode,
    random: () => number = Math.random,
): RandomVisualizerMode => {
    const selected = normalizeRandomVisualizerModes(modes);
    const alternatives = selected.filter(mode => mode !== current);
    const candidates = alternatives.length > 0 ? alternatives : selected;
    return candidates[Math.floor(random() * candidates.length)];
};
