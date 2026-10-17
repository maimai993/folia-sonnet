import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { generateThemeFromLyrics, isMissingAiApiKeyError } from '../services/gemini';
import { notifyStageResolved, restorePersistentStage, subscribeStageUpdates, subscribeStageCacheDiagnostics, rollbackStageUpdate, acceptStageUpdate } from '../services/aiStage';
import { normalizeStageIdentity } from '../services/stageCache/identity';
import { resolveStageCloudNamespace } from '../services/stageCache/cloud';
import { readDirectorSettings } from '../services/lyricDirector/state';
import { AI_SETTINGS_CHANGED_EVENT } from '../services/aiSettings';
import { saveToCache } from '../services/db';
import { DualTheme, LyricData, SongResult, StatusMessage, Theme, ThemeMode } from '../types';
import { getLastDualTheme, getLastLegacyTheme, type ThemeCacheSongKey } from '../services/themeCache';
import { saveSyncedThemeForSong } from '../services/sync/syncRepository';
import {
    applyStoredAnimationIntensityToDualTheme,
    applyStoredAnimationIntensityToTheme,
    isThemeAnimationIntensity,
    readStoredLastAppliedThemePointer,
    readStoredThemeAutoGenerateEnabled,
    readStoredThemeAutoSwitchEnabled,
    readStoredThemeGenerationSource,
    resolveCustomThemePreferenceChange,
    resolveSongThemeAutoGenerateChange,
    resolveSongThemeAutoSwitchChange,
    saveStoredAnimationIntensity,
    saveStoredLastAppliedThemePointer,
    saveStoredThemeAutoGenerateEnabled,
    saveStoredThemeAutoSwitchEnabled,
    saveStoredThemeGenerationSource,
    type ThemeGenerationSource,
    type ThemePreferenceSwitchState,
} from '../services/themePreferences';
import { FALLBACK_AI_DUAL_THEME, sanitizeDualTheme, sanitizeTheme } from '../services/themeSanitizer';
import { extractColors } from '../utils/colorExtractor';
import { isPureMusicLyricText } from '../utils/lyrics/pureMusic';
import {
    buildThemeSourceModel,
    buildBuiltinDualTheme,
    buildDefaultCustomDualTheme,
    getBaseThemeForMode,
    resolveBgModeTheme,
} from './themeControllerState';
import { getPlaybackSongKey, getPlaybackSourceRef } from '../utils/appPlaybackGuards';
import { usePlaybackStore, selectDisplaySong } from '../stores/usePlaybackStore';
import { resolveSongPlatform } from '../utils/songPlatform';
import { recordAiThemeSkip } from '../utils/aiThemeDiagnostics';
import { setStatusMessage as setStatusMsg } from '../stores/useStatusMessageStore';
import { useStableCallbacks } from './useStableCallbacks';

type StatusSetter = Dispatch<SetStateAction<StatusMessage | null>>;
export type GenerateAIThemeOptions = {
    source?: 'manual' | 'auto';
    shouldApply?: () => boolean;
    signal?: AbortSignal;
    /** 「重新生成」：不看缓存重新问一次模型，结果覆盖掉云端已有的那条。 */
    force?: boolean;
};

export type GenerateAIThemeResult =
    | { status: 'generated'; applied: boolean }
    | { status: 'skipped'; reason: 'in-flight' | 'empty-prompt' }
    | { status: 'failed' };

const CUSTOM_DUAL_THEME_KEY = 'custom_dual_theme';

// Keeps local theme operations successful when the optional sync server is unavailable.
const saveSyncedThemeWithoutBlocking = (...args: Parameters<typeof saveSyncedThemeForSong>) => {
    void saveSyncedThemeForSong(...args).catch((error) => {
        console.warn('[sync] Failed to upload theme:', error);
    });
};
const CUSTOM_THEME_PREFERRED_KEY = 'custom_theme_preferred';

