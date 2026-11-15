import React from 'react';
import { DEFAULT_CADENZA_TUNING } from '../../../types';
import { defineVisualizer, type VisualizerSharedProps } from '../definition';
import CadenzaSettingsPanel from './CadenzaSettingsPanel';
import { BEAT_EFFECT_IDS } from '../../../services/beatFx/beatEffects';

const VisualizerCadenza = React.lazy(() => import('./VisualizerCadenza'));

// src/components/visualizer/cadenza/entry.tsx
// Registers Cadenza and keeps its font-scale adaptation local to the mode.
const renderCadenza = ({
    cadenzaTuning = DEFAULT_CADENZA_TUNING,
    lyricsFontScale = 1,
    ...props
}: VisualizerSharedProps) => (
    <VisualizerCadenza
        {...props}
        lyricsFontScale={lyricsFontScale}
        cadenzaTuning={{
            ...cadenzaTuning,
            fontScale: cadenzaTuning.fontScale * lyricsFontScale,
        }}
    />
);

export default defineVisualizer({
    mode: 'cadenza',
    // 智能动感：这个样式自己的画面原子，共享同一次音轨分离的四条曲线。
    beatEffects: [
        {
            id: BEAT_EFFECT_IDS.cadenzaHaloBreath,
            nameKey: 'options.beatEffect_cadenzaHaloBreath',
            descKey: 'options.beatEffect_cadenzaHaloBreathDesc',
            source: 'envelopes',
        },
        {
            id: BEAT_EFFECT_IDS.cadenzaScatterDrift,
            nameKey: 'options.beatEffect_cadenzaScatterDrift',
            descKey: 'options.beatEffect_cadenzaScatterDriftDesc',
            source: 'envelopes',
        },
    ],
    order: 40,
    labelKey: 'ui.visualizerCadenze',
    labelFallback: 'Mindscape',
    previewSeed: 'cadenza',
    previewStartOffset: 0,
    // 心象：字符散落成云，焦点字被光圈套住
    glyph: (
        <>
            <circle cx="9.5" cy="12.5" r="3.5" />
            <path d="M4 6.5h3.5" opacity="0.45" />
            <path d="M16 8h4" opacity="0.45" />
            <path d="M15 17h4.5" opacity="0.45" />
        </>
    ),
    command: {
        title: 'Visualizer: Mindscape',
        description: 'Switch to cadenza visualizer',
        keywords: ['visualizer cadenza', 'cadenza', 'mindscape', '心象'],
    },
    render: renderCadenza,
    renderSettingsPanel: props => <CadenzaSettingsPanel {...props} />,
});
