import React from 'react';
import { Settings2 } from 'lucide-react';
import { QuickControlToggle } from '../../shared/QuickControlChip';
import { defineVisualizer, type VisualizerQuickControlsProps } from '../definition';
import KineticSettingsPanel from './KineticSettingsPanel';
import kineticTuning from './tuning';
import type { KineticTuning } from './tuning';

const VisualizerKinetic = React.lazy(() => import('./VisualizerKinetic'));

// src/components/visualizer/kinetic/entry.tsx
// 注册文字PV（kinetic）：切换命令、小图标与设置面板都写在这个样式的 entry 里。
// 参数全部在原版编辑台里调；folia 侧只保留「打开原版编辑台」的快捷开关。

export default defineVisualizer({
    mode: 'kinetic',
    order: 55,
    labelKey: 'ui.visualizerKinetic',
    labelFallback: '文字PV',
    previewSeed: 'kinetic',
    previewStartOffset: 0,
    // 文字PV：JIZURA 原版渲染
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
    // 文字PV 的画面完全由 JIZURA 原版引擎（iframe）自带，含背景；
    // 让宿主不再挂共享背景层 —— 否则 sora 星空会叠两份 canvas 一起跑，中端机掉到 19fps。
    background: false,
    render: props => <VisualizerKinetic {...props} />,
    renderSettingsPanel: props => <KineticSettingsPanel {...props} />,
    renderQuickControls: ({ t }: VisualizerQuickControlsProps<KineticTuning>) => (
        <QuickControlToggle
            active={false}
            label={t('options.kineticOpenEditor')}
            onToggle={() => {
                // 快捷开关与设置面板共用一个入口：广播事件，由设置面板监听并打开编辑台。
                window.dispatchEvent(new CustomEvent('kinetic:open-editor'));
            }}
        >
            <Settings2 size={14} />
        </QuickControlToggle>
    ),
});
