import React from 'react';
import {
    DEFAULT_DIORAMA_TUNING,
    DIORAMA_PARTICLE_DENSITY_MAX,
    DIORAMA_PARTICLE_DENSITY_MIN,
    DIORAMA_PARTICLE_GLOW_INTENSITY_MAX,
    DIORAMA_PARTICLE_GLOW_INTENSITY_MIN,
    DIORAMA_PARTICLE_SIZE_MAX,
    DIORAMA_PARTICLE_SIZE_MIN,
    type DioramaTuning,
} from '../../../types';
import { Group, type SettingsGroupDef } from '../../modal/settings/kit';
import { type VisualizerSettingsPanelProps } from '../definition';
import { DioramaGeometrySettings } from './DioramaGeometrySettings';
import { DioramaBackgroundParticleSettings } from './DioramaBackgroundParticleSettings';
import { DioramaEffectSettings } from './DioramaEffectSettings';
import { resolveDioramaMoteCircumference, resolveDioramaMoteRadial } from '../../../utils/visualizer/dioramaMoteTuning';
import { percent, SliderRow, times } from '../panelRows';

// src/components/visualizer/diorama/DioramaSettingsPanel.tsx
// Diorama's settings: camera motion, geometry visibility, particles and the background motes.
const DIORAMA_GROUP: SettingsGroupDef = { id: 'vis-diorama', titleKey: 'options.dioramaSettings' };
const clampDioramaCameraSpeed = (value: number) => Math.min(1.85, Math.max(0.55, value));
const clampDioramaMotionAmount = (value: number) => Math.min(1.6, Math.max(0.4, value));
const clampDioramaAudioReactivity = (value: number) => Math.min(1.5, Math.max(0, value));

