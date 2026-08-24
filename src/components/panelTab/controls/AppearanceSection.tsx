import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Theme, ThemeMode, VisualizerBackgroundMode, VisualizerMode } from '../../../types';
import type { ThemeSourceModel } from '../../../hooks/themeControllerState';
import { getVisualizerModeLabel, VISUALIZER_REGISTRY } from '../../visualizer/registry';
import {
    getVisualizerBackgroundModeLabel,
    getVisualizerBackgroundRegistryEntry,
    VISUALIZER_BACKGROUND_REGISTRY,
} from '../../visualizer/backgrounds/registry';
import { resolveVisualizerBackgroundMode, useSettingsUiStore } from '../../../stores/useSettingsUiStore';
import { useVisualizerModeStepper } from '../../../hooks/useVisualizerModeStepper';
import { QuickControlChip } from '../../shared/QuickControlChip';
import ModeStepperRow from './ModeStepperRow';
import ThemeSourceRow from './ThemeSourceRow';
import { BackgroundModeGlyph, VisualizerModeGlyph } from '../../visualizer/modeGlyphs';

// src/components/panelTab/controls/AppearanceSection.tsx
// 外观区：歌词样式、背景、主题来源三件事放在一起。
// 前两行是「‹ 字形 当前模式 参数 ›」取景器；背景的模式专属参数由背景注册表自己提供，
// 面板不再按模式写 if 链，新增背景模式会自带快捷控件。

interface AppearanceSectionProps {
    theme: Theme;
    onThemeChange: (theme: Theme) => void;
    isDaylight: boolean;
    visualizerMode: VisualizerMode;
    onVisualizerModeChange: (mode: VisualizerMode) => void;
    useCoverColorBg: boolean;
    onToggleCoverColorBg: (enable: boolean) => void;
    themeSourceModel: ThemeSourceModel;
    onBgModeChange: (mode: ThemeMode) => void;
    hasCustomTheme: boolean;
    defaultTheme: Theme;
    daylightTheme: Theme;
    onClosePanel?: () => void;
}

const ANIMATION_INTENSITIES: Theme['animationIntensity'][] = ['calm', 'normal', 'chaotic'];

