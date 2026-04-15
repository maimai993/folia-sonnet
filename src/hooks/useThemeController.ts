import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { generateThemeFromLyrics, isMissingAiApiKeyError } from '../services/gemini';
import { saveToCache } from '../services/db';
import { DualTheme, LyricData, SongResult, Theme, ThemeMode } from '../types';
import { getCachedThemeState, getLastDualTheme } from '../services/themeCache';
import { extractColors } from '../utils/colorExtractor';
import { isPureMusicLyricText } from '../utils/lyrics/pureMusic';
import {
    buildBuiltinDualTheme,
    getBaseThemeForMode,
    resolveBgModeTheme,
} from './themeControllerState';

type StatusSetter = Dispatch<SetStateAction<{ type: 'error' | 'success' | 'info', text: string; } | null>>;

const CUSTOM_DUAL_THEME_KEY = 'custom_dual_theme';
const CUSTOM_THEME_PREFERRED_KEY = 'custom_theme_preferred';

const isValidTheme = (value: unknown): value is Theme => {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const candidate = value as Partial<Theme>;
    return typeof candidate.name === 'string'
        && typeof candidate.backgroundColor === 'string'
        && typeof candidate.primaryColor === 'string'
        && typeof candidate.accentColor === 'string'
        && typeof candidate.secondaryColor === 'string'
        && (candidate.fontStyle === 'sans' || candidate.fontStyle === 'serif' || candidate.fontStyle === 'mono')
        && (candidate.animationIntensity === 'calm' || candidate.animationIntensity === 'normal' || candidate.animationIntensity === 'chaotic');
};

const readStoredCustomTheme = (): DualTheme | null => {
    const saved = localStorage.getItem(CUSTOM_DUAL_THEME_KEY);
    if (!saved) {
        return null;
    }

    try {
        const parsed = JSON.parse(saved) as Partial<DualTheme>;
        if (!isValidTheme(parsed.light) || !isValidTheme(parsed.dark)) {
            return null;
        }

        return {
            light: parsed.light,
            dark: parsed.dark,
        };
    } catch {
        return null;
    }
};

const readStoredCustomPreferred = () => localStorage.getItem(CUSTOM_THEME_PREFERRED_KEY) === 'true';

const sanitizeCustomTheme = (theme: Theme, fallbackName: string): Theme => ({
    ...theme,
    name: theme.name?.trim() || fallbackName,
    wordColors: [],
    lyricsIcons: [],
    provider: 'Custom',
});

const sanitizeCustomDualTheme = (dualTheme: DualTheme): DualTheme => ({
    light: sanitizeCustomTheme(dualTheme.light, 'Theme Park Light'),
    dark: sanitizeCustomTheme(dualTheme.dark, 'Theme Park Dark'),
});

const getSelectedDualTheme = (dualTheme: DualTheme, isDaylight: boolean) => (
    isDaylight ? dualTheme.light : dualTheme.dark
);