export const DioramaSettingsPanel: React.FC<VisualizerSettingsPanelProps<DioramaTuning>> = ({
    t,
    onSliderPointerDown,
    onSliderCommit,
    tuning: dioramaTuning = DEFAULT_DIORAMA_TUNING,
    onTuningChange: onDioramaTuningChange,
}) => {
    const resolvedTuning: DioramaTuning = {
        cameraSpeed: clampDioramaCameraSpeed(dioramaTuning.cameraSpeed ?? DEFAULT_DIORAMA_TUNING.cameraSpeed),
        motionAmount: clampDioramaMotionAmount(dioramaTuning.motionAmount ?? DEFAULT_DIORAMA_TUNING.motionAmount),
        audioReactivity: clampDioramaAudioReactivity(dioramaTuning.audioReactivity ?? DEFAULT_DIORAMA_TUNING.audioReactivity),
        geometryVisibility: {
            ...DEFAULT_DIORAMA_TUNING.geometryVisibility,
            ...dioramaTuning.geometryVisibility,
        },
        particleDensity: Math.round(Math.min(
            DIORAMA_PARTICLE_DENSITY_MAX,
            Math.max(DIORAMA_PARTICLE_DENSITY_MIN, dioramaTuning.particleDensity ?? DEFAULT_DIORAMA_TUNING.particleDensity),
        )),
        particleScale: Math.min(
            DIORAMA_PARTICLE_SIZE_MAX,
            Math.max(DIORAMA_PARTICLE_SIZE_MIN, dioramaTuning.particleScale ?? DEFAULT_DIORAMA_TUNING.particleScale),
        ),
        particleGlowEnabled: dioramaTuning.particleGlowEnabled ?? DEFAULT_DIORAMA_TUNING.particleGlowEnabled,
        particleGlowIntensity: Math.min(
            DIORAMA_PARTICLE_GLOW_INTENSITY_MAX,
            Math.max(
                DIORAMA_PARTICLE_GLOW_INTENSITY_MIN,
                dioramaTuning.particleGlowIntensity ?? DEFAULT_DIORAMA_TUNING.particleGlowIntensity,
            ),
        ),
        showParticles: dioramaTuning.showParticles ?? DEFAULT_DIORAMA_TUNING.showParticles,
        backgroundParticleCircumference: resolveDioramaMoteCircumference(
            dioramaTuning.backgroundParticleCircumference ?? DEFAULT_DIORAMA_TUNING.backgroundParticleCircumference,
        ),
        backgroundParticleRadial: resolveDioramaMoteRadial(
            dioramaTuning.backgroundParticleRadial ?? DEFAULT_DIORAMA_TUNING.backgroundParticleRadial,
        ),
        glowEnabled: dioramaTuning.glowEnabled ?? DEFAULT_DIORAMA_TUNING.glowEnabled,
        glowIntensity: Math.min(1.5, Math.max(0.1, dioramaTuning.glowIntensity ?? DEFAULT_DIORAMA_TUNING.glowIntensity)),
        soulEnabled: dioramaTuning.soulEnabled ?? DEFAULT_DIORAMA_TUNING.soulEnabled,
        soulIntensity: Math.min(1.5, Math.max(0.1, dioramaTuning.soulIntensity ?? DEFAULT_DIORAMA_TUNING.soulIntensity)),
        soulActiveEnabled: dioramaTuning.soulActiveEnabled ?? DEFAULT_DIORAMA_TUNING.soulActiveEnabled,
        gradientEnabled: dioramaTuning.gradientEnabled ?? DEFAULT_DIORAMA_TUNING.gradientEnabled,
        gradientIntensity: Math.min(1.5, Math.max(0.1, dioramaTuning.gradientIntensity ?? DEFAULT_DIORAMA_TUNING.gradientIntensity)),
    };

    const handleDioramaTuningChange = (patch: Partial<DioramaTuning>) => {
        onDioramaTuningChange?.(patch);
    };
    const drag = { onDragStart: onSliderPointerDown, onDragEnd: onSliderCommit };

    return (
        <Group def={DIORAMA_GROUP}>
            <SliderRow
                {...drag}
                label={t('options.dioramaCameraSpeed')}
                value={resolvedTuning.cameraSpeed}
                min={0.55}
                max={1.85}
                step={0.05}
                format={times}
                onChange={(value) => handleDioramaTuningChange({ cameraSpeed: value })}
            />
            <SliderRow
                {...drag}
                label={t('options.dioramaMotionAmount')}
                value={resolvedTuning.motionAmount}
                min={0.4}
                max={1.6}
                step={0.05}
                format={times}
                onChange={(value) => handleDioramaTuningChange({ motionAmount: value })}
            />
            <SliderRow
                {...drag}
                label={t('options.dioramaAudioReactivity')}
                value={resolvedTuning.audioReactivity}
                min={0}
                max={1.5}
                step={0.05}
                format={percent}
                onChange={(value) => handleDioramaTuningChange({ audioReactivity: value })}
            />

            {/* Three independent, stackable follow-sing effects - each a switch with its strength
                folded under it. Their rendering paths are fully separate in DioramaScene, so enabling one
                never stands in for another. */}
            <DioramaEffectSettings
                label={t('options.dioramaGlowEffect')}
                enabled={resolvedTuning.glowEnabled}
                intensity={resolvedTuning.glowIntensity}
                onEnabledChange={(next) => handleDioramaTuningChange({ glowEnabled: next })}
                onIntensityChange={(next) => handleDioramaTuningChange({ glowIntensity: next })}
                t={t}
                onSliderPointerDown={onSliderPointerDown}
                onSliderCommit={onSliderCommit}
            />
            {/* 灵魂出窍跟唱, with 当前字漂移 as its nested child (same underlying effect, scoped to the word
                being sung) shown under it - not a standalone effect in the list. */}
            <DioramaEffectSettings
                label={t('options.dioramaSoulEffect')}
                enabled={resolvedTuning.soulEnabled}
                intensity={resolvedTuning.soulIntensity}
                onEnabledChange={(next) => handleDioramaTuningChange({ soulEnabled: next })}
                onIntensityChange={(next) => handleDioramaTuningChange({ soulIntensity: next })}
                subEffect={{
                    label: t('options.dioramaSoulActiveEffect'),
                    enabled: resolvedTuning.soulActiveEnabled,
                    onEnabledChange: (next) => handleDioramaTuningChange({ soulActiveEnabled: next }),
                }}
                t={t}
                onSliderPointerDown={onSliderPointerDown}
                onSliderCommit={onSliderCommit}
            />
            <DioramaEffectSettings
                label={t('options.dioramaGradientEffect')}
                enabled={resolvedTuning.gradientEnabled}
                intensity={resolvedTuning.gradientIntensity}
                onEnabledChange={(next) => handleDioramaTuningChange({ gradientEnabled: next })}
                onIntensityChange={(next) => handleDioramaTuningChange({ gradientIntensity: next })}
                t={t}
                onSliderPointerDown={onSliderPointerDown}
                onSliderCommit={onSliderCommit}
            />
            {/* 关键词着色不再单列：它是全局开关（设置 → 外观），样式这边读了同一个值。 */}
            <DioramaGeometrySettings
                t={t}
                value={resolvedTuning.geometryVisibility}
                onChange={(geometryVisibility) => handleDioramaTuningChange({ geometryVisibility })}
                density={resolvedTuning.particleDensity}
                onDensityChange={(particleDensity) => handleDioramaTuningChange({ particleDensity })}
                particleScale={resolvedTuning.particleScale}
                onParticleScaleChange={(particleScale) => handleDioramaTuningChange({ particleScale })}
                glowEnabled={resolvedTuning.particleGlowEnabled}
                onGlowEnabledChange={(particleGlowEnabled) => handleDioramaTuningChange({ particleGlowEnabled })}
                glowIntensity={resolvedTuning.particleGlowIntensity}
                onGlowIntensityChange={(particleGlowIntensity) => handleDioramaTuningChange({ particleGlowIntensity })}
                onSliderPointerDown={onSliderPointerDown}
                onSliderCommit={onSliderCommit}
            />

            <DioramaBackgroundParticleSettings
                label={t('options.dioramaShowParticles')}
                enabled={resolvedTuning.showParticles}
                circumference={resolvedTuning.backgroundParticleCircumference}
                radial={resolvedTuning.backgroundParticleRadial}
                onEnabledChange={(next) => handleDioramaTuningChange({ showParticles: next })}
                onCircumferenceChange={(backgroundParticleCircumference) => handleDioramaTuningChange({ backgroundParticleCircumference })}
                onRadialChange={(backgroundParticleRadial) => handleDioramaTuningChange({ backgroundParticleRadial })}
                t={t}
                onSliderPointerDown={onSliderPointerDown}
                onSliderCommit={onSliderCommit}
            />
        </Group>
    );
};
