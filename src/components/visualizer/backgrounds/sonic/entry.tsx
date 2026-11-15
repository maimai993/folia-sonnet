import React from 'react';
import SonicBackground from './SonicBackground';
import SonicBackgroundSettingsCard from './SonicBackgroundSettingsCard';
import { DEFAULT_SONIC_BACKGROUND_TUNING } from '../../../../types';
import { defineVisualizerBackground } from '../definition';

// src/components/visualizer/backgrounds/sonic/entry.tsx
// Registers the sonic topography background (ported from Mineradio's sonic-topography-preset).
//
// 这是一个**纯背景**：几万根发光柱子组成的地形，8 个频段驱动不同形态的起伏。
// 不含歌词文字、不随歌词行变化。
//
// Mineradio 那边把它做成两个预设（音域回响 / Wallpaper Engine 版），
// 差别只在配色来源和默认滑条值；这里合并成一个背景，配色跟随主题、
// 滑条交给用户 —— 两个预设的差异在这个模型下没有单独成项的价值。

export default defineVisualizerBackground({
    mode: 'sonic',
    order: 58,
    labelKey: 'options.visualizerBackgroundModeSonic',
    labelFallback: '音域回响',
    // 音域回响：一片高低起伏的柱状地形
    glyph: (
        <>
            <path d="M3 18.5v-4.2M6.6 18.5v-7.4M10.2 18.5v-11M13.8 18.5v-6.2M17.4 18.5v-9.4M21 18.5v-3" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M3 18.5h18" strokeWidth="1.2" opacity="0.45" />
        </>
    ),
    command: {
        title: 'Background: Sonic Topography',
        description: 'A terrain of glowing columns driven by eight frequency bands',
        keywords: ['sonic', 'topography', 'terrain', 'ground', 'eq', '音域回响', '地形', '频谱地形', '背景切换到音域回响'],
    },
    /*
     * 没有 `song`：地形不吃封面图，只吃主题色与频段。
     * 换歌时不需要整块重画 —— 配色按主题过渡，地形本身只是继续起伏。
     */
    render: ({ theme, audioBands, paused, config }) => {
        const tuning = config?.sonic?.tuning ?? DEFAULT_SONIC_BACKGROUND_TUNING;
        return (
            <div className="absolute inset-0 z-0">
                <SonicBackground
                    theme={theme}
                    audioBands={audioBands}
                    // 暂停就冻结时间轴：地形起伏、漂浮方块、涟漪全是时间的函数。
                    paused={paused}
                    density={tuning.density}
                    amplitude={tuning.amplitude}
                    range={tuning.range}
                    lower={tuning.lower}
                    depth={tuning.depth}
                    glow={tuning.glow}
                    smoothness={tuning.smoothness}
                    sharpness={tuning.sharpness}
                    // 3D 舞台：和町景、粒子、星河、安魂共用同一套轨道相机。
                    orbit
                />
            </div>
        );
    },
    renderSettingsPanel: ({ config, actions, t, onSliderPointerDown, onSliderCommit }) => (
        <SonicBackgroundSettingsCard
            t={t}
            tuning={config?.sonic?.tuning ?? DEFAULT_SONIC_BACKGROUND_TUNING}
            onTuningChange={actions?.sonic?.onTuningChange}
            onSliderPointerDown={onSliderPointerDown}
            onSliderCommit={onSliderCommit}
        />
    ),
    resetSettings: actions => actions?.sonic?.onResetTuning?.(),
});
