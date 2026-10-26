import React, { useCallback } from 'react';
import { DEFAULT_CLASSIC_TUNING, DEFAULT_FUME_TUNING, DEFAULT_PARTITA_TUNING, DEFAULT_TILT_TUNING, type ClassicTuning, type FumeTuning, type PartitaTuning, type TiltColorScheme, type TiltTuning } from '../../types';
import { Group, PictureGrid, Reveal, Row, Segmented, Toggle, type SettingsGroupDef } from '../modal/settings/kit';
import { type VisualizerSettingsPanelProps } from './definition';
import { percent, SliderRow, times } from './panelRows';

// src/components/visualizer/settingsPanels.tsx
// Mode-owned preview settings panels used by discoverable visualizer entries. Each returns groups
// of the settings kit and nothing around them; the window stacks what a panel returns.
// Cappella, Claddagh and Diorama keep theirs beside their styles and are re-exported here.
const CLASSIC_GROUP: SettingsGroupDef = { id: 'vis-classic', titleKey: 'options.classicSettings' };
const PARTITA_GROUP: SettingsGroupDef = { id: 'vis-partita', titleKey: 'options.partitaSettings' };
const FUME_GROUP: SettingsGroupDef = { id: 'vis-fume', titleKey: 'options.fumeSettings' };
const TILT_GROUP: SettingsGroupDef = { id: 'vis-tilt', titleKey: 'options.tiltSettings' };

const clampPartitaStagger = (value: number) => Math.min(180, Math.max(0, value));
const clampClassicBreathingFloatMultiplier = (value: number) => Math.min(2, Math.max(0, value));
const clampClassicWordSpacing = (value: number) => Math.min(2, Math.max(0, value));