const sanitizeCustomTheme = (
    theme: Theme,
    fallbackName: string,
    fallbackTheme: Theme,
): Theme => {
    const sanitized = sanitizeTheme(theme, {
        ...fallbackTheme,
        name: fallbackName,
        description: '',
        wordColors: [],
        lyricsIcons: [],
        provider: 'Custom',
    });

    return {
        ...sanitized,
        name: sanitized.name?.trim() || fallbackName,
        description: sanitized.description || '',
        provider: sanitized.provider || 'Custom',
    };
};

const sanitizeCustomDualTheme = (dualTheme: DualTheme): DualTheme => ({
    light: sanitizeCustomTheme(dualTheme.light, 'Theme Park Light', FALLBACK_AI_DUAL_THEME.light),
    dark: sanitizeCustomTheme(dualTheme.dark, 'Theme Park Dark', FALLBACK_AI_DUAL_THEME.dark),
});

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

        return applyStoredAnimationIntensityToDualTheme(sanitizeCustomDualTheme({
            light: parsed.light,
            dark: parsed.dark,
        }));
    } catch {
        return null;
    }
};

const readStoredCustomPreferred = () => localStorage.getItem(CUSTOM_THEME_PREFERRED_KEY) === 'true';

const getSelectedDualTheme = (dualTheme: DualTheme, isDaylight: boolean) => (
    isDaylight ? dualTheme.light : dualTheme.dark
);

