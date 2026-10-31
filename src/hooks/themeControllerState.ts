import { DualTheme, Theme } from '../types';
import { applyStoredAnimationIntensityToDualTheme } from '../services/themePreferences';
import { FALLBACK_AI_DUAL_THEME } from '../services/themeSanitizer';
import { generateBuiltinDualTheme } from '../utils/builtinTheme/generateBuiltinDualTheme';

export type ThemeSourceKind = 'default' | 'ai' | 'custom';
export type EditableThemeSourceKind = 'ai' | 'custom';

export type ThemeSourceOption = {
    source: ThemeSourceKind;
    available: boolean;
    editable: boolean;
    theme: Theme | null;
    label: string;
    swatchColor: string;
};

export type ThemeSourceModel = {
    activeSource: ThemeSourceKind;
    current: ThemeSourceOption;
    options: Record<ThemeSourceKind, ThemeSourceOption>;
    editableSource: EditableThemeSourceKind | null;
    canOpenQuickEditor: boolean;
    hasLocalAiTheme: boolean;
};

export const getBaseThemeForMode = ({
    defaultTheme,
    daylightTheme,
    isDaylight,
}: {
    defaultTheme: Theme;
    daylightTheme: Theme;
    isDaylight: boolean;
}): Theme => {
    return isDaylight ? daylightTheme : defaultTheme;
};

const getSelectedDualTheme = (dualTheme: DualTheme, isDaylight: boolean) => (
    isDaylight ? dualTheme.light : dualTheme.dark
);

const buildThemeSourceOption = (
    source: ThemeSourceKind,
    theme: Theme | null,
    available: boolean,
    editable: boolean,
): ThemeSourceOption => ({
    source,
    available,
    editable,
    theme,
    label: theme?.name ?? '',
    swatchColor: theme?.backgroundColor ?? 'transparent',
});

export const buildThemeSourceModel = ({
    bgMode,
    aiTheme,
    legacyTheme,
    customTheme,
    isDaylight,
    defaultTheme,
    daylightTheme,
    currentSongHasLocalAiTheme,
}: {
    bgMode: ThemeSourceKind;
    aiTheme: DualTheme | null;
    legacyTheme: Theme | null;
    customTheme: DualTheme | null;
    isDaylight: boolean;
    defaultTheme: Theme;
    daylightTheme: Theme;
    currentSongHasLocalAiTheme: boolean;
}): ThemeSourceModel => {
    const defaultSourceTheme = getBaseThemeForMode({ defaultTheme, daylightTheme, isDaylight });
    const aiSourceTheme = aiTheme
        ? getSelectedDualTheme(aiTheme, isDaylight)
        : legacyTheme ?? getSelectedDualTheme(FALLBACK_AI_DUAL_THEME, isDaylight);
    const customSourceTheme = customTheme
        ? getSelectedDualTheme(customTheme, isDaylight)
        : null;

    const options: Record<ThemeSourceKind, ThemeSourceOption> = {
        default: buildThemeSourceOption('default', defaultSourceTheme, true, false),
        ai: buildThemeSourceOption('ai', aiSourceTheme, true, Boolean(aiTheme || !legacyTheme)),
        custom: buildThemeSourceOption('custom', customSourceTheme, Boolean(customTheme), Boolean(customTheme)),
    };

    const activeSource = options[bgMode]?.available ? bgMode : 'default';
    const editableSource = options[activeSource].editable && activeSource !== 'default'
        ? activeSource
        : null;

    return {
        activeSource,
        current: options[activeSource],
        options,
        editableSource,
        canOpenQuickEditor: options.ai.editable || options.custom.editable,
        hasLocalAiTheme: currentSongHasLocalAiTheme,
    };
};

export const buildDefaultCustomDualTheme = ({
    defaultTheme,
    daylightTheme,
}: {
    defaultTheme: Theme;
    daylightTheme: Theme;
}): DualTheme => applyStoredAnimationIntensityToDualTheme({
    light: {
        ...daylightTheme,
        wordColors: [],
        lyricsIcons: [],
        provider: 'Custom',
    },
    dark: {
        ...defaultTheme,
        wordColors: [],
        lyricsIcons: [],
        provider: 'Custom',
    },
});

export const resolveBgModeTheme = ({
    mode,
    aiTheme,
    isDaylight,
    defaultTheme,
    daylightTheme,
    // 接住但不读：高亮词 / 歌词图标改回「跟着选中的主题走」之后这里不再需要它
    // （见下面 default 分支的注释）。留在签名里，调用方与既有测试照旧传。
}: {
    mode: 'default' | 'ai';
    aiTheme: DualTheme | null;
    isDaylight: boolean;
    defaultTheme: Theme;
    daylightTheme: Theme;
    previousTheme?: Theme;
}): Theme => {
    if (mode === 'default') {
        const baseTheme = getBaseThemeForMode({ defaultTheme, daylightTheme, isDaylight });
        if (!aiTheme) {
            return baseTheme;
        }
        const selectedAiTheme = isDaylight ? aiTheme.light : aiTheme.dark;
        /*
         * 背景就是默认主题的那一份，文字、强调色、按钮这些也都用默认的 —— 只把**这首歌**的
         * 高亮词与歌词图标带过来（它们跟着这首歌的主题走，缺了就没有 AI 高亮）。
         *
         * 以前这里返回的是整份 `selectedAiTheme` 只换背景，于是「主题来源」切回默认时，除了底色
         * 之外还是上一个来源的配色，看起来像没切回去（只能靠「重置主题」）。
         */
        return {
            ...baseTheme,
            wordColors: selectedAiTheme.wordColors,
            lyricsIcons: selectedAiTheme.lyricsIcons,
        };
    }

    const selectedAiTheme = aiTheme
        ? getSelectedDualTheme(aiTheme, isDaylight)
        : getSelectedDualTheme(FALLBACK_AI_DUAL_THEME, isDaylight);
    return selectedAiTheme;
};

// Cover-derived fallback theme used when no AI API key is configured; the color/name work lives
// in utils/builtinTheme, this only keeps the stored animation intensity applied.
export const buildBuiltinDualTheme = ({
    coverColors = [],
    random,
}: {
    coverColors?: string[];
    random?: () => number;
} = {}): DualTheme => applyStoredAnimationIntensityToDualTheme(
    generateBuiltinDualTheme({ coverColors, random }),
);