export const ClassicSettingsPanel: React.FC<VisualizerSettingsPanelProps<ClassicTuning>> = ({
    t,
    onSliderPointerDown,
    onSliderCommit,
    tuning: classicTuning = DEFAULT_CLASSIC_TUNING,
    onTuningChange: onClassicTuningChange,
}) => {
    const resolvedClassicTuning: Required<ClassicTuning> = {
        enableWordRotation: classicTuning.enableWordRotation ?? DEFAULT_CLASSIC_TUNING.enableWordRotation,
        breathingFloatMultiplier: clampClassicBreathingFloatMultiplier(
            classicTuning.breathingFloatMultiplier ?? DEFAULT_CLASSIC_TUNING.breathingFloatMultiplier,
        ),
        useLegacyLayout: classicTuning.useLegacyLayout ?? DEFAULT_CLASSIC_TUNING.useLegacyLayout ?? false,
        wordSpacing: clampClassicWordSpacing(
            classicTuning.wordSpacing ?? DEFAULT_CLASSIC_TUNING.wordSpacing ?? 0.7
        ),
    };
    const drag = { onDragStart: onSliderPointerDown, onDragEnd: onSliderCommit };

    return (
        <Group def={CLASSIC_GROUP}>
            <Row label={t('options.classicWordRotation')}>
                <Toggle
                    checked={resolvedClassicTuning.enableWordRotation}
                    onChange={(enabled) => onClassicTuningChange?.({ enableWordRotation: enabled })}
                />
            </Row>
            <Row label={t('options.classicLegacyLayout')}>
                <Segmented
                    value={resolvedClassicTuning.useLegacyLayout ? 'legacy' : 'adaptive'}
                    options={[
                        { value: 'adaptive', label: t('options.classicLegacyLayoutOff') },
                        { value: 'legacy', label: t('options.classicLegacyLayoutOn') },
                    ]}
                    onChange={(next) => onClassicTuningChange?.({ useLegacyLayout: next === 'legacy' })}
                />
            </Row>
            <SliderRow
                {...drag}
                label={t('options.classicBreathingFloatMultiplier')}
                value={resolvedClassicTuning.breathingFloatMultiplier}
                min={0}
                max={2}
                step={0.05}
                format={times}
                onChange={(value) => onClassicTuningChange?.({ breathingFloatMultiplier: value })}
            />
            <Reveal when={!resolvedClassicTuning.useLegacyLayout}>
                <SliderRow
                    {...drag}
                    label={t('options.classicWordSpacing')}
                    value={resolvedClassicTuning.wordSpacing}
                    min={0}
                    max={2}
                    step={0.05}
                    format={times}
                    onChange={(value) => onClassicTuningChange?.({ wordSpacing: value })}
                />
            </Reveal>
        </Group>
    );
};
export const PartitaSettingsPanel: React.FC<VisualizerSettingsPanelProps<PartitaTuning>> = ({
    t,
    onSliderPointerDown,
    onSliderCommit,
    tuning: partitaTuning = DEFAULT_PARTITA_TUNING,
    onTuningChange: onPartitaTuningChange,
}) => {
    const rawMin = clampPartitaStagger(partitaTuning.staggerMin ?? DEFAULT_PARTITA_TUNING.staggerMin);
    const rawMax = clampPartitaStagger(partitaTuning.staggerMax ?? DEFAULT_PARTITA_TUNING.staggerMax);
    const resolvedPartitaTuning: PartitaTuning = {
        showGuideLines: partitaTuning.showGuideLines ?? DEFAULT_PARTITA_TUNING.showGuideLines,
        useSemanticLayout: partitaTuning.useSemanticLayout ?? DEFAULT_PARTITA_TUNING.useSemanticLayout,
        staggerMin: Math.min(rawMin, rawMax),
        staggerMax: Math.max(rawMin, rawMax),
    };
    // A slider moved past the other end takes that end along: both ends are sent. Sent alone, the
    // moved end would be put in order by the tuning's merge (partita/tuning.ts), which swaps the
    // two: the thumb that is held would stop there and the other slider's would move in its place.
    const handlePartitaMinChange = (next: number) => {
        const clampedNext = clampPartitaStagger(next);
        onPartitaTuningChange?.({
            staggerMin: clampedNext,
            staggerMax: Math.max(clampedNext, resolvedPartitaTuning.staggerMax),
        });
    };
    const handlePartitaMaxChange = (next: number) => {
        const clampedNext = clampPartitaStagger(next);
        onPartitaTuningChange?.({
            staggerMin: Math.min(resolvedPartitaTuning.staggerMin, clampedNext),
            staggerMax: clampedNext,
        });
    };
    const drag = { onDragStart: onSliderPointerDown, onDragEnd: onSliderCommit };
    const pixels = (value: number) => `${value}px`;

    return (
        <Group def={PARTITA_GROUP}>
            <Row label={t('options.partitaGuideLines')}>
                <Toggle
                    checked={resolvedPartitaTuning.showGuideLines}
                    onChange={(enabled) => onPartitaTuningChange?.({ showGuideLines: enabled })}
                />
            </Row>
            <Row label={t('options.partitaSemanticLayout')}>
                <Toggle
                    checked={resolvedPartitaTuning.useSemanticLayout}
                    onChange={(enabled) => onPartitaTuningChange?.({ useSemanticLayout: enabled })}
                />
            </Row>
            <SliderRow
                {...drag}
                label={t('options.partitaStaggerMin')}
                value={resolvedPartitaTuning.staggerMin}
                min={0}
                max={180}
                step={5}
                format={pixels}
                onChange={handlePartitaMinChange}
            />
            <SliderRow
                {...drag}
                label={t('options.partitaStaggerMax')}
                value={resolvedPartitaTuning.staggerMax}
                min={0}
                max={180}
                step={5}
                format={pixels}
                onChange={handlePartitaMaxChange}
            />
        </Group>
    );
};
const resolveFumeCameraTrackingMode = (value: FumeTuning['cameraTrackingMode'] | undefined): FumeTuning['cameraTrackingMode'] => (
    value === 'stepped' || value === 'smooth'
        ? value
        : DEFAULT_FUME_TUNING.cameraTrackingMode
);

