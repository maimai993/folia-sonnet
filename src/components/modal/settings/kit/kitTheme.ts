import { createContext, useContext, type CSSProperties } from 'react';
import type { Theme } from '../../../../types';
import { getContrastRatio } from '../../../../utils/themeColorMath';
import './kit.css';

// src/components/modal/settings/kit/kitTheme.ts
// The colours of the settings window. The window sets them once as CSS variables and every kit part
// reads them from there, so no part takes an isDaylight prop. Text and fills follow the app's
// --text-primary, the way the rest of the settings code colours itself; only the surfaces are fixed
// per light and dark.

const ON_ACCENT_DARK = '#17171a';
const ON_ACCENT_LIGHT = '#ffffff';

/** The colour of text and marks drawn on the accent: whichever of dark and white reads better on it. */
export const onAccentColor = (accent: string): string => (
    getContrastRatio(ON_ACCENT_DARK, accent) >= getContrastRatio(ON_ACCENT_LIGHT, accent) ? ON_ACCENT_DARK : ON_ACCENT_LIGHT
);

/** Stand-in album covers, for a picture or a preview a page draws. */
export const SAMPLE_COVERS = ['#6d5a8c', '#3f6f7a', '#a8664b', '#56745a', '#8a4f5d', '#4d5f8f', '#8c7a45', '#5d5d66'] as const;

/** The variables, for the `style` of the settings window. */
export const settingsTokens = (isDaylight: boolean, theme?: Theme, glass = false): CSSProperties => {
    const accent = theme?.accentColor || (isDaylight ? '#18181b' : '#f4f4f5');
    // 液态玻璃开着时，窗口那几片「面」不再用不透明色，而是同一个色相压到半透明：后面的画面
    // 透出来，src/shinoinject/ 挂的折射滤镜才有东西可折射。原来这些是不透明十六进制色，玻璃
    // 挂上去也只是把一块实心色模糊一下，看着完全没效果。
    // 只用 --st-win / --st-side / --st-card / --st-menu / --st-pv 这五片：文字色（--st-t*）与
    // 分隔线（--st-line*）不动，压透它们只会让字糊在背景上。
    // 透明度按面积从小到大给：整窗最低、卡片最高，层次仍然是「窗 < 侧栏 < 卡片」。
    // 72 是压透的统一档位（与 index.css 的全站规则一致）：再透会透出后面的层。
    //
    // 卡片/选项面（--st-card / --st-pv）比整窗再透一档（75/72 → 58/56）。
    // 为什么：卡片和图片选项在窗口**里面**，窗口那层玻璃已经在做模糊了，它们自己
    // 再挂 backdrop-filter 会被 Chromium 的 backdrop 屏障挡住（祖先有 backdrop-filter
    // 时，后代的 backdrop 采不到祖先背后的画面），加了等于白加。所以这里不叠模糊，
    // 只把材质调薄 —— 让窗口那一层透上来，视感上就是「卡片也是玻璃」，
    // 代价是零个额外合成层。见 issue #279 与设置页的玻璃覆盖。
    const surface = (opaque: string, alpha: number) => (
        glass ? `color-mix(in srgb, ${opaque} ${alpha}%, transparent)` : opaque
    );
    return {
        '--st-win': surface(isDaylight ? '#f3f3f4' : '#1a1a1d', 72),
        '--st-side': surface(isDaylight ? '#e9e9eb' : '#141416', 65),
        '--st-card': surface(isDaylight ? '#ffffff' : '#232327', 58),
        '--st-menu': surface(isDaylight ? '#ffffff' : '#2b2b30', 74),
        '--st-raise': isDaylight ? '#ffffff' : '#45454c',
        '--st-knob': isDaylight ? '#ffffff' : '#ececee',
        '--st-pv': surface(isDaylight ? '#ececef' : '#151517', 56),
        '--st-ok': isDaylight ? '#1e9a5c' : '#56c98d',
        '--st-warn': isDaylight ? '#b97a10' : '#e3a949',
        '--st-err': isDaylight ? '#d04444' : '#ef6f6f',
        /*
         * ★ --text-primary 在这里**重新定一次**，不能只靠继承。
         *
         * 下面的 --st-t* / --st-line* / --st-fill* 全都基于 var(--text-primary)，
         * 而它是个全局变量、**会被祖先改写**：
         *   · 主窗口由 buildAppStyle 设成主题的 primaryColor；
         *   · 资料库墙的 `.bravais-poster` 会把它改成本身的海报墨色（bravaisPoster.css）。
         *
         * 设置页里有些子页（背景市场这一类）会渲染在资料库墙的子树里，
         * 于是整窗文字继承了海报的墨色：海报墨色是深灰，而窗口在深色模式下
         * 底色是 #1a1a1d —— 深灰字压在深灰底上，搜索框、分类标签、
         * 按钮文字就全糊了（用户说的「没适配颜色模式」）。
         *
         * 窗口是个自足的表面，文字色不该取决于它挂在哪棵子树下。
         * 有主题就跟随主题（和主窗口一致），没有主题才退回按日夜写死的值。
         */
        '--text-primary': theme?.primaryColor || (isDaylight ? '#18181b' : '#f4f4f5'),
        '--st-t1': 'var(--text-primary)',
        '--st-t2': 'color-mix(in srgb, var(--text-primary) 62%, transparent)',
        '--st-t3': 'color-mix(in srgb, var(--text-primary) 42%, transparent)',
        '--st-line': 'color-mix(in srgb, var(--text-primary) 8%, transparent)',
        '--st-line2': 'color-mix(in srgb, var(--text-primary) 16%, transparent)',
        '--st-fill': 'color-mix(in srgb, var(--text-primary) 7%, transparent)',
        '--st-fill2': 'color-mix(in srgb, var(--text-primary) 12%, transparent)',
        '--st-track': 'color-mix(in srgb, var(--text-primary) 17%, transparent)',
        '--st-accent': accent,
        '--st-on-accent': onAccentColor(accent),
    } as CSSProperties;
};

/** What a part needs when it draws outside the window, where the variables do not reach. */
export type SettingsKitTheme = {
    isDaylight: boolean;
    theme?: Theme;
};

export const SettingsKitThemeContext = createContext<SettingsKitTheme>({ isDaylight: false });

export const useSettingsKitTheme = (): SettingsKitTheme => useContext(SettingsKitThemeContext);
