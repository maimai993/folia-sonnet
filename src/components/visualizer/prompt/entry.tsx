import React from 'react';
import { defineVisualizer } from '../definition';

// src/components/visualizer/prompt/entry.tsx
// 提示词：一句一个输入框 —— 每唱完一句，这个框飞走、下一个框飞进来，框里的词按唱到的位置
// 逐个落下。它**不依赖商籁**：自己的运行时（createPromptPixiRuntime）、自己的节目单
// （compilePromptBoxes，一句一框）、自己的框几何（promptBox.ts）。
const VisualizerPrompt = React.lazy(() => import('./VisualizerPrompt'));

export default defineVisualizer({
    mode: 'prompt',
    // 提示词是纯文字动画画面，按分组定稿①「完全不做智能动感」：不声明任何效果，
    // 设置里不出现这一组，也不为它跑分析。运行时里两条按旧轨道读的 lift 保持代码
    // 不动 —— 信号层对 prompt.* 恒 0，画面自然保持原样。
    order: 11,
    labelKey: 'ui.visualizerPrompt',
    labelFallback: '提示词',
    previewSeed: 'prompt',
    previewStartOffset: 0,
    // 提示词：一个输入框 + 光标
    glyph: (
        <>
            <path d="M3 6.5h18v11H3z" opacity="0.55" />
            <path d="M6 10.5h4.5M6 13.5h8" />
            <path d="M17.5 12.6v-2.4" opacity="0.8" />
        </>
    ),
    command: {
        title: 'Visualizer: Prompt',
        description: 'Switch to the prompt-box visualizer',
        keywords: ['prompt', 'chat', 'dialog', 'input', '提示词', '输入框', '对话框', '打字'],
    },
    usesWordSegmentation: true,
    render: props => <VisualizerPrompt {...props} />,
});
