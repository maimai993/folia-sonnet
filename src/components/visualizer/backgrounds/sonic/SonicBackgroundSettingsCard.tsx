import React from 'react';
import type { SonicBackgroundTuning } from '../../../../types';
import { Group, type SettingsGroupDef } from '../../../modal/settings/kit';
import { SliderRow } from '../../panelRows';

// src/components/visualizer/backgrounds/sonic/SonicBackgroundSettingsCard.tsx
// 音域回响的可调项：密度、幅度、范围、高低、景深、发光、平滑、锐利。
//
// 全部是 0..100 的整数 —— 和 Mineradio 那边的取值域一致，默认值也照抄，
// 所以这里不需要任何单位换算，滑条上直接显示数字。

const SONIC_GROUP: SettingsGroupDef = { id: 'bg-sonic', titleKey: 'options.sonicBackgroundSettings' };

/** 0..100 的整数直接显示。 */
const level = (value: number): string => `${Math.round(value)}`;

interface SonicBackgroundSettingsCardProps {
    t: (key: string) => string;
    tuning: SonicBackgroundTuning;
    onTuningChange?: (patch: Partial<SonicBackgroundTuning>) => void;
    onSliderPointerDown?: () => void;
    onSliderCommit?: () => void;
}

const SonicBackgroundSettingsCard: React.FC<SonicBackgroundSettingsCardProps> = ({
    t,
    tuning,
    onTuningChange,
    onSliderPointerDown,
    onSliderCommit,
}) => {
    const drag = { onDragStart: onSliderPointerDown, onDragEnd: onSliderCommit };

    const row = (
        key: keyof SonicBackgroundTuning,
        labelKey: string,
        noteKey: string,
        min: number,
        marks?: { value: number }[],
    ) => (
        <SliderRow
            label={t(labelKey)}
            note={t(noteKey)}
            value={tuning[key]}
            min={min}
            max={100}
            step={1}
            format={level}
            marks={marks}
            onChange={value => onTuningChange?.({ [key]: Math.round(value) } as Partial<SonicBackgroundTuning>)}
            {...drag}
        />
    );

    return (
        <Group def={SONIC_GROUP}>
            {row('density', 'options.sonicDensity', 'options.sonicDensityDesc', 20)}
            {/* 幅度 50 是标定值：低于 50 线性变小，高于 50 按平方放大，所以标一个刻度。 */}
            {row('amplitude', 'options.sonicAmplitude', 'options.sonicAmplitudeDesc', 0, [{ value: 50 }])}
            {row('range', 'options.sonicRange', 'options.sonicRangeDesc', 0)}
            {row('lower', 'options.sonicLower', 'options.sonicLowerDesc', 0)}
            {row('depth', 'options.sonicDepth', 'options.sonicDepthDesc', 0)}
            {row('glow', 'options.sonicGlow', 'options.sonicGlowDesc', 0)}
            {row('smoothness', 'options.sonicSmoothness', 'options.sonicSmoothnessDesc', 0, [{ value: 50 }])}
            {row('sharpness', 'options.sonicSharpness', 'options.sonicSharpnessDesc', 0, [{ value: 50 }])}
        </Group>
    );
};

export default SonicBackgroundSettingsCard;
