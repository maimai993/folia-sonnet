import type { CommandPaletteContext } from '../../command-palette/types';
import { useVisualizerSettingsStore } from '../../../stores/useVisualizerSettingsStore';

// src/components/app/command-palette-context/buildVisualizerCommandContext.ts
// The `visualizer` namespace. Entirely store-backed: App.tsx used to relay all seven members.

export const buildVisualizerCommandContext = (): CommandPaletteContext['visualizer'] => {
    const visualizer = useVisualizerSettingsStore.getState();
    return {
        visualizerMode: visualizer.visualizerMode,
        visualizerBackgroundMode: visualizer.visualizerBackgroundMode,
        setVisualizerMode: visualizer.handleSetVisualizerMode,
        toggleRandomVisualizerModePerSong: () => visualizer.handleToggleRandomVisualizerModePerSong(
            !useVisualizerSettingsStore.getState().randomVisualizerModePerSong,
        ),
        setVisualizerBackgroundMode: visualizer.handleSetVisualizerBackgroundMode,
        setMonetBackgroundTuning: visualizer.handleSetMonetBackgroundTuning,
        setLatentBackgroundTuning: visualizer.handleSetLatentBackgroundTuning,
    };
};
