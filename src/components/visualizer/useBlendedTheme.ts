import { useMemo } from 'react';
import type { Theme } from '../../types';
import { useBlendedColors } from './backgrounds/useBlendedColors';

// src/components/visualizer/useBlendedTheme.ts
// 切歌时每首歌各自的 AI 主题（配色）会整份替换，原先是硬切：主题 state 一变，
// 所有歌词样式、背景、和声叠层在同一帧把颜色换掉。这里沿用 backgrounds 里现成的
// useBlendedColors / mixColors，把四个主题色从「当前画面上的颜色」插值到新歌的颜色，
// 长度与样式切换的 softFocus 对齐（600ms）。一处下发，覆盖所有画面，不逐个样式改。
//
// 只对颜色插值：字体、字重这些离散属性照旧瞬时切换。没有颜色变化时（同一主题、
// 用户没切歌）useBlendedColors 直接短路，一次 rAF 都不跑，不增加后台负载。

/** 与 softFocus（leave 360ms + enter 520ms 的观感）对齐的配色过渡长度。 */
export const THEME_BLEND_MS = 600;

const COLOR_KEYS = ['backgroundColor', 'primaryColor', 'accentColor', 'secondaryColor'] as const;

const colorsOf = (theme: Theme): string[] => COLOR_KEYS.map(key => theme[key]);

const withColors = (theme: Theme, colors: readonly string[]): Theme => {
    if (theme.backgroundColor === colors[0] && theme.primaryColor === colors[1]
        && theme.accentColor === colors[2] && theme.secondaryColor === colors[3]) return theme;
    return {
        ...theme,
        backgroundColor: colors[0],
        primaryColor: colors[1],
        accentColor: colors[2],
        secondaryColor: colors[3],
    };
};

/**
 * 主/副主题各自的四个颜色沿 `durationMs` 平滑过渡；传 0（静态模式、OBS、降低动效）
 * 时直接返回原对象，行为与以前完全一致。
 */
export const useBlendedTheme = (
    theme: Theme,
    subtitleTheme: Theme,
    durationMs: number,
): { theme: Theme; subtitleTheme: Theme } => {
    // 颜色值不变时保持同一个数组引用，useBlendedColors 才会真正短路。
    // 依赖整份主题对象：exhaustive-deps 要的是 theme 本身，而不是它四个颜色键的枚举。
    // 用整份对象不会每帧重算 —— useBlendedColors 拿 colors.join('|') 当 key，
    // 主题引用变了、颜色没变时 target 仍是同一个数组，短路照旧。
    const mainColors = useMemo(() => colorsOf(theme), [theme]);
    const subColors = useMemo(() => colorsOf(subtitleTheme), [subtitleTheme]);

    const blendedMain = useBlendedColors(mainColors, durationMs);
    const blendedSub = useBlendedColors(subColors, durationMs);

    const main = useMemo(() => withColors(theme, blendedMain), [theme, blendedMain]);
    const sub = useMemo(() => withColors(subtitleTheme, blendedSub), [subtitleTheme, blendedSub]);
    return useMemo(() => ({ theme: main, subtitleTheme: sub }), [main, sub]);
};
