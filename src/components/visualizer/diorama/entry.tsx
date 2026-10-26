import React from 'react';
import { Ghost } from 'lucide-react';
import type { DioramaTuning } from '../../../types';
import { QuickControlToggle } from '../../shared/QuickControlChip';
import { defineVisualizer, type VisualizerQuickControlsProps } from '../definition';
import { DioramaSettingsPanel } from '../settingsPanels';

const VisualizerDiorama = React.lazy(() => import('./VisualizerDiorama'));

// src/components/visualizer/diorama/entry.tsx
// Registers Diorama: a procedural 3D lyric flythrough with lyric-synced cinematic camera work, plus
// its tuning panel (camera speed / motion amount / geometry visibility and response / particles).
export default defineVisualizer({
    mode: 'diorama',
    order: 120,
    labelKey: 'ui.visualizerDiorama',
    labelFallback: '镜台',
    previewSeed: 'diorama',
    previewStartOffset: 0,
    // 镜台：不同景深上的方块
    glyph: (
        <>
            <rect x="3.5" y="12" width="5" height="5" rx="1" opacity="0.45" />
            <rect x="9.5" y="6" width="6.5" height="6.5" rx="1" />
            <rect x="17" y="13.5" width="4" height="4" rx="1" opacity="0.45" />
        </>
    ),
    command: {
        title: 'Visualizer: Diorama',
        description: 'Switch to Diorama visualizer',
        keywords: ['diorama', '镜台', '切换到可视化：镜台', '切换到可视化镜台'],
    },
    render: props => <VisualizerDiorama {...props} />,
    renderSettingsPanel: props => <DioramaSettingsPanel {...props} />,
    renderQuickControls: ({ tuning, onTuningChange, t }: VisualizerQuickControlsProps<DioramaTuning>) => (
        <>
            <QuickControlToggle
                active={tuning.soulEnabled}
                label={t('options.dioramaSoulEffect')}
                onToggle={() => onTuningChange({ soulEnabled: !tuning.soulEnabled })}
            >
                <Ghost size={14} />
            </QuickControlToggle>
        </>
    ),
});
