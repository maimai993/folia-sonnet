import React, { useMemo } from 'react';
import { Monitor } from 'lucide-react';
import {
    type CappellaEmojiImage,
    type CappellaTuning,
    type FumeTuning,
    type PartitaTuning,
    type Theme,
    type TiltTuning,
    type VisualizerMode,
} from '../../types';
import { colorWithAlpha } from './colorMix';
import { VISUALIZER_REGISTRY, getVisualizerModeLabel, type VisualizerRegistryEntry } from './registry';
import { type VisPlaygroundEditSection } from './VisPlaygroundPreviewHotspots';

// src/components/visualizer/VisPlaygroundSettingsPanel.tsx
// Right-side settings panel for the click-to-edit visualizer playground.
interface PresetOption<T> {
    label: string;
    value: T;
}

interface PresetGroupProps<T> {
    label: string;
    value: T;
    options: PresetOption<T>[];
    onChange: (next: T) => void;
    isDaylight: boolean;
    theme: Theme;
    isOptionActive?: (option: PresetOption<T>) => boolean;
}

interface ToggleRowProps {
    label: string;
    description?: string;
    checked: boolean;
    onChange?: (checked: boolean) => void;
    theme: Theme;
}

interface VisPlaygroundSettingsPanelProps {
    activeSection: VisPlaygroundEditSection;
    onSectionChange: (section: VisPlaygroundEditSection) => void;
    t: (key: string) => string;
    isDaylight: boolean;
    theme: Theme;
    visualizerMode: VisualizerMode;
    visualizerEntry: VisualizerRegistryEntry;
    onVisualizerModeChange?: (mode: VisualizerMode) => void;
    controlCardBg: string;
    rangeInputClass: string;
    backgroundOpacity: number;
    onBackgroundOpacityChange?: (opacity: number) => void;
    useCoverColorBg: boolean;
    onToggleCoverColorBg?: (enabled: boolean) => void;
    disableVisualizerVignette: boolean;
    onToggleDisableVisualizerVignette?: (disabled: boolean) => void;
    disableVisualizerGeometricBackground: boolean;
    onToggleDisableVisualizerGeometricBackground?: (disabled: boolean) => void;
    fontStyleValue: Theme['fontStyle'] | 'custom';
    fontStyleOptions: PresetOption<Theme['fontStyle'] | 'custom'>[];
    onFontStyleChange: (fontStyle: Theme['fontStyle'] | 'custom') => void;
    fontScale: number;
    fontScaleOptions: PresetOption<number>[];
    onFontScaleChange: (fontScale: number) => void;
    partitaTuning: PartitaTuning;
    onPartitaTuningChange?: (patch: Partial<PartitaTuning>) => void;
    fumeTuning: FumeTuning;
    onFumeTuningChange?: (patch: Partial<FumeTuning>) => void;
    cappellaTuning: CappellaTuning;
    cappellaCustomEmojiImages: CappellaEmojiImage[];
    onCappellaTuningChange?: (patch: Partial<CappellaTuning>) => void;
    isLoadingCappellaCustomEmojiPack: boolean;
    onImportCappellaCustomEmojiPack?: (files: File[]) => Promise<{ ok: boolean; error?: string; }>;
    onClearCappellaCustomEmojiPack?: () => Promise<void> | void;
    tiltTuning: TiltTuning;
    onTiltTuningChange?: (patch: Partial<TiltTuning>) => void;
    hideTranslationSubtitle: boolean;
    onToggleHideTranslationSubtitle?: (hidden: boolean) => void;
    subtitleOverlayOpacity: number;
    onSubtitleOverlayOpacityChange?: (opacity: number) => void;
}

const SECTION_OPTIONS: VisPlaygroundEditSection[] = ['background', 'visualizer', 'subtitle'];

const getSectionLabel = (section: VisPlaygroundEditSection, t: (key: string) => string) => {
    if (section === 'background') return t('options.previewBackgroundSettings') || '背景';
    if (section === 'subtitle') return t('options.previewSubtitleSettings') || '字幕';
    return 'Visualizer';
};

