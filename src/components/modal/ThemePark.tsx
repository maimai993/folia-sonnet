import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronLeft, Palette, RotateCcw, Sparkles, Sun, Moon, Check } from 'lucide-react';
import { HexColorPicker } from 'react-colorful';
import { useTranslation } from 'react-i18next';
import { DualTheme, Theme } from '../../types';

interface ThemeParkProps {
    initialTheme: DualTheme;
    isDaylight: boolean;
    isCustomThemePreferred: boolean;
    onClose: () => void;
    onSaveTheme: (dualTheme: DualTheme) => void;
    onPreferTheme: (dualTheme: DualTheme) => void;
}

type EditableColorKey = 'backgroundColor' | 'primaryColor' | 'accentColor' | 'secondaryColor';
type EditableMode = 'light' | 'dark';

interface PickerState {
    mode: EditableMode;
    key: EditableColorKey;
}

const COLOR_FIELDS: Array<{ key: EditableColorKey; label: string; description: string; }> = [
    { key: 'backgroundColor', label: '背景', description: '页面主背景与大面积氛围色' },
    { key: 'primaryColor', label: '主文本', description: '主标题与主要歌词颜色' },
    { key: 'accentColor', label: '强调色', description: '高亮、按钮与动态焦点颜色' },
    { key: 'secondaryColor', label: '辅助色', description: '次级文案与辅助信息颜色' },
];

const normalizeTheme = (theme: Theme, fallbackName: string, provider: string): Theme => ({
    ...theme,
    name: fallbackName,
    provider,
    wordColors: [],
    lyricsIcons: [],
});

const normalizeDualTheme = (dualTheme: DualTheme): DualTheme => ({
    light: normalizeTheme(dualTheme.light, 'Theme Park Light', 'Custom'),
    dark: normalizeTheme(dualTheme.dark, 'Theme Park Dark', 'Custom'),
});

const ThemePreviewCard: React.FC<{
    theme: Theme;
    mode: EditableMode;
    isActive: boolean;
    onClick: () => void;
}> = ({ theme, mode, isActive, onClick }) => {
    const isLight = mode === 'light';

    return (
        <button
            type="button"
            onClick={onClick}
            className="relative min-h-[280px] overflow-hidden rounded-[28px] border p-5 text-left transition-all"
            style={{
                backgroundColor: theme.backgroundColor,
                borderColor: isActive ? theme.accentColor : (isLight ? 'rgba(24,24,27,0.08)' : 'rgba(255,255,255,0.1)'),
                boxShadow: isActive ? `0 22px 60px ${theme.accentColor}22` : '0 18px 50px rgba(0,0,0,0.14)',
            }}
        >
            <div
                className="absolute inset-0 opacity-80"
                style={{
                    background: `radial-gradient(circle at 18% 20%, ${theme.accentColor}25 0%, transparent 38%), radial-gradient(circle at 80% 24%, ${theme.secondaryColor}24 0%, transparent 42%), linear-gradient(135deg, transparent 0%, ${theme.primaryColor}12 100%)`,
                }}
            />

            <div className="relative z-10 flex h-full flex-col">
                <div className="flex items-center justify-between">
                    <div className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs uppercase tracking-[0.22em]" style={{ color: theme.primaryColor, borderColor: `${theme.primaryColor}30` }}>
                        {isLight ? <Sun size={13} /> : <Moon size={13} />}
                        <span>{isLight ? 'Light' : 'Dark'}</span>
                    </div>
                    {isActive && (
                        <div className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs" style={{ color: theme.backgroundColor, backgroundColor: theme.accentColor }}>
                            <Check size={12} />
                            <span>Editing</span>
                        </div>
                    )}
                </div>

                <div className="mt-8 space-y-3">
                    <div className="text-[11px] uppercase tracking-[0.24em] opacity-65" style={{ color: theme.secondaryColor }}>
                        Theme Park Preview
                    </div>
                    <div className="text-3xl font-semibold leading-tight" style={{ color: theme.primaryColor }}>
                        The city learns your colors.
                    </div>
                    <div className="max-w-sm text-sm leading-6 opacity-90" style={{ color: theme.secondaryColor }}>
                        亮暗双主题会一起保存。播放器切换日夜时，会自动切到对应的自定义配色。
                    </div>
                </div>

                <div className="mt-auto space-y-4">
                    <div className="flex items-center gap-2">
                        <div className="h-3 w-3 rounded-full" style={{ backgroundColor: theme.accentColor }} />
                        <div className="h-3 w-3 rounded-full" style={{ backgroundColor: theme.primaryColor }} />
                        <div className="h-3 w-3 rounded-full" style={{ backgroundColor: theme.secondaryColor }} />
                    </div>

                    <div className="rounded-2xl border px-4 py-3" style={{ borderColor: `${theme.secondaryColor}22`, backgroundColor: `${theme.primaryColor}10` }}>
                        <div className="text-sm font-medium" style={{ color: theme.primaryColor }}>
                            Folia Major
                        </div>
                        <div className="mt-1 text-xs" style={{ color: theme.secondaryColor }}>
                            Accent and lyric highlights will follow this palette.
                        </div>
                    </div>
                </div>
            </div>
        </button>
    );
};

