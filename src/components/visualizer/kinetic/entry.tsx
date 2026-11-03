import React from 'react';
import { Type } from 'lucide-react';
import { QuickControlToggle } from '../../shared/QuickControlChip';
import { defineVisualizer, type VisualizerQuickControlsProps } from '../definition';
import KineticSettingsPanel from './KineticSettingsPanel';
import kineticTuning from './tuning';
import type { KineticTuning } from './types';

const VisualizerKinetic = React.lazy(() => import('./VisualizerKinetic'));

// src/components/visualizer/kinetic/entry.tsx
// 注册文字PV（kinetic）：切换命令、小图标与设置面板都写在这个样式的 entry 里。

export default defineVisualizer({
    mode: 'kinetic',
    order: 55,
    labelKey: 'ui.visualizerKinetic',
    labelFallback: '文字PV',
    previewSeed: 'kinetic',
    previewStartOffset: 0,
    // 文字PV：逐字点亮，字下一条强调线
    glyph: (
        <>
            <path d="M5 8l3-3 3 3" />
            <path d="M11 17h8" opacity="0.6" />
            <path d="M5 17h4" />
        </>
    ),
    command: {
        title: 'Visualizer: Text PV',
        description: 'Switch to kinetic text PV visualizer',
        keywords: ['kinetic', 'text pv', '文字PV', '动态字体'],
    },
    usesWordSegmentation: true,
    render: props => <VisualizerKinetic {...props} kineticTuning={kineticTuning.read(props.visualizerTunings)} />,
    renderSettingsPanel: props => <KineticSettingsPanel {...props} />,
    renderQuickControls: ({ tuning, onTuningChange, t }: VisualizerQuickControlsProps<KineticTuning>) => (
        <QuickControlToggle
            active={tuning.showUnderline}
            label={t('options.kineticShowUnderline')}
            onToggle={() => onTuningChange({ showUnderline: !tuning.showUnderline })}
        >
            <Type size={14} />
        </QuickControlToggle>
    ),
});