export function useThemeController({
    defaultTheme,
    daylightTheme,
    isDaylight,
    setDaylightPreference,
    coverUrl,
    t,
}: {
    defaultTheme: Theme;
    daylightTheme: Theme;
    isDaylight: boolean;
    setDaylightPreference: (enabled: boolean) => void;
    coverUrl?: string | null;
    t: (key: string, options?: Record<string, unknown>) => string;
}) {
    const getBaseTheme = () => getBaseThemeForMode({ defaultTheme, daylightTheme, isDaylight });
    const storedCustomTheme = useMemo(readStoredCustomTheme, []);
    const initialCustomTheme = useMemo(() => (
        storedCustomTheme ?? buildDefaultCustomDualTheme({ defaultTheme, daylightTheme })
    ), [daylightTheme, defaultTheme, storedCustomTheme]);
    const initialThemePreferenceState = useMemo<ThemePreferenceSwitchState>(() => {
        const customPreferred = Boolean(initialCustomTheme && readStoredCustomPreferred());
        if (customPreferred) {
            return {
                isCustomThemePreferred: true,
                songThemeAutoSwitchEnabled: false,
                songThemeAutoGenerateEnabled: false,
            };
        }

        const autoSwitchEnabled = readStoredThemeAutoSwitchEnabled();
        return {
            isCustomThemePreferred: false,
            songThemeAutoSwitchEnabled: autoSwitchEnabled,
            songThemeAutoGenerateEnabled: autoSwitchEnabled && readStoredThemeAutoGenerateEnabled(),
        };
    }, [initialCustomTheme]);

    const [theme, setTheme] = useState<Theme>(() => applyStoredAnimationIntensityToTheme(getBaseTheme()));
    const [aiTheme, setAiTheme] = useState<DualTheme | null>(null);
    const [legacyTheme, setLegacyTheme] = useState<Theme | null>(null);
    const [customTheme, setCustomTheme] = useState<DualTheme | null>(initialCustomTheme);
    const [isCustomThemePreferred, setIsCustomThemePreferred] = useState(initialThemePreferenceState.isCustomThemePreferred);
    const [songThemeAutoSwitchEnabled, setSongThemeAutoSwitchEnabled] = useState(initialThemePreferenceState.songThemeAutoSwitchEnabled);
    const [songThemeAutoGenerateEnabled, setSongThemeAutoGenerateEnabled] = useState(initialThemePreferenceState.songThemeAutoGenerateEnabled);
    const [themeGenerationSource, setThemeGenerationSource] = useState<ThemeGenerationSource>(() => readStoredThemeGenerationSource());
    const [bgMode, setBgMode] = useState<ThemeMode>(() => (
        initialCustomTheme && initialThemePreferenceState.isCustomThemePreferred ? 'custom' : 'default'
    ));
    const [currentSongHasLocalAiTheme, setCurrentSongHasLocalAiTheme] = useState(false);
    const [isGeneratingTheme, setIsGeneratingTheme] = useState(false);
    const activeThemeGenerationCountRef = useRef(0);
    const themeGenerationSongKeysRef = useRef(new Set<string>());
    const themeRequestRevisionRef = useRef(0);
    const playbackEpochRef = useRef(0);
    useEffect(() => usePlaybackStore.subscribe((state, previous) => {
        if (selectDisplaySong(state) !== selectDisplaySong(previous)) playbackEpochRef.current += 1;
    }), []);

    const themeSourceModel = useMemo(() => buildThemeSourceModel({
        bgMode,
        aiTheme,
        legacyTheme,
        customTheme,
        isDaylight,
        defaultTheme,
        daylightTheme,
        currentSongHasLocalAiTheme,
    }), [aiTheme, bgMode, customTheme, daylightTheme, defaultTheme, isDaylight, legacyTheme, currentSongHasLocalAiTheme]);

    // The three switches are mutually constrained by the resolvers, so they are only ever written
    // together through applyPreferenceSwitchState -- which lets a ref mirror them exactly. Reading the
    // render-scoped state instead would make two resolver calls in one handler (config import applies
    // both song-theme flags back to back) both start from the pre-import snapshot, so the second
    // write would silently discard the first.
    const preferenceSwitchRef = useRef<ThemePreferenceSwitchState>(initialThemePreferenceState);

    const getPreferenceSwitchState = (): ThemePreferenceSwitchState => preferenceSwitchRef.current;

    const applyPreferenceSwitchState = (state: ThemePreferenceSwitchState) => {
        preferenceSwitchRef.current = state;
        setIsCustomThemePreferred(state.isCustomThemePreferred);
        setSongThemeAutoSwitchEnabled(state.songThemeAutoSwitchEnabled);
        setSongThemeAutoGenerateEnabled(state.songThemeAutoGenerateEnabled);
    };

    const beginThemeGeneration = () => {
        activeThemeGenerationCountRef.current += 1;
        setIsGeneratingTheme(true);
    };

    const endThemeGeneration = () => {
        activeThemeGenerationCountRef.current = Math.max(0, activeThemeGenerationCountRef.current - 1);
        setIsGeneratingTheme(activeThemeGenerationCountRef.current > 0);
    };

    useEffect(() => {
        if (customTheme) {
            localStorage.setItem(CUSTOM_DUAL_THEME_KEY, JSON.stringify(customTheme));
        } else {
            localStorage.removeItem(CUSTOM_DUAL_THEME_KEY);
        }
    }, [customTheme]);

    useEffect(() => {
        localStorage.setItem(CUSTOM_THEME_PREFERRED_KEY, String(isCustomThemePreferred && !!customTheme));
    }, [customTheme, isCustomThemePreferred]);

    useEffect(() => {
        saveStoredAnimationIntensity(theme.animationIntensity);
    }, [theme.animationIntensity]);

    useEffect(() => {
        saveStoredThemeAutoSwitchEnabled(songThemeAutoSwitchEnabled);
    }, [songThemeAutoSwitchEnabled]);

    useEffect(() => {
        saveStoredThemeAutoGenerateEnabled(songThemeAutoGenerateEnabled);
        window.dispatchEvent(new CustomEvent(AI_SETTINGS_CHANGED_EVENT));
    }, [songThemeAutoGenerateEnabled]);

    useEffect(() => {
        saveStoredThemeGenerationSource(themeGenerationSource);
    }, [themeGenerationSource]);

    useEffect(() => {
        const pointer = bgMode === 'custom' && customTheme
            ? 'custom'
            : bgMode === 'ai' && (aiTheme || legacyTheme)
                ? 'ai'
                : 'default';
        saveStoredLastAppliedThemePointer(pointer);
    }, [aiTheme, bgMode, customTheme, legacyTheme]);

    useEffect(() => {
        setTheme(previousTheme => {
            const normalizeTheme = (nextTheme: Theme) => applyStoredAnimationIntensityToTheme(nextTheme);

            if (bgMode === 'custom' && customTheme) {
                return normalizeTheme(getSelectedDualTheme(customTheme, isDaylight));
            }

            if (bgMode === 'ai') {
                if (aiTheme) {
                    return normalizeTheme(getSelectedDualTheme(aiTheme, isDaylight));
                }

                if (legacyTheme) {
                    return normalizeTheme(legacyTheme);
                }
            }

            const baseTheme = getBaseTheme();
            if (legacyTheme) {
                return normalizeTheme({
                    ...legacyTheme,
                    backgroundColor: baseTheme.backgroundColor,
                });
            }

            return normalizeTheme(resolveBgModeTheme({
                mode: bgMode === 'custom' ? 'default' : bgMode,
                aiTheme,
                isDaylight,
                defaultTheme,
                daylightTheme,
                previousTheme,
            }));
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

    const applyDefaultTheme = () => {
        setAiTheme(null);
        setLegacyTheme(null);
        setBgMode('default');
        setStatusMsg({
            type: 'success',
            text: t('notifications.appliedDefaultTheme', { themeName: isDaylight ? 'Daylight Default' : 'Midnight Default' }),
        });
    };

    const applyDualTheme = (
        dualTheme: DualTheme,
        options?: { respectCustomPreference?: boolean }
    ) => {
        const normalizedDualTheme = applyStoredAnimationIntensityToDualTheme(sanitizeDualTheme(dualTheme));
        setLegacyTheme(null);
        setAiTheme(normalizedDualTheme);
        void saveToCache('last_dual_theme', normalizedDualTheme);
        const respectCustomPreference = options?.respectCustomPreference ?? true;
        if (!respectCustomPreference || !isCustomThemePreferred) {
            setBgMode('ai');
        }
    };

    const applyLegacyTheme = (
        nextLegacyTheme: Theme,
        options?: { respectCustomPreference?: boolean }
    ) => {
        const normalizedLegacyTheme = applyStoredAnimationIntensityToTheme(
            sanitizeTheme(nextLegacyTheme, FALLBACK_AI_DUAL_THEME.dark),
        );
        setAiTheme(null);
        setLegacyTheme(normalizedLegacyTheme);
        void saveToCache('last_theme', normalizedLegacyTheme);
        const respectCustomPreference = options?.respectCustomPreference ?? true;
        if (!respectCustomPreference || !isCustomThemePreferred) {
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

        const baseDualTheme = applyStoredAnimationIntensityToDualTheme({
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
        });

        if (legacyTheme) {
            if (isDaylight) {
                baseDualTheme.light = sanitizeCustomTheme({ ...legacyTheme }, legacyTheme.name || 'Theme Park Light', FALLBACK_AI_DUAL_THEME.light);
            } else {
                baseDualTheme.dark = sanitizeCustomTheme({ ...legacyTheme }, legacyTheme.name || 'Theme Park Dark', FALLBACK_AI_DUAL_THEME.dark);
            }
            return baseDualTheme;
        }

        if (isDaylight) {
            baseDualTheme.light = sanitizeCustomTheme({ ...theme }, theme.name || 'Theme Park Light', FALLBACK_AI_DUAL_THEME.light);
        } else {
            baseDualTheme.dark = sanitizeCustomTheme({ ...theme }, theme.name || 'Theme Park Dark', FALLBACK_AI_DUAL_THEME.dark);
        }

        return baseDualTheme;
    };

    const saveCustomDualTheme = (dualTheme: DualTheme) => {
        const sanitized = applyStoredAnimationIntensityToDualTheme(sanitizeCustomDualTheme(dualTheme));
        setCustomTheme(sanitized);
        setBgMode('custom');
        setStatusMsg({
            type: 'success',
            text: t('notifications.savedCustomTheme', { themeName: getSelectedDualTheme(sanitized, isDaylight).name }),
        });
        return sanitized;
    };

    const saveEditedAiDualTheme = (
        dualTheme: DualTheme,
        songOrKey?: SongResult | ThemeCacheSongKey | null,
    ) => {
        const sanitized = applyStoredAnimationIntensityToDualTheme(sanitizeDualTheme(dualTheme));
        setLegacyTheme(null);
        setAiTheme(sanitized);
        setBgMode('ai');
        void saveToCache('last_dual_theme', sanitized);
        const syncSong = songOrKey && typeof songOrKey === 'object' ? songOrKey : null;
        if (syncSong) {
            saveSyncedThemeWithoutBlocking(syncSong, sanitized, 'edited');
        }
        setStatusMsg({
            type: 'success',
            text: t('status.aiThemeUpdated', { themeName: getSelectedDualTheme(sanitized, isDaylight).name }),
        });
        return sanitized;
    };

    const applyCustomTheme = () => {
        if (!customTheme) {
            return;
        }

        setBgMode('custom');
        setStatusMsg({
            type: 'success',
            text: t('notifications.appliedCustomTheme', { themeName: getSelectedDualTheme(customTheme, isDaylight).name }),
        });
    };

    const handleCustomThemePreferenceChange = (enabled: boolean) => {
        if (!customTheme && enabled) {
            return;
        }

        applyPreferenceSwitchState(resolveCustomThemePreferenceChange(getPreferenceSwitchState(), enabled));
        if (enabled && customTheme) {
            setBgMode('custom');
        }

        setStatusMsg({
            type: 'info',
            text: t('notifications.' + (enabled ? 'customThemePreferredOn' : 'customThemePreferredOff')),
        });
    };

    const handleSongThemeAutoSwitchChange = (enabled: boolean) => {
        applyPreferenceSwitchState(resolveSongThemeAutoSwitchChange(getPreferenceSwitchState(), enabled));
        setStatusMsg({
            type: 'info',
            text: t('notifications.' + (enabled ? 'autoSwitchThemeOn' : 'autoSwitchThemeOff')),
        });
    };

    const handleSongThemeAutoGenerateChange = (enabled: boolean) => {
        applyPreferenceSwitchState(resolveSongThemeAutoGenerateChange(getPreferenceSwitchState(), enabled));
        setStatusMsg({
            type: 'info',
            text: t('notifications.' + (enabled ? 'autoGenerateThemeOn' : 'autoGenerateThemeOff')),
        });
    };

    const handleThemeGenerationSourceChange = (source: ThemeGenerationSource) => {
        setThemeGenerationSource(source);
        setStatusMsg({
            type: 'info',
            text: t(source === 'cover' ? 'notifications.themeSourceCover' : 'notifications.themeSourceAi'),
        });
    };

    const restoreThemeFromLastAppliedPointer = async () => {
        const epoch = playbackEpochRef.current;
        const revision = themeRequestRevisionRef.current;
        const valid = () => epoch === playbackEpochRef.current && revision === themeRequestRevisionRef.current;
        const pointer = readStoredLastAppliedThemePointer();

        if (pointer === 'custom' && customTheme) {
            setBgMode('custom');
            return 'restored' as const;
        }

        if (pointer === 'ai') {
            const lastDualTheme = await getLastDualTheme();
            if (!valid()) return 'none' as const;
            if (lastDualTheme) {
                applyDualTheme(lastDualTheme, { respectCustomPreference: false });
                return 'fallback-dual' as const;
            }

            const lastLegacyTheme = await getLastLegacyTheme();
            if (!valid()) return 'none' as const;
            if (lastLegacyTheme) {
                applyLegacyTheme(lastLegacyTheme, { respectCustomPreference: false });
                return 'legacy' as const;
            }
        }

        setAiTheme(null);
        setLegacyTheme(null);
        setBgMode('default');
        return 'restored' as const;
    };

    const restoreCachedThemeForSong = async (
        songOrId: ThemeCacheSongKey | SongResult,
        options?: { allowLastUsedFallback?: boolean; preserveCurrentOnMiss?: boolean }
    ) => {
        const epoch = playbackEpochRef.current;
        const revision = themeRequestRevisionRef.current;
        const valid = () => epoch === playbackEpochRef.current && revision === themeRequestRevisionRef.current;
        if (!songThemeAutoSwitchEnabled) {
            if (options?.allowLastUsedFallback) {
                return restoreThemeFromLastAppliedPointer();
            }
            return 'restored' as const;
        }

        if (typeof songOrId === 'object' && songOrId !== null && 'name' in songOrId
            && !(songOrId as SongResult).onlineLyricsState?.hasOnlineOverride
            && (songOrId as SongResult).onlineLyricsState?.lyricsSource !== 'imported'
            && !readDirectorSettings().userHint.trim()) {
            const song = songOrId as SongResult;
            const cached = await restorePersistentStage({ title: song.name,
                artist: song.artists?.map(artist => artist.name).join('、') ?? '',
                artists: song.artists?.map(artist => artist.name) ?? [], album: null });
            if (!valid()) return 'none' as const;
            if (cached?.current.payload.theme) {
                applyDualTheme(cached.current.payload.theme, { respectCustomPreference: true });
                setCurrentSongHasLocalAiTheme(true);
                return 'fallback-dual' as const;
            }
        }
        setCurrentSongHasLocalAiTheme(false);

        if (options?.allowLastUsedFallback) {
            const lastDualTheme = await getLastDualTheme();
            if (!valid()) return 'none' as const;
            if (lastDualTheme) {
                applyDualTheme(lastDualTheme, { respectCustomPreference: false });
                return 'fallback-dual' as const;
            }

            const lastLegacyTheme = await getLastLegacyTheme();
            if (!valid()) return 'none' as const;
            if (lastLegacyTheme) {
                applyLegacyTheme(lastLegacyTheme, { respectCustomPreference: false });
                return 'legacy' as const;
            }
        }

        if (options?.preserveCurrentOnMiss ?? true) {
            return 'none' as const;
        }

        applyThemeFallback();
        return 'none' as const;
    };

    // Cover-derived theme: the no-AI path. Shared by the "cover" generation source the user can
    // pick and by the fallback taken when the AI call fails for a missing API key.
    const applyCoverDerivedTheme = async (
        currentSong: SongResult | null,
        shouldApply: () => boolean,
        origin: 'chosen' | 'fallback',
    ): Promise<GenerateAIThemeResult> => {
        const coverColors = coverUrl ? await extractColors(coverUrl, 5) : [];
        const coverTheme = applyStoredAnimationIntensityToDualTheme(buildBuiltinDualTheme({ coverColors }));

        if (currentSong) {
            saveSyncedThemeWithoutBlocking(currentSong, coverTheme, 'fallback');
        }

        if (!shouldApply()) {
            return { status: 'generated', applied: false };
        }

        setCurrentSongHasLocalAiTheme(Boolean(currentSong));
        applyDualTheme(coverTheme);
        const customPreferred = bgMode === 'custom' && customTheme;
        setStatusMsg(origin === 'fallback'
            ? {
                type: 'info',
                text: customPreferred
                    ? t('notifications.aiThemeGeneratedCustomPreferred')
                    : t('status.aiFallbackThemeUsed'),
            }
            : {
                type: 'success',
                text: customPreferred
                    ? t('notifications.aiThemeUpdatedCustomPreferred')
                    : t('status.coverThemeApplied', {
                        themeName: getSelectedDualTheme(coverTheme, isDaylight).name,
                    }),
            });

        return { status: 'generated', applied: true };
    };

    const generateAITheme = async (
        lyrics: LyricData | null,
        currentSong: SongResult | null,
        options: GenerateAIThemeOptions = {},
    ): Promise<GenerateAIThemeResult> => {
        const source = options.source ?? 'manual';
        const songKey = currentSong ? getPlaybackSongKey(currentSong) : '__no_song__';
        if (themeGenerationSongKeysRef.current.has(songKey)) {
            recordAiThemeSkip('in-flight', source);
            return { status: 'skipped', reason: 'in-flight' };
        }

        const revision = ++themeRequestRevisionRef.current;
        const epoch = playbackEpochRef.current;
        const shouldApply = () => !options.signal?.aborted
            && revision === themeRequestRevisionRef.current
            && epoch === playbackEpochRef.current
            && (options.shouldApply?.() ?? true)
            && (!currentSong || getPlaybackSongKey(selectDisplaySong(usePlaybackStore.getState()) ?? currentSong) === songKey);
        themeGenerationSongKeysRef.current.add(songKey);
        beginThemeGeneration();
        try {
            // The cover source never touches the model, so it also never needs a lyric prompt:
            // an instrumental with no title still gets a theme from its artwork.
            if (themeGenerationSource === 'cover') {
                // 生成来源是「封面取色」时不会调用模型：报告里要能看出这一点，而不是「什么都没发生」。
                recordAiThemeSkip('source-cover', source);
                return await applyCoverDerivedTheme(
                    currentSong,
                    shouldApply,
                    'chosen',
                );
            }

            const allText = lyrics?.lines.map(line => line.fullText).join('\n').trim() || '';
            const songTitle = currentSong?.name?.trim() || lyrics?.title?.trim() || '';
            const isPureMusic = Boolean(currentSong?.isPureMusic) || isPureMusicLyricText(allText);
            const promptText = (isPureMusic ? songTitle : allText) || allText;

            if (!promptText) {
                recordAiThemeSkip('empty-prompt', source);
                if (source === 'manual') {
                    setStatusMsg({ type: 'error', text: t('status.themeGenerationFailed') });
                }
                return { status: 'skipped', reason: 'empty-prompt' };
            }

            const { theme: dualTheme, source: themeSource } = await generateThemeFromLyrics(promptText, {
                isPureMusic,
                songTitle: songTitle || undefined,
                /*
                 * 艺人信息只为了提示词更准，不参与缓存指纹（同一份歌词换个人唱
                 * 也会是同一个答案，没必要多存一份）。
                 */
                artist: currentSong?.artists?.map(artist => artist.name).filter(Boolean).join('、') || undefined,
                artists: currentSong?.artists?.map(artist => artist.name).filter(Boolean),
                mediaId: currentSong ? (() => {
                    const ref = getPlaybackSourceRef(currentSong);
                    return ref.kind === 'online' ? ref.mediaId : undefined;
                })() : undefined,
                signal: options.signal,
                isCurrent: shouldApply,
                publicEligible: currentSong?.onlineLyricsState?.lyricsSource !== 'imported'
                    && !currentSong?.onlineLyricsState?.hasOnlineOverride,
                /*
                 * 歌词行一起传进去：云缓存的指纹由「歌词正文 + 设置」算出，
                 * 导演那条链路算的是同一个值，两边才会共用一条缓存。
                 */
                lines: lyrics?.lines ?? [],
                trigger: source,
                /*
                 * 平台名只跟着上传走，服务端拿它去对应平台核对歌词；本地歌曲留空，
                 * 服务端再按顺序逐个平台试。键仍然是那个 MD5。
                 */
                platform: resolveSongPlatform(currentSong),
                /* 手动重生成仅替换本机选择，不授予公共覆盖权限。 */
                force: options.force === true || source === 'manual',
            });
            const normalizedDualTheme = applyStoredAnimationIntensityToDualTheme(sanitizeDualTheme(dualTheme));
            if (currentSong) {
                /* 设置同步保留原协议；完整 stage 由独立缓存管理。 */
                saveSyncedThemeWithoutBlocking(currentSong, normalizedDualTheme, source === 'auto' ? 'auto' : 'manual');
            }

            if (!shouldApply()) {
                return { status: 'generated', applied: false };
            }

            setCurrentSongHasLocalAiTheme(Boolean(currentSong));
            applyDualTheme(normalizedDualTheme);

            /* 生成结果提示不代表公共上传或离线保存已成功。 */
            if (bgMode === 'custom' && customTheme) {
                setStatusMsg({ type: 'success', text: t('notifications.aiThemeUpdatedCustomPreferred') });
            } else {
                notifyStageResolved(themeSource);
            }

            return { status: 'generated', applied: true };
        } catch (error: unknown) {
            if ((error as Error)?.name === 'AbortError') return { status: 'generated', applied: false };
            console.error(error);
            if (isMissingAiApiKeyError(error)) {
                return await applyCoverDerivedTheme(
                    currentSong,
                    shouldApply,
                    'fallback',
                );
            }

            if (shouldApply()) {
                setStatusMsg({ type: 'error', text: t('status.themeGenerationFailed') });
            }
            return { status: 'failed' };
        } finally {
            themeGenerationSongKeysRef.current.delete(songKey);
            endThemeGeneration();
        }
    };

    useEffect(() => subscribeStageUpdates(event => {
        const song = selectDisplaySong(usePlaybackStore.getState());
        const identity = song && normalizeStageIdentity({ title: song.name,
            artists: song.artists?.map(artist => artist.name) ?? [] });
        if (!identity || identity.key !== event.identityKey || !songThemeAutoSwitchEnabled || !event.payload.theme
            || (event.isCurrent && !event.isCurrent())
            || (event.namespace !== resolveStageCloudNamespace() && event.namespace !== `${resolveStageCloudNamespace()}/personal`)
            || Boolean(readDirectorSettings().userHint.trim())
            || song.onlineLyricsState?.lyricsSource === 'imported' || song.onlineLyricsState?.hasOnlineOverride) return;
        const epoch = playbackEpochRef.current;
        const actionCurrent = () => epoch === playbackEpochRef.current
            && selectDisplaySong(usePlaybackStore.getState()) === song;
        themeRequestRevisionRef.current += 1;
        applyDualTheme(event.payload.theme);
        setCurrentSongHasLocalAiTheme(true);
        setStatusMsg({ type: 'success', text: t(event.reason === 'rollback' ? 'stageCache.restored' : 'stageCache.updated'),
            nonce: Date.now(), durationMs: 12_000,
            actionLabel: t(event.reason === 'rollback' ? 'stageCache.accept' : 'stageCache.undo'),
            onAction: () => {
                if (!actionCurrent()) return;
                if (event.reason === 'rollback') {
                    if (event.redoRevision) void acceptStageUpdate(identity.key, event.redoRevision, event.revision);
                } else void rollbackStageUpdate(identity.key, event.revision);
            } });
    }), [songThemeAutoSwitchEnabled, t]);

    useEffect(() => subscribeStageCacheDiagnostics(event => {
        if (event.operation !== 'persist' || event.success || event.namespace !== resolveStageCloudNamespace()) return;
        const song = selectDisplaySong(usePlaybackStore.getState());
        const identity = song && normalizeStageIdentity({ title: song.name, artists: song.artists?.map(artist => artist.name) ?? [] });
        if (identity?.key === event.identityKey) setStatusMsg({ type: 'error', text: t('stageCache.saveFailed'), nonce: Date.now() });
    }), [t]);

    const setThemeWithStoredIntensity = (nextTheme: Theme) => {
        if (isThemeAnimationIntensity(nextTheme.animationIntensity)) {
            saveStoredAnimationIntensity(nextTheme.animationIntensity);
        }
        setTheme(applyStoredAnimationIntensityToTheme(nextTheme));
    };

    // Every one of these is invoked from an event, an effect or async work - never read during
    // render for its identity - so a permanent identity is safe here and is what lets the five
    // build*Model memos in App.tsx hold. Before this they changed on every render of this hook,
    // which cascaded into playSong and from there into all four view models.
    const actions = useStableCallbacks({
        setTheme: setThemeWithStoredIntensity,
        setAiTheme,
        setBgMode,
        handleToggleDaylight,
        handleBgModeChange,
        handleResetTheme,
        applyDefaultTheme,
        applyDualTheme,
        applyLegacyTheme,
        applyThemeFallback,
        restoreCachedThemeForSong,
        generateAITheme,
        getThemeParkSeedTheme,
        saveCustomDualTheme,
        saveEditedAiDualTheme,
        applyCustomTheme,
        handleCustomThemePreferenceChange,
        handleSongThemeAutoSwitchChange,
        handleSongThemeAutoGenerateChange,
        handleThemeGenerationSourceChange,
    });

    return {
        theme,
        aiTheme,
        customTheme,
        hasCustomTheme: Boolean(customTheme),
        themeSourceModel,
        isCustomThemePreferred,
        songThemeAutoSwitchEnabled,
        songThemeAutoGenerateEnabled,
        themeGenerationSource,
        bgMode,
        isGeneratingTheme,
        ...actions,
    };
}
