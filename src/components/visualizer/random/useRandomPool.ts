import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import type { VisualizerMode } from '../../../types';
import { useVisualizerSettingsStore } from '../../../stores/useVisualizerSettingsStore';
import { setStatusMessage } from '../../../stores/useStatusMessageStore';
import { normalizeRandomVisualizerModesWith, pickRandomVisualizerMode } from '../../../utils/randomVisualizerModes';
import { getVisualizerModeLabel, VISUALIZER_REGISTRY } from '../registry';

// src/components/visualizer/random/useRandomPool.ts
// The random pool as its two pickers show it (the lyric style window's page and the player panel's
// layer): the registered styles in the shelf's order — 内建的照清单排，mod 投稿的跟在后面 ——,
// which of them are on, and what a press does. Also the panel's other chip: drawing another style
// from the pool for the song that is playing.

const isRegisteredMode = (mode: string): boolean => VISUALIZER_REGISTRY.some(entry => entry.mode === mode);

export const useRandomPool = () => {
    const { t } = useTranslation();
    const { modes, mode, setModes, setMode } = useVisualizerSettingsStore(useShallow(state => ({
        modes: state.randomVisualizerModes,
        mode: state.visualizerMode,
        setModes: state.handleSetRandomVisualizerModes,
        setMode: state.handleSetVisualizerMode,
    })));
    // The pool's choices: every registered style, built-ins first (the shelf's order), then the
    // mod-contributed ones by their own order. A saved selection that names a mod is kept as-is.
    const options = useMemo(() => (
        VISUALIZER_REGISTRY.map(entry => ({ value: entry.mode, label: getVisualizerModeLabel(entry.mode, t) }))
    ), [t]);
    const knownModes = useMemo(() => normalizeRandomVisualizerModesWith(modes, isRegisteredMode), [modes]);

    return {
        options,
        modes: knownModes,
        setModes: (next: readonly VisualizerMode[]) => setModes(next),
        /** The saved selection names every registered style. */
        allOn: knownModes.length === VISUALIZER_REGISTRY.length,
        /**
         * Every registered style. The 全选 button turns disabled under the press, and focus on a disabled
         * button drops to the page, which closes the panel's layer (Popover): the focus goes to the
         * grid's tab stop first, when the grid is given.
         */
        selectAll: (grid?: HTMLElement | null) => {
            grid?.querySelector<HTMLElement>('[data-value][tabindex="0"]')?.focus();
            setModes(VISUALIZER_REGISTRY.map(entry => entry.mode));
        },
        /** 「已选 5/14」 */
        countLabel: t('options.randomPoolCount', { selected: knownModes.length, total: VISUALIZER_REGISTRY.length }),
        /** The style this song drew. */
        currentLabel: getVisualizerModeLabel(mode, t),
        /** Said when the last style that is on is pressed: the pool keeps one at least. */
        refuse: () => setStatusMessage({ type: 'info', text: t('options.randomVisualizerAtLeastOne') }),
        /** The pool holds a style other than this song's. */
        canReroll: knownModes.some(entry => entry !== mode),
        /** Another style from the pool for this song, never the one it has; random stays on. */
        reroll: () => {
            const next = pickRandomVisualizerMode(knownModes, mode);
            if (next !== mode) setMode(next, { notify: false, preserveRandom: true });
        },
    };
};
