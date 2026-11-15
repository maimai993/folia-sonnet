import React from 'react';
import type { VisualizerSharedProps } from '../definition';
import VisualizerShell from '../VisualizerShell';

// src/components/visualizer/blank/VisualizerBlank.tsx
// 只留外壳，不画歌词。
//
// 外壳照旧留着：背景、视频层、整体透明度都在它那边，样式不画歌词不代表要把这些
// 一起关掉。这里一个歌词元素都不挂，所以屏幕上只剩背景和（打开时的）视频。
//
// 为什么不直接 `return null`：那样连外壳一起没了，背景和视频层也会跟着消失 ——
// 那就不再是「不要歌词」，而是「什么都不要」了。

const VisualizerBlank: React.FC<VisualizerSharedProps> = ({
    theme,
    isDaylight = false,
    audioPower,
    audioBands,
    ...sharedProps
}) => (
    <VisualizerShell
        theme={theme}
        audioPower={audioPower}
        audioBands={audioBands}
        sharedProps={{
            ...sharedProps,
            isDaylight,
        }}
        renderBackground={false}
        className="visualizer-blank"
    >
        {null}
    </VisualizerShell>
);

export default VisualizerBlank;
