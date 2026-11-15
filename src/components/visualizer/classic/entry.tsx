import React from 'react';
import { RotateCw } from 'lucide-react';
import type { ClassicTuning } from '../../../types';
import { QuickControlToggle } from '../../shared/QuickControlChip';
import { defineVisualizer, type VisualizerQuickControlsProps } from '../definition';
import { ClassicSettingsPanel } from '../settingsPanels';
import { BEAT_EFFECT_IDS } from '../../../services/beatFx/beatEffects';

const Visualizer = React.lazy(() => import('./Visualizer'));

// src/components/visualizer/classic/entry.tsx
// Registers the classic visualizer mode.
export default defineVisualizer({
    mode: 'classic',
    // 智能动感：这个样式自己的画面原子，共享同一次音轨分离的四条曲线。
    beatEffects: [
        {
            id: BEAT_EFFECT_IDS.classicPulseGlow,
            nameKey: 'options.beatEffect_classicPulseGlow',
            descKey: 'options.beatEffect_classicPulseGlowDesc',
            source: 'envelopes',
        },
        {
            id: BEAT_EFFECT_IDS.classicVocalShine,
            nameKey: 'options.beatEffect_classicVocalShine',
            descKey: 'options.beatEffect_classicVocalShineDesc',
            source: 'envelopes',
        },
    ],
    order: 30,
    labelKey: 'ui.visualizerClassic',
    labelFallback: 'Luminous',
    previewSeed: 'classic',
    previewStartOffset: 0,
    // 流光：单行居中歌词，逐字点亮
    glyph: (
        <>
            <path d="M3 12h18" opacity="0.35" />
            <path d="M3 12h8" />
        </>
    ),
    command: {
        title: 'Visualizer: Luminous',
        description: 'Switch to classic visualizer',
        keywords: ['visualizer classic', 'classic', '流光'],
    },
    usesWordSegmentation: true,
    render: props => <Visualizer {...props} />,
    renderSettingsPanel: props => <ClassicSettingsPanel {...props} />,
    renderQuickControls: ({ tuning, onTuningChange, t }: VisualizerQuickControlsProps<ClassicTuning>) => (
        <QuickControlToggle
            active={tuning.enableWordRotation}
            label={t('options.classicWordRotation')}
            onToggle={() => onTuningChange({ enableWordRotation: !tuning.enableWordRotation })}
        >
            <RotateCw size={14} />
        </QuickControlToggle>
    ),
});
