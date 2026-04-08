import type { Theme } from '../types';

export const BUILTIN_FONT_STACKS: Record<Theme['fontStyle'], string> = {
    sans: '"Inter", "Noto Sans CJK SC", "Noto Sans JP", "Source Han Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif',
    serif: '"Iowan Old Style", "Noto Serif CJK SC", "Noto Serif JP", "Source Han Serif SC", "Songti SC", "STSong", "Georgia", serif',
    mono: '"IBM Plex Mono", "Sarasa Mono SC", "Noto Sans Mono CJK SC", "Noto Sans Mono", "SFMono-Regular", Consolas, monospace',
};

const quoteFontFamily = (fontFamily: string) => `"${fontFamily.replace(/["\\]/g, '\\$&')}"`;

export const resolveThemeFontStack = (theme: Pick<Theme, 'fontStyle' | 'fontFamily'>) => {
    const fallbackStack = BUILTIN_FONT_STACKS[theme.fontStyle] ?? BUILTIN_FONT_STACKS.sans;
    const customFontFamily = theme.fontFamily?.trim();

    if (!customFontFamily) {
        return fallbackStack;
    }

    return `${quoteFontFamily(customFontFamily)}, ${fallbackStack}`;
};
