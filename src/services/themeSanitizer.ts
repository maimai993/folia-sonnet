import type { DualTheme, Theme } from '../types';
import themeSanitizerCore from '../../shared/themeSanitizer.cjs';

// src/services/themeSanitizer.ts
// Typed wrapper around the shared CJS sanitizer used by browser, API, workers, and Electron.

type ThemeSanitizerCore = {
    FALLBACK_AI_DUAL_THEME: DualTheme;
    normalizeThemeHexColor: (value: unknown, fallback: string, hardFallback?: string) => string;
    sanitizeTheme: (value: unknown, fallbackTheme: Theme) => Theme;
    sanitizeDualTheme: (value: unknown, fallbackTheme?: DualTheme) => DualTheme;
};

const core = themeSanitizerCore as ThemeSanitizerCore;

export const FALLBACK_AI_DUAL_THEME: DualTheme = core.FALLBACK_AI_DUAL_THEME;

export const normalizeThemeHexColor = (
    value: unknown,
    fallback: string,
    hardFallback = '#ffffff',
): string => core.normalizeThemeHexColor(value, fallback, hardFallback);

export const sanitizeTheme = (
    value: unknown,
    fallbackTheme: Theme,
): Theme => core.sanitizeTheme(value, fallbackTheme);

export const sanitizeDualTheme = (
    value: unknown,
    fallbackTheme: DualTheme = FALLBACK_AI_DUAL_THEME,
): DualTheme => core.sanitizeDualTheme(value, fallbackTheme);
