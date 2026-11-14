import React from 'react';
import { setMvRequiredByStyle } from '../../../../services/mvRequirement';
import MvBackgroundSettingsCard from './MvBackgroundSettingsCard';
import { defineVisualizerBackground } from '../definition';

// src/components/visualizer/backgrounds/mv/entry.tsx
// 背景模式「MV」：整个 MV 的总开关。
//
// 选了它，播放页才给「别的平台的歌」匹配画面（B 站 BilibiliMvLayer 的 enabled 就是
// 读这一份 requirement）；换到任何别的背景，画面就收走。B 站自己的歌不受它管 ——
// 那条路的画面由 BilibiliVideoStage 负责，本来就是「歌即视频」。
//
// 和旧的歌词样式「MV」款的分工：那一款是「只要画面、不要歌词」；这一款是
// 「画面垫在底下，歌词照常画」—— 正是「MV 和歌词动画一起出现」的形态。
// 画面由 BilibiliMvLayer 注入视频层来画（在歌词层下面），这里自己什么都不渲染。

/** 挂载期间要求画面（见 services/mvRequirement）：背景选了 MV，视频层才开。 */
const MvBackgroundRequire: React.FC = () => {
    React.useEffect(() => {
        setMvRequiredByStyle(true);
        return () => setMvRequiredByStyle(false);
    }, []);
    return null;
};

export default defineVisualizerBackground({
    mode: 'mv',
    order: 45,
    labelKey: 'options.visualizerBackgroundModeMv',
    labelFallback: 'MV',
    // 播放三角的方框：画面。
    glyph: (
        <>
            <path d="M4 5.5h16v13H4z" opacity="0.35" />
            <path d="M10.5 9l4.5 3-4.5 3z" />
        </>
    ),
    command: {
        title: 'Background: MV',
        description: 'Switch background to Bilibili MV (video behind the lyrics)',
        keywords: ['mv', 'video background', 'MV', '视频背景', '画面背景', '背景切换到 MV'],
    },
    // 画面不由这一层画：BilibiliMvLayer 把解析好的视频流注入视频层（歌词层之下）。
    // 这里只表达「这一款背景要求有画面」。
    render: () => <MvBackgroundRequire />,
    renderSettingsPanel: ({ t }) => <MvBackgroundSettingsCard t={t} />,
});
