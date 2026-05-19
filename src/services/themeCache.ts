import { DualTheme, Theme } from '../types';
import { getFromCache } from './db';

export type ThemeCacheSongKey = string | number;

export type CachedThemeState =
    | { kind: 'dual'; theme: DualTheme }
    | { kind: 'legacy'; theme: Theme }
    | { kind: 'none' };

export async function getCachedThemeState(songKey: ThemeCacheSongKey): Promise<CachedThemeState> {
    const dualTheme = await getFromCache<DualTheme>(`dual_theme_${songKey}`);
    if (dualTheme) {
        return { kind: 'dual', theme: dualTheme };
    }

    const legacyTheme = await getFromCache<Theme>(`theme_${songKey}`);
    if (legacyTheme) {
        return { kind: 'legacy', theme: legacyTheme };
    }

    return { kind: 'none' };
}

export async function getLastDualTheme(): Promise<DualTheme | null> {
    return getFromCache<DualTheme>('last_dual_theme');
}

export async function getLastLegacyTheme(): Promise<Theme | null> {
    return getFromCache<Theme>('last_theme');
}
