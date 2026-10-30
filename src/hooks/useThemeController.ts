import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { generateThemeFromLyrics, isMissingAiApiKeyError } from '../services/gemini';
import { notifyStageResolved } from '../services/aiStage';
import {
    type AiThemeSongRef,
    pullAiThemeFromCloud,
    pullCachedThemeByKey,
    writeLocalAiThemeOverride,
    readLocalAiThemeOverride,
} from '../services/aiThemeCloud';
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
import { getPlaybackSongKey } from '../utils/appPlaybackGuards';
import { resolveSongPlatform } from '../utils/songPlatform';
import { setStatusMessage as setStatusMsg } from '../stores/useStatusMessageStore';
import { usePlaybackStore } from '../stores/usePlaybackStore';
import { useStableCallbacks } from './useStableCallbacks';

type StatusSetter = Dispatch<SetStateAction<StatusMessage | null>>;
export type GenerateAIThemeOptions = {
    source?: 'manual' | 'auto';
    shouldApply?: () => boolean;
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

/** 云端 / 本地那两层只认「歌名 + 歌手」，把 SongResult 折成它要的形状。 */
/**
 * 当前这首歌的歌词正文 —— 只在**歌词确实是这首的**时候才给。
 *
 * 切歌那一刻歌词常常还没换过来：拿上一首的词去判这一首，会把明明合规的条目判成不合规
 * （凭空多一次生成）。宁可这一回不判（照旧信键），也不要拿错的歌词当凭据。
 */
const readLyricTextFor = (song: SongResult | null): string => {
    if (!song) return '';
    const lyrics = usePlaybackStore.getState().lyrics;
    if (!lyrics?.lines?.length) return '';
    const lyricTitle = String(lyrics.title ?? '').trim();
    const songTitle = String(song.name ?? '').trim();
    if (lyricTitle && songTitle && lyricTitle !== songTitle) return '';
    return lyrics.lines.map(line => line.fullText).join('\n').trim();
};

const songRefOf = (song: SongResult): AiThemeSongRef => ({
    title: song?.name,
    artist: song?.artists?.map(artist => artist.name).filter(Boolean).join('、'),
});

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
    /*
     * 「正在把这首歌的主题找回来」也要算在途（本地改过的那一版 / 云端那条键），
     * 不只是「正在问模型」。
     *
     * 换歌那一刻主题是这样一层层落下来的：先翻本机改过的那版、再按云端键拉，
     * 都没有才轮到自动生成（还隔着 650ms 那一拍）。中间任何一层落定都会改一次 theme，
     * 而它们**都不经过 beginThemeGeneration** —— 只认 isGeneratingTheme 的话，
     * 这一段是「静默」的：外表上主题已经落定，其实等会儿还要再变一次。
     * 叠层那边一次换主题就是一次重画（闪一下），所以要在外面看得见这段在途。
     */
    const [isThemeRestoring, setIsThemeRestoring] = useState(false);
    const activeThemeRestoreCountRef = useRef(0);

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

    const beginThemeRestore = () => {
        activeThemeRestoreCountRef.current += 1;
        setIsThemeRestoring(true);
    };

    const endThemeRestore = () => {
        activeThemeRestoreCountRef.current = Math.max(0, activeThemeRestoreCountRef.current - 1);
        setIsThemeRestoring(activeThemeRestoreCountRef.current > 0);
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

            // 「默认」不参与旧版主题的配色：切回默认必须真的回到默认主题（只换背景不算回去）。
            if (bgMode === 'ai' && legacyTheme) {
                const baseTheme = getBaseTheme();
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
        const songKey = syncSong ? getPlaybackSongKey(syncSong) : songOrKey;
        if (songKey != null) {
            void saveToCache(`dual_theme_${songKey}`, sanitized);
        }
        /*
         * 「本机改过」这一份单独记一份（services/aiThemeCloud.ts）。
         *
         * 之后这首歌一律以它为准：云端那条还在，但不许反过来盖掉用户刚改的颜色
         * —— 少了这一层，切走再切回来就会被云端的旧版本顶掉，改完像没改。
         */
        if (syncSong) {
            void writeLocalAiThemeOverride(songRefOf(syncSong), sanitized);
            // 面板那颗「恢复云端版本」靠它决定出不出来 —— 改完当场就该在。
            setCurrentSongHasLocalAiTheme(true);
        }
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
        const pointer = readStoredLastAppliedThemePointer();

        if (pointer === 'custom' && customTheme) {
            setBgMode('custom');
            return 'restored' as const;
        }

        if (pointer === 'ai') {
            const lastDualTheme = await getLastDualTheme();
            if (lastDualTheme) {
                applyDualTheme(lastDualTheme, { respectCustomPreference: false });
                return 'fallback-dual' as const;
            }

            const lastLegacyTheme = await getLastLegacyTheme();
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

    const restoreCachedThemeForSongInner = async (
        songOrId: ThemeCacheSongKey | SongResult,
        options?: { allowLastUsedFallback?: boolean; preserveCurrentOnMiss?: boolean }
    ) => {
        if (!songThemeAutoSwitchEnabled) {
            if (options?.allowLastUsedFallback) {
                return restoreThemeFromLastAppliedPointer();
            }
            return 'restored' as const;
        }

        /*
         * 先看**本机改过**那一版（services/aiThemeCloud.ts）：用户在快速编辑里改过的歌，
         * 一律以本机为准，云端那条不许反过来盖掉它。
         *
         * 以前这里翻的是 `dual_theme_*` 那份全量本地缓存 —— 那份按用户要求删掉了
         * （生成结果只存云端，见 services/aiStage.ts）；留下来的是「改过」这一份，
         * 它不是缓存，是用户的编辑。
         */
        const localSong = typeof songOrId === 'object' && songOrId !== null ? songOrId : null;
        if (localSong) {
            const override = await readLocalAiThemeOverride(songRefOf(localSong));
            if (override) {
                applyDualTheme(override, { respectCustomPreference: false });
                setCurrentSongHasLocalAiTheme(true);
                return 'local-override' as const;
            }

            /*
             * 从「AI 主题」那一屏点播放进来的：曲目上带着云端那条键 —— **直接用它**，
             * 不再走生成。生成要有歌词、要有 API Key，而这条缓存存在的意义就是
             * 不必再算一次；少了这一段，点播放就是「歌放起来了，主题一点没变」。
             */
            const cloudKey = localSong.aiCloudThemeKey;
            if (cloudKey) {
                /*
                 * 带上歌词：这一路以前是**按已知键直取**，一道判定都不走 —— 舞台那条链路
                 * 判住的脏条目，从「AI 主题」这一屏点播放照样能进来。
                 */
                const cached = await pullCachedThemeByKey(cloudKey, readLyricTextFor(localSong));
                if (cached) {
                    applyDualTheme(cached, { respectCustomPreference: false });
                    return 'cloud-theme' as const;
                }
                /*
                 * 键直取没中，再按**歌名 + 歌手**问一次。
                 *
                 * 那一屏的 key 是服务端按歌名 `GROUP BY` 里取 `MAX(cache_key)` 给的，它可能
                 * 落在一条 stage 上而那条只有动画决策、没有主题那一半（或那条 payload 形状
                 * 不合规）—— 于是「云端明明有这首歌，播下去主题一点没变」。
                 *
                 * 这一路现在是**强制匹配**（services/aiCloudCache）：歌名对得上就用，不再因为
                 * 高亮词差几个字判成没有。所以它是这一屏点播放最后那道兜底：取不到才轮到生成。
                 */
                const byTitle = await pullAiThemeFromCloud(songRefOf(localSong), readLyricTextFor(localSong));
                if (byTitle) {
                    applyDualTheme(byTitle, { respectCustomPreference: false });
                    return 'cloud-theme' as const;
                }
            }
        }
        setCurrentSongHasLocalAiTheme(false);

        if (options?.allowLastUsedFallback) {
            const lastDualTheme = await getLastDualTheme();
            if (lastDualTheme) {
                applyDualTheme(lastDualTheme, { respectCustomPreference: false });
                return 'fallback-dual' as const;
            }

            const lastLegacyTheme = await getLastLegacyTheme();
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

    /**
     * 对外的那一层：把「找歌的过程」记成在途（beginThemeRestore / endThemeRestore）。
     *
     * 里面每一步都是异步的（读本机改过的那版、拉云端那条键、翻上次用过的），
     * 而它们**都不碰 isGeneratingTheme** —— 不在这里记一笔的话，
     * 外面看到的就是「换歌后主题已经定下来了」，跟着推一次，等它真落定时又要再推一次
     * （叠层每换一次主题就要重画一次，也就是用户说的「闪两下」）。
     */
    const restoreCachedThemeForSong = async (
        songOrId: ThemeCacheSongKey | SongResult,
        options?: { allowLastUsedFallback?: boolean; preserveCurrentOnMiss?: boolean }
    ) => {
        beginThemeRestore();
        try {
            return await restoreCachedThemeForSongInner(songOrId, options);
        } finally {
            endThemeRestore();
        }
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
            await saveToCache(`dual_theme_${getPlaybackSongKey(currentSong)}`, coverTheme);
            saveSyncedThemeWithoutBlocking(currentSong, coverTheme, 'fallback');
        }

        if (!shouldApply()) {
            return { status: 'generated', applied: false };
        }

        if (currentSong) {
            setCurrentSongHasLocalAiTheme(true);
        }
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
        // Read playback at completion time, even before React has rendered the next song.
        // A late result may populate its own cache, but must not update another song's UI.
        const shouldApply = () => {
            const latestSong = usePlaybackStore.getState().currentSong;
            const latestSongKey = latestSong ? getPlaybackSongKey(latestSong) : '__no_song__';
            return latestSongKey === songKey && (options.shouldApply?.() ?? true);
        };
        if (themeGenerationSongKeysRef.current.has(songKey)) {
            return { status: 'skipped', reason: 'in-flight' };
        }

        themeGenerationSongKeysRef.current.add(songKey);
        beginThemeGeneration();
        setStatusMsg({ type: 'info', text: t('status.generatingTheme') });
        try {
            // The cover source never touches the model, so it also never needs a lyric prompt:
            // an instrumental with no title still gets a theme from its artwork.
            if (themeGenerationSource === 'cover') {
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
                if (source === 'manual') {
                    setStatusMsg({ type: 'error', text: t('status.themeGenerationFailed') });
                }
                return { status: 'skipped', reason: 'empty-prompt' };
            }

            /*
             * 走 services/gemini 那一版，不是 aiText 那一版。
             *
             * 两版同名：gemini 版经 requestStage 编排，先问云缓存、没有再生成、生成完回传
             * （services/aiStage.ts → withAiCloudCache）；aiText 版只有三条直连的路，
             * **完全不碰缓存**。上游合并把这里指到了 aiText，于是主题链路绕开云缓存：
             * 不拉、不推，命中提示也再没出现过 —— 那就是「云缓存失效」。
             */
            const { theme: dualTheme, source: themeSource } = await generateThemeFromLyrics(promptText, {
                isPureMusic,
                songTitle: songTitle || undefined,
                /*
                 * 艺人信息只为了提示词更准，不参与缓存指纹（同一份歌词换个人唱
                 * 也会是同一个答案，没必要多存一份）。
                 */
                artist: currentSong?.artists?.map(artist => artist.name).filter(Boolean).join('、') || undefined,
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
                /*
                 * 手动点「生成 AI 主题」就是「我对现在这个不满意，再给一个」——
                 * 所以不看缓存，直接重新问模型，生成完把云端那条**覆盖**掉。
                 *
                 * 自动触发（切歌）相反，必须走缓存：那正是云缓存要省掉的那次调用。
                 */
                force: options.force === true || source === 'manual',
            });
            const normalizedDualTheme = applyStoredAnimationIntensityToDualTheme(sanitizeDualTheme(dualTheme));
            if (currentSong) {
                await saveToCache(`dual_theme_${getPlaybackSongKey(currentSong)}`, normalizedDualTheme);
                saveSyncedThemeWithoutBlocking(currentSong, normalizedDualTheme, source === 'auto' ? 'auto' : 'manual');
            }

            if (!shouldApply()) {
                return { status: 'generated', applied: false };
            }

            if (currentSong) {
                setCurrentSongHasLocalAiTheme(true);
            }
            applyDualTheme(normalizedDualTheme);

            /*
             * 一次生成，两种说法：这次真调了模型就说「主题生成成功」，下一个人撞上同一段
             * 歌词时（source === 'cloud'）说「已从云端拉取缓存」。两条互斥 —— 命中那次
             * 根本没走生成，不该报「生成成功」。
             */
            if (bgMode === 'custom' && customTheme) {
                setStatusMsg({ type: 'success', text: t('notifications.aiThemeUpdatedCustomPreferred') });
            } else {
                notifyStageResolved(themeSource);
            }

            return { status: 'generated', applied: true };
        } catch (error: unknown) {
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
        /**
         * 「这首歌的主题还没落定」：正在把缓存找回来，或者正在问模型 / 拉云端。
         *
         * 只给外面**判断时机**用（比如叠层那一推要不要再等等），不是进度条 ——
         * 它只说「还要变」，不说变成什么样。
         */
        themeSettling: isGeneratingTheme || isThemeRestoring,
        ...actions,
    };
}
