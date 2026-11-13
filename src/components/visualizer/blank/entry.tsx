import React from 'react';
import { defineVisualizer } from '../definition';

// src/components/visualizer/blank/entry.tsx
// 什么都不画的歌词样式。
//
// 为什么要有它：有人只想看视频 / 只看封面，不想让歌词盖在上面。以前这是「MV 打开时
// 隐藏歌词」那个开关的事 —— 但那是一个藏在设置里的开关，只在 MV 那一种情况下生效，
// 别的时候想看纯画面就没有办法。做成一个样式之后，它是普通的一个选项：选它的人
// 自己知道自己在做什么，而且和别的样式一样随处可选（播放页、命令面板、OBS）。
//
// 它不画背景（背景交还宿主），也不接收歌词 —— 见 VisualizerBlank。

const VisualizerBlank = React.lazy(() => import('./VisualizerBlank'));

export default defineVisualizer({
    mode: 'blank',
    // 排在最后：它不是一个「效果」，是「不要效果」。
    order: 900,
    labelKey: 'ui.visualizerBlank',
    labelFallback: 'Blank',
    previewSeed: 'blank',
    previewStartOffset: 0,
    // 一个空心的方框，表示「这里没有东西」。
    glyph: (
        <>
            <path d="M4 4h16v16H4z" opacity="0.35" />
            <path d="M4 4h16v16H4z" opacity="0.35" />
        </>
    ),
    command: {
        title: 'Visualizer: Blank',
        description: 'Show no lyrics at all',
        keywords: ['blank', 'none', 'empty', 'off', '无歌词', '不显示'],
    },
    // 背景照旧由宿主画：关掉歌词不代表要关掉背景。
    background: false,
    render: props => <VisualizerBlank {...props} />,
});
