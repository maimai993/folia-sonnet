import React from 'react';
import { Waves } from 'lucide-react';
import { DEFAULT_PARTICLES_BACKGROUND_TUNING } from '../../../../types';
import ParticlesBackground from './ParticlesBackground';
import ParticlesBackgroundSettingsCard from './ParticlesBackgroundSettingsCard';
import ParticlesFormChip from './ParticlesFormChip';
import { defineVisualizerBackground } from '../definition';
import { resolveParticlesForm } from './forms';
import { QuickControlToggle } from '../../../shared/QuickControlChip';

// src/components/visualizer/backgrounds/particles/entry.tsx
// Registers the cover-particle background (ported from Mineradio's cover particles).
//
// 这个背景现在是 3D 舞台：拖动可以转视角，双击回正。
// 因此手势层的横滑切歌与双击暂停对它让位（见 backgrounds/freeCameraModes.ts）。

export default defineVisualizerBackground({
    mode: 'particles',
    order: 55,
    labelKey: 'options.visualizerBackgroundModeParticles',
    labelFallback: '粒子',
    // 粒子：一堆小点
    glyph: (
        <>
            <circle cx="7" cy="7" r="1.9" />
            <circle cx="15" cy="6" r="1.4" opacity="0.6" />
            <circle cx="5" cy="14" r="1.4" opacity="0.6" />
            <circle cx="12" cy="12" r="2.4" />
            <circle cx="18" cy="15" r="1.7" opacity="0.75" />
            <circle cx="8" cy="19" r="1.2" opacity="0.45" />
            <circle cx="16" cy="19" r="1.2" opacity="0.45" />
        </>
    ),
    command: {
        title: 'Background: Particles',
        description: 'Cover broken into particles that ripple and jump',
        keywords: ['particles', 'particle', 'cover particles', '粒子', '粒子背景', '封面粒子', '跳跃'],
    },
    // 封面换了就整块重画（粒子是从封面取样来的）
    song: ({ coverUrl }) => [coverUrl ?? null],
    render: ({ coverUrl, theme, audioBands, paused, config, seed }) => {
        const tuning = config?.particles?.tuning ?? DEFAULT_PARTICLES_BACKGROUND_TUNING;
        return (
            <ParticlesBackground
                coverUrl={coverUrl}
                theme={theme}
                audioBands={audioBands}
                paused={paused}
                /*
                 * 「自动」在这里就解析成具体形态 —— 按 seed 挑（同一首歌总是同一个形态，
                 * 换歌才换），和町景的场景「自动」一个做法。
                 * 放在这里而不是组件里，是为了让组件只认具体的四种形态。
                 */
                form={resolveParticlesForm(tuning.form, seed ?? '')}
                grid={tuning.grid}
                intensity={tuning.intensity}
                pointScale={tuning.pointScale}
                tintStrength={tuning.tintStrength}
                autoRipple={tuning.autoRipple}
                /*
                 * 3D 舞台：拖动转视角、双指缩放、双击回初始视角。
                 * 相机和町景共用一套（backgrounds/orbitStage.ts）。
                 */
                orbit
            />
        );
    },
    renderSettingsPanel: ({ config, actions, t, onSliderPointerDown, onSliderCommit }) => (
        <ParticlesBackgroundSettingsCard
            t={t}
            tuning={config?.particles?.tuning ?? DEFAULT_PARTICLES_BACKGROUND_TUNING}
            onTuningChange={actions?.particles?.onTuningChange}
            onSliderPointerDown={onSliderPointerDown}
            onSliderCommit={onSliderCommit}
        />
    ),
    renderQuickControls: ({ config, actions, t }) => {
        const tuning = config?.particles?.tuning ?? DEFAULT_PARTICLES_BACKGROUND_TUNING;
        const onTuningChange = actions?.particles?.onTuningChange;
        return (
            <>
                {/*
                 * 形态做成播放控制台上的一个胶囊按钮：写着当前是哪一种，
                 * 点一下换下一种（自动 → 丝绸 → 滚筒 → 星球 → 唱片 → 自动）。
                 *
                 * 早先这里铺的是五个大卡片，把这一格撑成两行、把别的控件挤下去了。
                 * 要一眼看全部、或者要挑特定的一种，去设置面板（ParticlesFormGrid）。
                 */}
                <ParticlesFormChip
                    value={tuning.form}
                    t={t}
                    onChange={form => onTuningChange?.({ form })}
                />
                <QuickControlToggle
                    active={tuning.autoRipple}
                    label={t('options.particlesAutoRipple')}
                    onToggle={() => onTuningChange?.({ autoRipple: !tuning.autoRipple })}
                >
                    <Waves size={14} />
                </QuickControlToggle>
            </>
        );
    },
    resetSettings: actions => actions?.particles?.onResetTuning?.(),
});
