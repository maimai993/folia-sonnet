import React from 'react';
import { DEFAULT_KINETIC_TUNING, type KineticTuning } from './types';
import { Group, Row, Segmented, type SettingsGroupDef } from '../../modal/settings/kit';
import { type VisualizerSettingsPanelProps } from '../definition';
import { percent, SliderRow, times, ToggleRow } from '../panelRows';
import type { KineticEntranceStyle, KineticLayoutMode } from './types';

// src/components/visualizer/kinetic/KineticSettingsPanel.tsx
// 文字PV 自己的调参面板：入场风格、布局、逐字延迟、缩放、位移、装饰与镜头晃动，全部接到渲染。

const KINETIC_GROUP: SettingsGroupDef = { id: 'vis-kinetic', titleKey: 'options.kineticSettings' };

const KineticSettingsPanel: React.FC<VisualizerSettingsPanelProps<KineticTuning>> = ({
    t,
    tuning,
    onTuningChange,
    onSliderPointerDown,
    onSliderCommit,
}) => {
    const resolvedTuning = tuning ?? DEFAULT_KINETIC_TUNING;
    const drag = { onDragStart: onSliderPointerDown, onDragEnd: onSliderCommit };

    return (
        <Group def={KINETIC_GROUP}>
            <Row label={t('options.kineticEntrance')}>
                <Segmented<KineticEntranceStyle>
                    value={resolvedTuning.entrance}
                    options={[
                        { value: 'pop', label: t('options.kineticEntrancePop') },
                        { value: 'slide', label: t('options.kineticEntranceSlide') },
                        { value: 'drop', label: t('options.kineticEntranceDrop') },
                        { value: 'wipe', label: t('options.kineticEntranceWipe') },
                    ]}
                    onChange={(next) => onTuningChange?.({ entrance: next })}
                />
            </Row>
            <Row label={t('options.kineticLayout')}>
                <Segmented<KineticLayoutMode>
                    value={resolvedTuning.layout}
                    options={[
                        { value: 'cascade', label: t('options.kineticLayoutCascade') },
                        { value: 'grid', label: t('options.kineticLayoutGrid') },
                        { value: 'block', label: t('options.kineticLayoutBlock') },
                    ]}
                    onChange={(next) => onTuningChange?.({ layout: next })}
                />
            </Row>
            <SliderRow
                {...drag}
                label={t('options.kineticStaggerScale')}
                value={resolvedTuning.staggerScale}
                min={0}
                max={2}
                step={0.05}
                format={times}
                onChange={(value) => onTuningChange?.({ staggerScale: value })}
            />
            <SliderRow
                {...drag}
                label={t('options.kineticActiveScale')}
                value={resolvedTuning.activeScale}
                min={1}
                max={1.6}
                step={0.02}
                format={times}
                onChange={(value) => onTuningChange?.({ activeScale: value })}
            />
            <SliderRow
                {...drag}
                label={t('options.kineticOffsetAmplitude')}
                value={resolvedTuning.offsetAmplitude}
                min={0}
                max={48}
                step={1}
                format={(value) => `${Math.round(value)}px`}
                onChange={(value) => onTuningChange?.({ offsetAmplitude: value })}
            />
            <SliderRow
                {...drag}
                label={t('options.kineticCameraShake')}
                value={resolvedTuning.cameraShake}
                min={0}
                max={2}
                step={0.1}
                format={times}
                onChange={(value) => onTuningChange?.({ cameraShake: value })}
            />
            <ToggleRow
                label={t('options.kineticShowUnderline')}
                checked={resolvedTuning.showUnderline}
                onChange={(next) => onTuningChange?.({ showUnderline: next })}
            />
            <ToggleRow
                label={t('options.kineticShowEcho')}
                checked={resolvedTuning.showEcho}
                onChange={(next) => onTuningChange?.({ showEcho: next })}
            />
            <ToggleRow
                label={t('options.kineticShowStroke')}
                checked={resolvedTuning.showStroke}
                onChange={(next) => onTuningChange?.({ showStroke: next })}
            />
        </Group>
    );
};

export default KineticSettingsPanel;