export const FumeSettingsPanel: React.FC<VisualizerSettingsPanelProps<FumeTuning>> = ({
    t,
    onSliderPointerDown,
    onSliderCommit,
    tuning: fumeTuning = DEFAULT_FUME_TUNING,
    onTuningChange: onFumeTuningChange,
}) => {
    const resolvedFumeTuning: FumeTuning = {
        hidePrintSymbols: fumeTuning.hidePrintSymbols,
        disableGeometricBackground: fumeTuning.disableGeometricBackground,
        backgroundObjectOpacity: Math.min(1, Math.max(0, fumeTuning.backgroundObjectOpacity ?? DEFAULT_FUME_TUNING.backgroundObjectOpacity)),
        textHoldRatio: Math.min(1, Math.max(0, fumeTuning.textHoldRatio ?? DEFAULT_FUME_TUNING.textHoldRatio)),
        cameraTrackingMode: resolveFumeCameraTrackingMode(fumeTuning.cameraTrackingMode),
        cameraSpeed: Math.min(1.85, Math.max(0.55, fumeTuning.cameraSpeed)),
        glowIntensity: Math.min(1.8, Math.max(0, fumeTuning.glowIntensity)),
        heroScale: Math.min(1.32, Math.max(0.82, fumeTuning.heroScale)),
    };
    const handleFumeTuningChange = (patch: Partial<FumeTuning>) => {
        onFumeTuningChange?.(patch);
    };
    const drag = { onDragStart: onSliderPointerDown, onDragEnd: onSliderCommit };

    return (
        <Group def={FUME_GROUP}>
            <Row label={t('options.fumeHidePrintSymbols')}>
                <Toggle
                    checked={resolvedFumeTuning.hidePrintSymbols}
                    onChange={(next) => handleFumeTuningChange({ hidePrintSymbols: next })}
                />
            </Row>
            {/* The switch shows the shapes; the stored value says whether they are off. */}
            <Row label={t('options.fumeGeometricBackground')}>
                <Toggle
                    checked={!resolvedFumeTuning.disableGeometricBackground}
                    onChange={(shown) => handleFumeTuningChange({ disableGeometricBackground: !shown })}
                />
            </Row>
            <SliderRow
                {...drag}
                label={t('options.fumeBackgroundObjectOpacity')}
                value={resolvedFumeTuning.backgroundObjectOpacity}
                min={0}
                max={1}
                step={0.05}
                format={percent}
                onChange={(value) => handleFumeTuningChange({ backgroundObjectOpacity: value })}
            />
            <SliderRow
                {...drag}
                label={t('options.fumeTextHoldRatio')}
                value={resolvedFumeTuning.textHoldRatio}
                min={0}
                max={1}
                step={0.05}
                format={percent}
                onChange={(value) => handleFumeTuningChange({ textHoldRatio: value })}
            />
            <SliderRow
                {...drag}
                label={t('options.fumeCameraSpeed')}
                value={resolvedFumeTuning.cameraSpeed}
                min={0.55}
                max={1.85}
                step={0.05}
                format={times}
                onChange={(value) => handleFumeTuningChange({ cameraSpeed: value })}
            />
            <Row label={t('options.fumeCameraTrackingMode')}>
                <Segmented
                    value={resolvedFumeTuning.cameraTrackingMode}
                    options={[
                        { value: 'stepped', label: t('options.fumeCameraTrackingStepped') },
                        { value: 'smooth', label: t('options.fumeCameraTrackingSmooth') },
                    ]}
                    onChange={(next) => handleFumeTuningChange({ cameraTrackingMode: next })}
                />
            </Row>
            <SliderRow
                {...drag}
                label={t('options.fumeGlowIntensity')}
                value={resolvedFumeTuning.glowIntensity}
                min={0}
                max={1.8}
                step={0.05}
                format={times}
                onChange={(value) => handleFumeTuningChange({ glowIntensity: value })}
            />
            <SliderRow
                {...drag}
                label={t('options.fumeHeroScale')}
                value={resolvedFumeTuning.heroScale}
                min={0.82}
                max={1.32}
                step={0.02}
                format={times}
                onChange={(value) => handleFumeTuningChange({ heroScale: value })}
            />
        </Group>
    );
};
const TILT_COLOR_SCHEMES: TiltColorScheme[] = ['default', 'swap', 'accentAll', 'primaryAll'];
const TILT_COLOR_SCHEME_LABEL_KEYS: Record<TiltColorScheme, string> = {
    default: 'options.tiltColorSchemeDefault',
    swap: 'options.tiltColorSchemeSwap',
    accentAll: 'options.tiltColorSchemeAccentAll',
    primaryAll: 'options.tiltColorSchemePrimaryAll',
};

