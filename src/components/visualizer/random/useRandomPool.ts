import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import type { VisualizerMode } from '../../../types';
import { useVisualizerSettingsStore } from '../../../stores/useVisualizerSettingsStore';
import { setStatusMessage } from '../../../stores/useStatusMessageStore';
import { pickRandomVisualizerMode } from '../../../utils/randomVisualizerModes';
import { getVisualizerModeLabel, VISUALIZER_REGISTRY } from '../registry';

// src/components/visualizer/random/useRandomPool.ts
// The random pool as its two pickers show it (the lyric style window's page and the player panel's
// layer): the built-in styles in the shelf's order, which of them are on, and what a press does.
// Also the panel's other chip: drawing another style from the pool for the song that is playing.

export const useRandomPool = () => {
    const { t } = useTranslation();
    const { modes, mode, setModes, setMode } = useVisualizerSettingsStore(useShallow(state => ({
        modes: state.randomVisualizerModes,
        mode: state.visualizerMode,
        setModes: state.handleSetRandomVisualizerModes,
        setMode: state.handleSetVisualizerMode,
    })));
    /*
     * 池子里的候选：注册表里的**全部**样式，不只是内置的。
     *
     * 以前这里有一句 `filter(entry => BUILTIN_MODES.has(entry.mode))`，把模组注册的
     * 样式整个滤掉了 —— 模组的动画在样式列表里看得到、能选中，却永远不会被随机抽到，
     * 池子里的「已选 N/M」也把 M 算成内置数量。用户看到的就是「随机里面没有 mod
     * 注册的动画」。
     *
     * 模组样式经 appendVisualizerEntry 进的是同一个注册表（见 registry.tsx），
     * 所以直接用注册表本身就是对的；`mode` 前缀由加载器保证是 `mod:<modId>:<id>`，
     * 不会和内置撞名。
     */
    const options = useMemo(() => (
        VISUALIZER_REGISTRY.map(entry => ({ value: entry.mode, label: getVisualizerModeLabel(entry.mode, t) }))
    ), [t]);
    /*
     * 计数按**当前注册表里还在的**样式算：存下来的选择可能留着已经卸载的模组样式 id，
     * 直接比 `modes.length` 会让「已选 N/M」和「全选」的可用状态对不上。
     */
    const total = VISUALIZER_REGISTRY.length;
    const selectedInRegistry = useMemo(
        () => VISUALIZER_REGISTRY.filter(entry => (modes as readonly string[]).includes(entry.mode)).length,
        [modes],
    );
    // 一个都没选时选主会退回全部（见 normalizeRandomVisualizerModes），所以那样也算全选。
    const allOn = selectedInRegistry === total || modes.length === 0;

    return {
        options,
        modes: modes as readonly VisualizerMode[],
        setModes: (next: readonly VisualizerMode[]) => setModes(next),
        allOn,
        /**
         * Every style, mod ones included. The 全选 button turns disabled under the press, and focus on
         * a disabled button drops to the page, which closes the panel's layer (Popover): the focus
         * goes to the grid's tab stop first, when the grid is given.
         */
        selectAll: (grid?: HTMLElement | null) => {
            grid?.querySelector<HTMLElement>('[data-value][tabindex="0"]')?.focus();
            // 按注册表的顺序把所有样式都选上，模组的也在里面。
            setModes(VISUALIZER_REGISTRY.map(entry => entry.mode));
        },
        /** 「已选 5/14」 */
        countLabel: t('options.randomPoolCount', { selected: modes.length === 0 ? total : selectedInRegistry, total }),
        /** The style this song drew. */
        currentLabel: getVisualizerModeLabel(mode, t),
        /** Said when the last style that is on is pressed: the pool keeps one at least. */
        refuse: () => setStatusMessage({ type: 'info', text: t('options.randomVisualizerAtLeastOne') }),
        /** The pool holds a style other than this song's. */
        canReroll: modes.some(entry => entry !== mode),
        /** Another style from the pool for this song, never the one it has; random stays on. */
        reroll: () => {
            const next = pickRandomVisualizerMode(modes, mode);
            if (next !== mode) setMode(next, { notify: false, preserveRandom: true });
        },
    };
};