export function useThemeController({
    defaultTheme,
    daylightTheme,
    isDaylight,
    setDaylightPreference,
    setStatusMsg,
    coverUrl,
    t,
}: {
    defaultTheme: Theme;
    daylightTheme: Theme;
    isDaylight: boolean;
    setDaylightPreference: (enabled: boolean) => void;
    setStatusMsg: StatusSetter;
    coverUrl?: string | null;
    t: (key: string, options?: Record<string, unknown>) => string;
}) {
    const getBaseTheme = () => getBaseThemeForMode({ defaultTheme, daylightTheme, isDaylight });
    const initialCustomTheme = useMemo(readStoredCustomTheme, []);
    const initialCustomPreferred = useMemo(readStoredCustomPreferred, []);

    const [theme, setTheme] = useState<Theme>(() => getBaseTheme());
    const [aiTheme, setAiTheme] = useState<DualTheme | null>(null);
    const [legacyTheme, setLegacyTheme] = useState<Theme | null>(null);
    const [customTheme, setCustomTheme] = useState<DualTheme | null>(initialCustomTheme);
    const [bgMode, setBgMode] = useState<ThemeMode>(() => (
        initialCustomTheme && initialCustomPreferred ? 'custom' : 'default'
    ));
    const [isGeneratingTheme, setIsGeneratingTheme] = useState(false);

    useEffect(() => {
        if (customTheme) {
            localStorage.setItem(CUSTOM_DUAL_THEME_KEY, JSON.stringify(customTheme));
        } else {
            localStorage.removeItem(CUSTOM_DUAL_THEME_KEY);
        }
    }, [customTheme]);

    useEffect(() => {
        localStorage.setItem(CUSTOM_THEME_PREFERRED_KEY, String(bgMode === 'custom' && !!customTheme));
    }, [bgMode, customTheme]);

    useEffect(() => {
        setTheme(previousTheme => {
            if (bgMode === 'custom' && customTheme) {
                return getSelectedDualTheme(customTheme, isDaylight);
            }

            if (bgMode === 'ai') {
                if (aiTheme) {
                    return getSelectedDualTheme(aiTheme, isDaylight);
                }

                if (legacyTheme) {
                    return legacyTheme;
                }
            }

            const baseTheme = getBaseTheme();
            if (legacyTheme) {
                return {
                    ...legacyTheme,
                    backgroundColor: baseTheme.backgroundColor,
                };
            }

            return resolveBgModeTheme({
                mode: bgMode === 'custom' ? 'default' : bgMode,
                aiTheme,
                isDaylight,
                defaultTheme,
                daylightTheme,
                previousTheme,
            });
        });
    }, [aiTheme, bgMode, customTheme, daylightTheme, defaultTheme, isDaylight, legacyTheme]);

    const handleToggleDaylight = (isLight: boolean) => {
        setDaylightPreference(isLight);
    };

    const handleBgModeChange = (mode: ThemeMode) => {
        if (mode === 'custom' && !customTheme) {
            return;
        }

        setBgMode(mode);
    };

    const handleResetTheme = () => {
        setAiTheme(null);
        setLegacyTheme(null);
        setBgMode('default');
    };

    const handleSetThemePreset = (preset: 'midnight' | 'daylight') => {
        setAiTheme(null);
        setLegacyTheme(null);
        setBgMode('default');
        setDaylightPreference(preset === 'daylight');
        setStatusMsg({ type: 'success', text: `默认主题: ${preset === 'daylight' ? 'Daylight' : 'Midnight'} Default` });
    };

    const applyDualTheme = (dualTheme: DualTheme) => {
        setLegacyTheme(null);
        setAiTheme(dualTheme);
        if (bgMode !== 'custom') {
            setBgMode('ai');
        }
    };

    const applyLegacyTheme = (nextLegacyTheme: Theme) => {
        setAiTheme(null);
        setLegacyTheme(nextLegacyTheme);
        if (bgMode !== 'custom') {
            setBgMode('ai');
        }
    };

    const applyThemeFallback = () => {
        setAiTheme(null);
        setLegacyTheme(null);
        if (bgMode !== 'custom') {
            setBgMode('default');
        }
    };

    const getThemeParkSeedTheme = (): DualTheme => {
        if (bgMode === 'custom' && customTheme) {
            return customTheme;
        }

        if (aiTheme) {
            return aiTheme;
        }

        const baseDualTheme: DualTheme = {
            light: {
                ...daylightTheme,
                wordColors: [],
                lyricsIcons: [],
            },
            dark: {
                ...defaultTheme,
                wordColors: [],
                lyricsIcons: [],
            },
        };

        if (legacyTheme) {
            if (isDaylight) {
                baseDualTheme.light = sanitizeCustomTheme({ ...legacyTheme }, legacyTheme.name || 'Theme Park Light');
            } else {
                baseDualTheme.dark = sanitizeCustomTheme({ ...legacyTheme }, legacyTheme.name || 'Theme Park Dark');
            }
            return baseDualTheme;
        }

        if (isDaylight) {
            baseDualTheme.light = sanitizeCustomTheme({ ...theme }, theme.name || 'Theme Park Light');
        } else {
            baseDualTheme.dark = sanitizeCustomTheme({ ...theme }, theme.name || 'Theme Park Dark');
        }

        return baseDualTheme;
    };

    const saveCustomDualTheme = (dualTheme: DualTheme) => {
        const sanitized = sanitizeCustomDualTheme(dualTheme);
        setCustomTheme(sanitized);
        setStatusMsg({
            type: 'success',
            text: `已保存自定义主题: ${getSelectedDualTheme(sanitized, isDaylight).name}`,
        });
        return sanitized;
    };

    const applyPreferredCustomTheme = (dualTheme: DualTheme) => {
        const sanitized = saveCustomDualTheme(dualTheme);
        setBgMode('custom');
        setStatusMsg({
            type: 'success',
            text: `已优先使用自定义主题: ${getSelectedDualTheme(sanitized, isDaylight).name}`,
        });
    };

    const restoreCachedThemeForSong = async (
        songId: number,
        options?: { allowLastUsedFallback?: boolean; preserveCurrentOnMiss?: boolean }
    ) => {
        const cachedTheme = await getCachedThemeState(songId);

        if (cachedTheme.kind === 'dual') {
            applyDualTheme(cachedTheme.theme);
            return 'dual' as const;
        }

        if (cachedTheme.kind === 'legacy') {
            applyLegacyTheme(cachedTheme.theme);
            return 'legacy' as const;
        }

        if (options?.allowLastUsedFallback) {
            const lastDualTheme = await getLastDualTheme();
            if (lastDualTheme) {
                applyDualTheme({
                    light: {
                        ...lastDualTheme.light,
                        wordColors: [],
                        lyricsIcons: [],
                    },
                    dark: {
                        ...lastDualTheme.dark,
                        wordColors: [],
                        lyricsIcons: [],
                    },
                });
                return 'fallback-dual' as const;
            }
        }

        if (options?.preserveCurrentOnMiss ?? true) {
            return 'none' as const;
        }

        applyThemeFallback();
        return 'none' as const;
    };

    const generateAITheme = async (lyrics: LyricData | null, currentSong: SongResult | null) => {
        if (isGeneratingTheme) return;

        setIsGeneratingTheme(true);
        setStatusMsg({ type: 'info', text: t('status.generatingTheme') });
        try {
            const allText = lyrics?.lines.map(line => line.fullText).join('\n').trim() || '';
            const songTitle = currentSong?.name?.trim() || lyrics?.title?.trim() || '';
            const isPureMusic = Boolean(currentSong?.isPureMusic) || isPureMusicLyricText(allText);
            const promptText = (isPureMusic ? songTitle : allText) || allText;

            if (!promptText) {
                setStatusMsg({ type: 'error', text: t('status.themeGenerationFailed') });
                return;
            }

            const dualTheme = await generateThemeFromLyrics(promptText, {
                isPureMusic,
                songTitle: songTitle || undefined,
            });
            setLegacyTheme(null);
            setAiTheme(dualTheme);
            if (bgMode !== 'custom') {
                setBgMode('ai');
            }

            const selectedTheme = getSelectedDualTheme(dualTheme, isDaylight);
            setStatusMsg({
                type: 'success',
                text: bgMode === 'custom' && customTheme
                    ? 'AI 主题已更新，自定义主题仍为首选'
                    : t('status.themeApplied', { themeName: selectedTheme.name }),
            });

            if (currentSong) {
                saveToCache(`dual_theme_${currentSong.id}`, dualTheme);
            }
            saveToCache('last_dual_theme', dualTheme);
        } catch (error: unknown) {
            console.error(error);
            if (isMissingAiApiKeyError(error)) {
                const coverColors = coverUrl ? await extractColors(coverUrl, 5) : [];
                const fallbackTheme = buildBuiltinDualTheme({ coverColors });
                setLegacyTheme(null);
                setAiTheme(fallbackTheme);
                if (bgMode !== 'custom') {
                    setBgMode('ai');
                }

                if (currentSong) {
                    saveToCache(`dual_theme_${currentSong.id}`, fallbackTheme);
                }
                saveToCache('last_dual_theme', fallbackTheme);
                setStatusMsg({
                    type: 'info',
                    text: bgMode === 'custom' && customTheme
                        ? 'AI 主题已生成，但当前仍优先使用自定义主题'
                        : t('status.aiFallbackThemeUsed'),
                });
            } else {
                setStatusMsg({ type: 'error', text: t('status.themeGenerationFailed') });
            }
        } finally {
            setIsGeneratingTheme(false);
        }
    };

    return {
        theme,
        setTheme,
        aiTheme,
        setAiTheme,
        customTheme,
        hasCustomTheme: Boolean(customTheme),
        bgMode,
        setBgMode,
        isGeneratingTheme,
        handleToggleDaylight,
        handleBgModeChange,
        handleResetTheme,
        handleSetThemePreset,
        applyDualTheme,
        applyLegacyTheme,
        applyThemeFallback,
        restoreCachedThemeForSong,
        generateAITheme,
        getThemeParkSeedTheme,
        saveCustomDualTheme,
        applyPreferredCustomTheme,
    };
}