const AppearanceSection: React.FC<AppearanceSectionProps> = ({
    theme,
    onThemeChange,
    isDaylight,
    visualizerMode,
    onVisualizerModeChange,
    useCoverColorBg,
    onToggleCoverColorBg,
    themeSourceModel,
    onBgModeChange,
    hasCustomTheme,
    defaultTheme,
    daylightTheme,
    onClosePanel,
}) => {
    const { t } = useTranslation();
    const openSettings = useSettingsUiStore(state => state.openSettings);
    const visualizerBackgroundMode = useSettingsUiStore(state => state.visualizerBackgroundMode);
    const setVisualizerBackgroundMode = useSettingsUiStore(state => state.handleSetVisualizerBackgroundMode);
    const monetBackgroundTuning = useSettingsUiStore(state => state.monetBackgroundTuning);
    const setMonetBackgroundTuning = useSettingsUiStore(state => state.handleSetMonetBackgroundTuning);
    const nomandBackgroundTuning = useSettingsUiStore(state => state.nomandBackgroundTuning);
    const setNomandBackgroundTuning = useSettingsUiStore(state => state.handleSetNomandBackgroundTuning);
    const latentBackgroundTuning = useSettingsUiStore(state => state.latentBackgroundTuning);
    const setLatentBackgroundTuning = useSettingsUiStore(state => state.handleSetLatentBackgroundTuning);

    const visualizerOptions = useMemo(
        () => VISUALIZER_REGISTRY.map(entry => ({
            value: entry.mode,
            label: getVisualizerModeLabel(entry.mode, t),
        })),
        [t],
    );
    const visualizerModes = useMemo(() => visualizerOptions.map(option => option.value), [visualizerOptions]);
    const stepVisualizerMode = useVisualizerModeStepper(visualizerModes);

    const backgroundOptions = useMemo(
        () => VISUALIZER_BACKGROUND_REGISTRY.map(entry => ({
            value: entry.mode,
            label: getVisualizerBackgroundModeLabel(entry.mode, t),
        })),
        [t],
    );
    const resolvedBackgroundMode = resolveVisualizerBackgroundMode(visualizerBackgroundMode, visualizerMode);

    const stepBackgroundMode = (direction: -1 | 1) => {
        if (backgroundOptions.length < 2) {
            return;
        }

        const index = backgroundOptions.findIndex(option => option.value === resolvedBackgroundMode);
        const nextIndex = ((index < 0 ? 0 : index) + direction + backgroundOptions.length) % backgroundOptions.length;
        setVisualizerBackgroundMode(backgroundOptions[nextIndex].value);
    };

    const openVisualizerSettings = () => {
        openSettings('options', 'visualizer', 'visualizer');
        onClosePanel?.();
    };

    const openBackgroundSettings = () => {
        openSettings('options', 'visualizer', 'background');
        onClosePanel?.();
    };

    const cycleAnimationIntensity = () => {
        const currentIndex = ANIMATION_INTENSITIES.indexOf(theme.animationIntensity);
        onThemeChange({
            ...theme,
            animationIntensity: ANIMATION_INTENSITIES[(currentIndex + 1) % ANIMATION_INTENSITIES.length],
        });
    };

    const backgroundQuickControls = getVisualizerBackgroundRegistryEntry(resolvedBackgroundMode).renderQuickControls?.({
        config: {
            common: { useCoverColorBg },
            monet: { tuning: monetBackgroundTuning },
            nomand: { tuning: nomandBackgroundTuning },
            latent: { tuning: latentBackgroundTuning },
        },
        actions: {
            common: { onCoverColorChange: onToggleCoverColorBg },
            monet: { onTuningChange: setMonetBackgroundTuning },
            nomand: { onTuningChange: setNomandBackgroundTuning },
            latent: { onTuningChange: setLatentBackgroundTuning },
        },
        t,
        isDaylight,
        theme,
    });

    return (
        <div className="space-y-1">
            <ModeStepperRow<VisualizerMode>
                value={visualizerMode}
                options={visualizerOptions}
                onSelect={onVisualizerModeChange}
                onStep={stepVisualizerMode}
                renderGlyph={mode => <VisualizerModeGlyph mode={mode} />}
                ariaLabel={t('ui.animationMode')}
                moreLabel={t('ui.moreSettings')}
                onOpenMore={openVisualizerSettings}
                isDaylight={isDaylight}
                primaryColor={theme.primaryColor}
                trailing={(
                    <QuickControlChip
                        isDaylight={isDaylight}
                        label={t(`animation.${theme.animationIntensity}`)}
                        title={`${t('ui.animationIntensity')}: ${t(`animation.${theme.animationIntensity}`)}`}
                        onClick={cycleAnimationIntensity}
                    />
                )}
            />

            <ModeStepperRow<VisualizerBackgroundMode>
                value={resolvedBackgroundMode}
                options={backgroundOptions}
                onSelect={setVisualizerBackgroundMode}
                onStep={stepBackgroundMode}
                renderGlyph={mode => <BackgroundModeGlyph mode={mode} />}
                ariaLabel={t('options.visualizerBackgroundMode')}
                moreLabel={t('ui.moreSettings')}
                onOpenMore={openBackgroundSettings}
                isDaylight={isDaylight}
                primaryColor={theme.primaryColor}
                trailing={backgroundQuickControls}
            />

            <div className="pt-1">
                <ThemeSourceRow
                    themeSourceModel={themeSourceModel}
                    onBgModeChange={onBgModeChange}
                    hasCustomTheme={hasCustomTheme}
                    defaultTheme={defaultTheme}
                    daylightTheme={daylightTheme}
                    isDaylight={isDaylight}
                />
            </div>
        </div>
    );
};

export default AppearanceSection;