const getAccentOptionStyle = (selected: boolean, theme: Theme, isDaylight: boolean): React.CSSProperties => (
    selected
        ? {
            borderColor: theme.accentColor,
            boxShadow: `inset 0 0 0 1px ${theme.accentColor}`,
            backgroundColor: colorWithAlpha(theme.accentColor, isDaylight ? 0.1 : 0.16),
        }
        : {
            borderColor: colorWithAlpha(theme.secondaryColor, isDaylight ? 0.18 : 0.16),
            backgroundColor: colorWithAlpha(theme.backgroundColor, isDaylight ? 0.24 : 0.34),
        }
);

const PresetGroup = <T,>({
    label,
    value,
    options,
    onChange,
    isDaylight,
    theme,
    isOptionActive,
}: PresetGroupProps<T>) => (
    <div className="space-y-2.5">
        <div className="text-xs font-medium uppercase tracking-[0.24em] opacity-60" style={{ color: theme.secondaryColor }}>
            {label}
        </div>
        <div className="flex flex-wrap gap-2">
            {options.map(option => {
                const isActive = isOptionActive ? isOptionActive(option) : option.value === value;

                return (
                    <button
                        key={String(option.value)}
                        type="button"
                        onClick={() => onChange(option.value)}
                        className="px-3 py-2 rounded-full text-sm transition-all border"
                        style={{
                            ...getAccentOptionStyle(isActive, theme, isDaylight),
                            color: theme.primaryColor,
                        }}
                    >
                        {option.label}
                    </button>
                );
            })}
        </div>
    </div>
);

const ToggleRow: React.FC<ToggleRowProps> = ({
    label,
    description,
    checked,
    onChange,
    theme,
}) => (
    <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
            <div className="text-sm font-medium flex items-center gap-2" style={{ color: theme.primaryColor }}>
                <Monitor size={14} />
                {label}
            </div>
            {description && (
                <div className="text-xs opacity-70 max-w-[320px]" style={{ color: theme.secondaryColor }}>
                    {description}
                </div>
            )}
        </div>
        <button
            type="button"
            aria-pressed={checked}
            onClick={() => onChange?.(!checked)}
            className="w-12 h-6 rounded-full p-1 transition-colors shrink-0 disabled:opacity-45"
            disabled={!onChange}
            style={{
                backgroundColor: checked ? theme.secondaryColor : colorWithAlpha(theme.secondaryColor, 0.18),
            }}
        >
            <div
                className={`w-4 h-4 rounded-full shadow-sm transition-transform ${checked ? 'translate-x-6' : 'translate-x-0'}`}
                style={{ backgroundColor: theme.backgroundColor }}
            />
        </button>
    </div>
);

const SectionTabs: React.FC<Pick<VisPlaygroundSettingsPanelProps, 'activeSection' | 'onSectionChange' | 't' | 'theme' | 'isDaylight'>> = ({
    activeSection,
    onSectionChange,
    t,
    theme,
    isDaylight,
}) => (
    <div className="inline-flex w-fit items-center gap-1 rounded-full p-1" style={{ backgroundColor: colorWithAlpha(theme.backgroundColor, isDaylight ? 0.34 : 0.52) }}>
        {SECTION_OPTIONS.map(section => {
            const active = activeSection === section;
            return (
                <button
                    key={section}
                    type="button"
                    onClick={() => onSectionChange(section)}
                    className="rounded-full border px-3 py-1.5 text-sm transition-all"
                    style={{
                        ...getAccentOptionStyle(active, theme, isDaylight),
                        color: active ? theme.primaryColor : theme.secondaryColor,
                    }}
                >
                    {getSectionLabel(section, t)}
                </button>
            );
        })}
    </div>
);

