import React from 'react';
import { defineVisualizer } from '../definition';

// src/components/visualizer/mv/entry.tsx
// 「MV」样式：画面上铺满，歌词不出，并且强制要求有画面。
//
// 为什么要有它：以前想让画面铺满得去「连接与集成」里找那个 MV 开关，而那个开关只
// 决定「愿不愿意用视频」，不决定「这一款样式要不要歌词」。两者绑在一起的时候，用户
// 想要的是「这一款背景就叫 MV，选了就有画面、没有歌词」—— 一个概念，一个选项。
//
// 它不画背景（和 blank 一样交还宿主），也不接收歌词：见 VisualizerMv。

const VisualizerMv = React.lazy(() => import('./VisualizerMv'));

export default defineVisualizer({
    mode: 'mv',
    // 紧跟 blank：两者是「纯画面」的一对，摆在一起好找。
    order: 901,
    labelKey: 'ui.visualizerMv',
    labelFallback: 'MV',
    previewSeed: 'mv',
    previewStartOffset: 0,
    // 一个带播放三角的方框：画面，而不是歌词。
    glyph: (
        <>
            <path d="M3 4h18v16H3z" opacity="0.35" />
            <path d="M10 8.5l6 3.5-6 3.5z" />
        </>
    ),
    command: {
        title: 'Visualizer: MV',
        description: 'Fill the screen with the video, no lyrics, and turn the MV on',
        keywords: ['mv', 'video', '画面', '视频', '无歌词'],
    },
    // 背景照旧由宿主画：MV 这一层只管视频。
    background: false,
    render: props => <VisualizerMv {...props} />,
});
