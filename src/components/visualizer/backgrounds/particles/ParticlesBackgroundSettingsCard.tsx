import React from 'react';
import type { ParticlesBackgroundTuning } from '../../../../types';
import { Group, type SettingsGroupDef } from '../../../modal/settings/kit';
import { SliderRow, ToggleRow } from '../../panelRows';
import ParticlesFormGrid from './ParticlesFormGrid';

// src/components/visualizer/backgrounds/particles/ParticlesBackgroundSettingsCard.tsx
// 粒子背景的可调项。
//
// 这一组是 Mineradio 那边的调参在我们这套渲染上的对应物：
// 疏密（网格）、强度、粒子大小、着色强度、自动涟漪。
// Mineradio 的 bloom / scatter / twist 没有搬 —— 我们的着色器里没有那几个效果，
// 放一个不生效的滑条只会让人以为坏了。
const PARTICLES_GROUP: SettingsGroupDef = { id: 'bg-particles', titleKey: 'options.particlesBackgroundSettings' };

/** 百分比显示，滑条只存 0..1 的倍数。 */
const percent = (value: number): string => `${Math.round(value * 100)}%`;

/** 倍数显示。 */
const times = (value: number): string => `${value.toFixed(2)}×`;

interface ParticlesBackgroundSettingsCardProps {
    t: (key: string) => string;
    tuning: ParticlesBackgroundTuning;
    onTuningChange?: (patch: Partial<ParticlesBackgroundTuning>) => void;
    onSliderPointerDown?: () => void;
    onSliderCommit?: () => void;
}

const ParticlesBackgroundSettingsCard: React.FC<ParticlesBackgroundSettingsCardProps> = ({
    t,
    tuning,
    onTuningChange,
    onSliderPointerDown,
    onSliderCommit,
}) => {
    const drag = { onDragStart: onSliderPointerDown, onDragEnd: onSliderCommit };

    return (
        <Group def={PARTICLES_GROUP}>
            {/*
              * 形态放在最前：它决定下面那些滑条作用在什么画面上。
              * 五个值对应 Mineradio 同一套粒子着色器的五个预设分支。
              *
              * ★ 用大图标卡片，不用下拉。
              *
              * 原来这里是一个 Select 下拉：几种形态在文字上完全没法区分
              * （丝绸 / 滚筒 / 星球 / 唱片），得先点开、再对着文字猜。
              * 换成和町景「场景」一样的卡片之后，看图就知道是哪一种。
              * 播放控制台上是一个循环切换的按钮（ParticlesFormChip）。
              */}
            <div className="py-3">
                <ParticlesFormGrid
                    value={tuning.form}
                    t={t}
                    onChange={form => onTuningChange?.({ form })}
                />
            </div>
            <SliderRow
                label={t('options.particlesGrid')}
                note={t('options.particlesGridDesc')}
                value={tuning.grid}
                min={32}
                max={192}
                step={8}
                format={value => `${Math.round(value)}`}
                onChange={grid => onTuningChange?.({ grid: Math.round(grid) })}
                {...drag}
            />
            <SliderRow
                label={t('options.particlesIntensity')}
                note={t('options.particlesIntensityDesc')}
                value={tuning.intensity}
                min={0}
                max={2}
                step={0.05}
                format={times}
                marks={[{ value: 1 }]}
                onChange={intensity => onTuningChange?.({ intensity })}
                {...drag}
            />
            <SliderRow
                label={t('options.particlesPointScale')}
                note={t('options.particlesPointScaleDesc')}
                value={tuning.pointScale}
                min={0.4}
                max={2.5}
                step={0.05}
                format={times}
                marks={[{ value: 1 }]}
                onChange={pointScale => onTuningChange?.({ pointScale })}
                {...drag}
            />
            <SliderRow
                label={t('options.particlesTintStrength')}
                note={t('options.particlesTintStrengthDesc')}
                value={tuning.tintStrength}
                min={0}
                max={1}
                step={0.05}
                format={percent}
                onChange={tintStrength => onTuningChange?.({ tintStrength })}
                {...drag}
            />
            <ToggleRow
                label={t('options.particlesAutoRipple')}
                note={t('options.particlesAutoRippleDesc')}
                checked={tuning.autoRipple}
                onChange={autoRipple => onTuningChange?.({ autoRipple })}
            />
        </Group>
    );
};

export default ParticlesBackgroundSettingsCard;