const ThemePark: React.FC<ThemeParkProps> = ({
    initialTheme,
    isDaylight,
    isCustomThemePreferred,
    onClose,
    onSaveTheme,
    onPreferTheme,
}) => {
    const { t } = useTranslation();
    const [draftTheme, setDraftTheme] = useState<DualTheme>(() => normalizeDualTheme(initialTheme));
    const [pickerState, setPickerState] = useState<PickerState>({
        mode: isDaylight ? 'light' : 'dark',
        key: 'accentColor',
    });

    useEffect(() => {
        setPickerState(previous => ({
            ...previous,
            mode: isDaylight ? 'light' : previous.mode,
        }));
    }, [isDaylight]);

    const glassBg = isDaylight ? 'bg-white/70' : 'bg-zinc-950/88';
    const borderColor = isDaylight ? 'border-black/5' : 'border-white/10';
    const controlCardBg = isDaylight ? 'rgba(255,255,255,0.56)' : 'rgba(255,255,255,0.04)';
    const activeTheme = draftTheme[pickerState.mode];
    const activeColor = activeTheme[pickerState.key];
    const pickerField = COLOR_FIELDS.find(field => field.key === pickerState.key) ?? COLOR_FIELDS[0];

    const updateColor = (mode: EditableMode, key: EditableColorKey, value: string) => {
        setDraftTheme(previous => ({
            ...previous,
            [mode]: {
                ...previous[mode],
                [key]: value,
            },
        }));
    };

    const handleReset = () => {
        setDraftTheme(normalizeDualTheme(initialTheme));
    };

    const handleSave = () => {
        onSaveTheme(normalizeDualTheme(draftTheme));
    };

    const handlePrefer = () => {
        onPreferTheme(normalizeDualTheme(draftTheme));
    };

    return (
        <div className="fixed inset-0 z-[135] bg-black/65 backdrop-blur-xl px-3 pt-3 pb-[calc(6rem+env(safe-area-inset-bottom))] sm:p-5" onClick={onClose}>
            <motion.div
                initial={{ opacity: 0, y: 18, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 18, scale: 0.98 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                onClick={(event) => event.stopPropagation()}
                className={`mx-auto flex h-full max-w-7xl flex-col overflow-hidden rounded-[32px] border ${borderColor} ${glassBg} shadow-[0_24px_80px_rgba(0,0,0,0.28)]`}
            >
                <div className="flex items-center justify-between border-b border-white/10 px-4 py-4 sm:px-6">
                    <div className="flex min-w-0 items-center gap-3">
                        <button
                            type="button"
                            onClick={onClose}
                            className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 transition-colors hover:bg-white/10"
                            style={{ color: 'var(--text-primary)' }}
                        >
                            <ChevronLeft size={18} />
                        </button>
                        <div className="min-w-0">
                            <div className="truncate text-lg font-semibold sm:text-xl" style={{ color: 'var(--text-primary)' }}>
                                Theme Park
                            </div>
                            <div className="mt-1 text-xs opacity-55" style={{ color: 'var(--text-secondary)' }}>
                                {t('options.themeParkDesc') || '手动创建一套只包含颜色的 dual themes，亮暗模式分别预览。'}
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={handleReset}
                            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm transition-colors hover:bg-white/10"
                            style={{ color: 'var(--text-primary)' }}
                        >
                            <RotateCcw size={14} />
                            <span>{t('ui.resetToDefaultTheme') || '重置'}</span>
                        </button>
                        <button
                            type="button"
                            onClick={handleSave}
                            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm transition-colors hover:bg-white/10"
                            style={{ color: 'var(--text-primary)' }}
                        >
                            <Palette size={14} />
                            <span>{t('options.saveCustomTheme') || '保存自定义主题'}</span>
                        </button>
                        <button
                            type="button"
                            onClick={handlePrefer}
                            className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors"
                            style={{ color: draftTheme[isDaylight ? 'light' : 'dark'].backgroundColor, backgroundColor: draftTheme[isDaylight ? 'light' : 'dark'].accentColor }}
                        >
                            <Sparkles size={14} />
                            <span>{isCustomThemePreferred ? (t('options.updatePreferredCustomTheme') || '更新首选自定义主题') : (t('options.preferCustomTheme') || '优先使用自定义主题')}</span>
                        </button>
                    </div>
                </div>

                <div className="grid min-h-0 flex-1 gap-4 p-4 sm:p-6 lg:grid-cols-[minmax(0,1.2fr)_380px]">
                    <div className="grid min-h-0 gap-4 lg:grid-cols-2">
                        <ThemePreviewCard
                            theme={draftTheme.light}
                            mode="light"
                            isActive={pickerState.mode === 'light'}
                            onClick={() => setPickerState(previous => ({ ...previous, mode: 'light' }))}
                        />
                        <ThemePreviewCard
                            theme={draftTheme.dark}
                            mode="dark"
                            isActive={pickerState.mode === 'dark'}
                            onClick={() => setPickerState(previous => ({ ...previous, mode: 'dark' }))}
                        />
                    </div>

                    <div className="min-h-0 overflow-y-auto pr-1 custom-scrollbar">
                        <div
                            className="space-y-4 rounded-[24px] border border-white/10 p-4"
                            style={{ backgroundColor: controlCardBg }}
                        >
                            <div className="space-y-1">
                                <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                                    {pickerState.mode === 'light' ? (t('options.lightTheme') || '亮色主题') : (t('options.darkTheme') || '暗色主题')}
                                </div>
                                <div className="text-xs opacity-50" style={{ color: 'var(--text-secondary)' }}>
                                    {t('options.themeParkPickerDesc') || '只编辑颜色字段，不包含图标和情绪文字。'}
                                </div>
                            </div>

                            <div className="flex items-center gap-2 rounded-full bg-white/5 p-1">
                                <button
                                    type="button"
                                    onClick={() => setPickerState(previous => ({ ...previous, mode: 'light' }))}
                                    className="flex-1 rounded-full px-3 py-2 text-sm transition-colors"
                                    style={{
                                        color: 'var(--text-primary)',
                                        backgroundColor: pickerState.mode === 'light' ? (isDaylight ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.12)') : 'transparent',
                                    }}
                                >
                                    {t('options.lightTheme') || '亮色'}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setPickerState(previous => ({ ...previous, mode: 'dark' }))}
                                    className="flex-1 rounded-full px-3 py-2 text-sm transition-colors"
                                    style={{
                                        color: 'var(--text-primary)',
                                        backgroundColor: pickerState.mode === 'dark' ? (isDaylight ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.12)') : 'transparent',
                                    }}
                                >
                                    {t('options.darkTheme') || '暗色'}
                                </button>
                            </div>

                            <div className="space-y-3">
                                {COLOR_FIELDS.map(field => {
                                    const colorValue = draftTheme[pickerState.mode][field.key];
                                    const isActive = pickerState.key === field.key;

                                    return (
                                        <button
                                            key={`${pickerState.mode}-${field.key}`}
                                            type="button"
                                            onClick={() => setPickerState(previous => ({ ...previous, key: field.key }))}
                                            className="flex w-full items-center gap-3 rounded-2xl border p-3 text-left transition-all"
                                            style={{
                                                borderColor: isActive ? activeTheme.accentColor : (isDaylight ? 'rgba(24,24,27,0.08)' : 'rgba(255,255,255,0.08)'),
                                                backgroundColor: isActive ? (isDaylight ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.07)') : 'transparent',
                                            }}
                                        >
                                            <div className="h-10 w-10 rounded-xl border border-black/10" style={{ backgroundColor: colorValue }} />
                                            <div className="min-w-0 flex-1">
                                                <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                                                    {field.label}
                                                </div>
                                                <div className="mt-0.5 text-xs opacity-55" style={{ color: 'var(--text-secondary)' }}>
                                                    {field.description}
                                                </div>
                                            </div>
                                            <div className="text-xs font-mono opacity-70" style={{ color: 'var(--text-secondary)' }}>
                                                {colorValue.toUpperCase()}
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>

                            <div className="space-y-3 rounded-[24px] border border-white/10 p-4">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                                            {pickerField.label}
                                        </div>
                                        <div className="mt-1 text-xs opacity-50" style={{ color: 'var(--text-secondary)' }}>
                                            {pickerField.description}
                                        </div>
                                    </div>
                                    <div className="rounded-full px-3 py-1 text-xs font-mono" style={{ color: activeTheme.backgroundColor, backgroundColor: activeColor }}>
                                        {activeColor.toUpperCase()}
                                    </div>
                                </div>

                                <div className="rounded-[22px] border border-white/10 bg-black/10 p-3">
                                    <HexColorPicker
                                        color={activeColor}
                                        onChange={(value) => updateColor(pickerState.mode, pickerState.key, value)}
                                        style={{ width: '100%', height: 220 }}
                                    />
                                </div>

                                <label className="block space-y-2">
                                    <div className="text-xs font-medium uppercase tracking-[0.22em] opacity-50" style={{ color: 'var(--text-secondary)' }}>
                                        HEX
                                    </div>
                                    <input
                                        type="text"
                                        value={activeColor}
                                        onChange={(event) => updateColor(pickerState.mode, pickerState.key, event.target.value)}
                                        className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 font-mono text-sm outline-none transition-colors focus:border-white/20"
                                        style={{ color: 'var(--text-primary)' }}
                                        spellCheck={false}
                                    />
                                </label>
                            </div>
                        </div>
                    </div>
                </div>
            </motion.div>
        </div>
    );
};

export default ThemePark;