export const TiltSettingsPanel: React.FC<VisualizerSettingsPanelProps<TiltTuning>> = ({
    t,
    theme,
    onSliderPointerDown,
    onSliderCommit,
    tuning: tiltTuning = DEFAULT_TILT_TUNING,
    onTuningChange: onTiltTuningChange,
}) => {
    const resolvedTuning: Required<TiltTuning> = {
        splitProbability: Math.min(1, Math.max(0, tiltTuning.splitProbability ?? DEFAULT_TILT_TUNING.splitProbability)),
        tiltStyleProbability: Math.min(1, Math.max(0, tiltTuning.tiltStyleProbability ?? DEFAULT_TILT_TUNING.tiltStyleProbability)),
        colorScheme: tiltTuning?.colorScheme ?? DEFAULT_TILT_TUNING.colorScheme ?? 'default',
    };

    const handleTiltTuningChange = (patch: Partial<TiltTuning>) => {
        onTiltTuningChange?.(patch);
    };
    const drag = { onDragStart: onSliderPointerDown, onDragEnd: onSliderCommit };

    // A scheme as the renderer colours it: an upright word and a slanted one, on the theme's background.
    const { primaryColor, accentColor, backgroundColor } = theme;
    const schemePicture = useCallback((scheme: TiltColorScheme) => {
        const accent = accentColor || primaryColor;
        const upright = scheme === 'swap' || scheme === 'accentAll' ? accent : primaryColor;
        const slanted = scheme === 'default' || scheme === 'accentAll' ? accent : primaryColor;
        return (
            <span className="absolute inset-0 flex items-center justify-center gap-1.5" style={{ backgroundColor }}>
                <span className="h-2 w-[26%] rounded-sm" style={{ backgroundColor: upright }} />
                <span className="h-2 w-[26%] -skew-x-[24deg] rounded-sm" style={{ backgroundColor: slanted }} />
            </span>
        );
    }, [primaryColor, accentColor, backgroundColor]);

    return (
        <Group def={TILT_GROUP}>
            <Row
                label={t('options.tiltColorScheme')}
                below={(
                    <PictureGrid
                        className="-mx-4"
                        columns={4}
                        label={t('options.tiltColorScheme')}
                        value={resolvedTuning.colorScheme}
                        options={TILT_COLOR_SCHEMES.map(value => ({ value, label: t(TILT_COLOR_SCHEME_LABEL_KEYS[value]) }))}
                        picture={schemePicture}
                        onChange={(next) => handleTiltTuningChange({ colorScheme: next })}
                    />
                )}
            />
            <SliderRow
                {...drag}
                label={t('options.tiltSplitProbability')}
                value={resolvedTuning.splitProbability}
                min={0}
                max={1}
                step={0.05}
                format={percent}
                onChange={(value) => handleTiltTuningChange({ splitProbability: value })}
            />
            <SliderRow
                {...drag}
                label={t('options.tiltStyleProbability')}
                value={resolvedTuning.tiltStyleProbability}
                min={0}
                max={1}
                step={0.05}
                format={percent}
                onChange={(value) => handleTiltTuningChange({ tiltStyleProbability: value })}
            />
        </Group>
    );
};

export { CappellaSettingsPanel } from './cappella/CappellaSettingsPanel';
export { CladdaghSettingsPanel } from './claddagh/CladdaghSettingsPanel';
export { DioramaSettingsPanel } from './diorama/DioramaSettingsPanel';