const VisPlaygroundSettingsPanel: React.FC<VisPlaygroundSettingsPanelProps> = (props) => {
    const {
        activeSection,
        onSectionChange,
        t,
        isDaylight,
        theme,
        visualizerMode,
        visualizerEntry,
        onVisualizerModeChange,
        controlCardBg,
        rangeInputClass,
        backgroundOpacity,
        onBackgroundOpacityChange,
        useCoverColorBg,
        onToggleCoverColorBg,
        disableVisualizerVignette,
        onToggleDisableVisualizerVignette,
        disableVisualizerGeometricBackground,
        onToggleDisableVisualizerGeometricBackground,
        fontStyleValue,
        fontStyleOptions,
        onFontStyleChange,
        fontScale,
        fontScaleOptions,
        onFontScaleChange,
        partitaTuning,
        onPartitaTuningChange,
        fumeTuning,
        onFumeTuningChange,
        cappellaTuning,
        cappellaCustomEmojiImages,
        onCappellaTuningChange,
        isLoadingCappellaCustomEmojiPack,
        onImportCappellaCustomEmojiPack,
        onClearCappellaCustomEmojiPack,
        tiltTuning,
        onTiltTuningChange,
        hideTranslationSubtitle,
        onToggleHideTranslationSubtitle,
        subtitleOverlayOpacity,
        onSubtitleOverlayOpacityChange,
    } = props;

    const modeOptions = useMemo(() => (
        VISUALIZER_REGISTRY.map(entry => ({
            label: getVisualizerModeLabel(entry.mode, t),
            value: entry.mode,
        }))
    ), [t]);

    return (
        <div className="min-h-0 flex flex-col gap-4">
            <SectionTabs
                activeSection={activeSection}
                onSectionChange={onSectionChange}
                t={t}
                theme={theme}
                isDaylight={isDaylight}
            />

            <div className="flex-1 overflow-y-auto pr-1 custom-scrollbar space-y-4">
                {activeSection === 'background' && (
                    <div className="rounded-[24px] border p-4 space-y-4" style={{ backgroundColor: controlCardBg, borderColor: colorWithAlpha(theme.secondaryColor, 0.16) }}>
                        <div className="space-y-1">
                            <div className="text-sm font-medium" style={{ color: theme.primaryColor }}>
                                {t('options.previewBackgroundSettings') || '背景设置'}
                            </div>
                            <div className="text-xs opacity-70" style={{ color: theme.secondaryColor }}>
                                {t('options.previewBackgroundSettingsDesc') || '调整播放页背景层、透明窗口和几何氛围。'}
                            </div>
                        </div>

                        <div className="space-y-2">
                            <div className="flex items-center justify-between text-sm" style={{ color: theme.primaryColor }}>
                                <span>{t('options.backgroundOpacity') || '背景透明度'}</span>
                                <span className="font-mono opacity-70" style={{ color: theme.secondaryColor }}>
                                    {Math.round(backgroundOpacity * 100)}%
                                </span>
                            </div>
                            <input
                                type="range"
                                min="0"
                                max="1"
                                step="0.05"
                                value={backgroundOpacity}
                                onChange={(event) => onBackgroundOpacityChange?.(parseFloat(event.target.value))}
                                className={rangeInputClass}
                            />
                        </div>

                        <ToggleRow
                            label={t('options.addCoverColor') || '添加封面色彩'}
                            description={t('options.coverColorBackgroundDesc') || '使用当前歌曲封面生成背景色彩。'}
                            checked={useCoverColorBg}
                            onChange={onToggleCoverColorBg}
                            theme={theme}
                        />
                        <ToggleRow
                            label={t('options.disableVisualizerVignette') || '禁用暗角'}
                            description={t('options.disableVisualizerVignetteDesc') || '关闭几何背景自带的边缘暗角。'}
                            checked={disableVisualizerVignette}
                            onChange={onToggleDisableVisualizerVignette}
                            theme={theme}
                        />
                        <ToggleRow
                            label={t('options.disableVisualizerGeometricBackground') || '隐藏通用几何背景'}
                            description={t('options.disableVisualizerGeometricBackgroundDesc') || '隐藏播放页的通用几何背景图形。'}
                            checked={disableVisualizerGeometricBackground}
                            onChange={onToggleDisableVisualizerGeometricBackground}
                            theme={theme}
                        />
                    </div>
                )}

                {activeSection === 'visualizer' && (
                    <>
                        <div className="rounded-[24px] border p-4 space-y-4" style={{ backgroundColor: controlCardBg, borderColor: colorWithAlpha(theme.secondaryColor, 0.16) }}>
                            <div className="space-y-1">
                                <div className="text-sm font-medium" style={{ color: theme.primaryColor }}>
                                    {t('options.lyricsRenderer') || 'Lyrics Renderer'}
                                </div>
                                <div className="text-xs opacity-70" style={{ color: theme.secondaryColor }}>
                                    {t('options.lyricsRendererDesc') || '选择播放页使用的歌词渲染模式。'}
                                </div>
                            </div>

                            <PresetGroup
                                label={t('options.visualizerMode') || '模式'}
                                value={visualizerMode}
                                options={modeOptions}
                                onChange={(mode) => onVisualizerModeChange?.(mode)}
                                isDaylight={isDaylight}
                                theme={theme}
                            />
                        </div>

                        <div className="rounded-[24px] border p-4 space-y-4" style={{ backgroundColor: controlCardBg, borderColor: colorWithAlpha(theme.secondaryColor, 0.16) }}>
                            <div className="space-y-1">
                                <div className="text-sm font-medium" style={{ color: theme.primaryColor }}>
                                    {t('options.lyricsStyleSettings') || '歌词样式'}
                                </div>
                                <div className="text-xs opacity-70" style={{ color: theme.secondaryColor }}>
                                    {t('options.lyricsStyleSettingsDesc') || '字体、字号和当前渲染器附加参数'}
                                </div>
                            </div>

                            <PresetGroup
                                label={t('options.fontFamily') || '字体'}
                                value={fontStyleValue}
                                options={fontStyleOptions}
                                onChange={onFontStyleChange}
                                isDaylight={isDaylight}
                                theme={theme}
                                isOptionActive={(option) => option.value === fontStyleValue}
                            />

                            <PresetGroup
                                label={t('options.fontSize') || '字号'}
                                value={fontScale}
                                options={fontScaleOptions}
                                onChange={onFontScaleChange}
                                isDaylight={isDaylight}
                                theme={theme}
                            />

                            <div className="space-y-2">
                                <div className="flex items-center justify-between text-sm" style={{ color: theme.primaryColor }}>
                                    <span>{t('options.fontSize') || '字号'}</span>
                                    <span className="font-mono opacity-70" style={{ color: theme.secondaryColor }}>
                                        {Math.round(fontScale * 100)}%
                                    </span>
                                </div>
                                <input
                                    type="range"
                                    min="0.85"
                                    max="1.4"
                                    step="0.05"
                                    value={fontScale}
                                    onChange={(event) => onFontScaleChange(parseFloat(event.target.value))}
                                    className={rangeInputClass}
                                />
                            </div>
                        </div>

                        {visualizerEntry.renderSettingsPanel?.({
                            t,
                            isDaylight,
                            theme,
                            controlCardBg,
                            rangeInputClass,
                            partitaTuning,
                            onPartitaTuningChange,
                            fumeTuning,
                            onFumeTuningChange,
                            cappellaTuning,
                            cappellaCustomEmojiImages,
                            onCappellaTuningChange,
                            cappellaCustomEmojiCount: cappellaCustomEmojiImages.length,
                            hasCappellaCustomEmojiPack: cappellaCustomEmojiImages.length > 0,
                            isCappellaCustomEmojiPackLoading: isLoadingCappellaCustomEmojiPack,
                            onImportCappellaCustomEmojiPack,
                            onClearCappellaCustomEmojiPack,
                            tiltTuning,
                            onTiltTuningChange,
                        })}
                    </>
                )}

                {activeSection === 'subtitle' && (
                    <div className="rounded-[24px] border p-4 space-y-4" style={{ backgroundColor: controlCardBg, borderColor: colorWithAlpha(theme.secondaryColor, 0.16) }}>
                        <div className="space-y-1">
                            <div className="text-sm font-medium" style={{ color: theme.primaryColor }}>
                                {t('options.previewSubtitleSettings') || '字幕设置'}
                            </div>
                            <div className="text-xs opacity-70" style={{ color: theme.secondaryColor }}>
                                {t('options.previewSubtitleSettingsDesc') || '调整底部译文和下一句提示的显示方式。'}
                            </div>
                        </div>

                        <ToggleRow
                            label={t('options.hidePlayerTranslationSubtitle') || '隐藏底部字幕'}
                            checked={hideTranslationSubtitle}
                            onChange={onToggleHideTranslationSubtitle}
                            theme={theme}
                        />

                        <div className="space-y-2">
                            <div className="flex items-center justify-between text-sm" style={{ color: theme.primaryColor }}>
                                <span>{t('options.subtitleOverlayOpacity') || '字幕透明度'}</span>
                                <span className="font-mono opacity-70" style={{ color: theme.secondaryColor }}>
                                    {Math.round(subtitleOverlayOpacity * 100)}%
                                </span>
                            </div>
                            <input
                                type="range"
                                min="0.2"
                                max="1"
                                step="0.05"
                                value={subtitleOverlayOpacity}
                                onChange={(event) => onSubtitleOverlayOpacityChange?.(parseFloat(event.target.value))}
                                className={rangeInputClass}
                            />
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default VisPlaygroundSettingsPanel;
