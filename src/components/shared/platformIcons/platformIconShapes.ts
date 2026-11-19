// src/components/shared/platformIcons/platformIconShapes.ts
// 本目录所有平台图标共用的一套几何语言：同一个 48×48 画布、同一种圆角底板、同一种描边粗细、
// 同一处留白。每个平台的图标文件只画「自己的那一笔特征」，底板、圆角与内边距都由这里给，
// 所以摆在一起时是一组，而不是十几个来源不同的图。
//
// 尺寸：画布 48，底板圆角 12，内容框 12..36（留白 12），描边宽度 3，线端为圆头。
// 这些数字要在 16 / 24 / 32 / 48 四种尺寸下都站得住：16px 时描边还有 1px。

/** 各平台图标共用的画布边长（viewBox 用，不是渲染尺寸）。 */
export const PLATFORM_ICON_CANVAS = 48;

/** 占位图形在画布里的内容框：画特征时只往这个范围里放，保证四周留白一致。 */
export const PLATFORM_ICON_INSET = { x: 12, y: 12, size: 24 } as const;

/** 共用的描边粗细与线端。 */
export const PLATFORM_ICON_STROKE = { width: 3, linecap: 'round', linejoin: 'round' } as const;

/**
 * 一个平台图标的样子。图形一律以 SVG 原语描述（`circle` / `rect` / `path` / `polygon`），
 * 不在平台文件里写 `<svg>` 标签——根元素、尺寸与无障碍属性由 `PlatformIcon.tsx` 统一给。
 */
export interface PlatformIconArt {
    /** 底板颜色（几何底 + 识别色相）。 */
    background: string;
    /** 画在底板上的特征，颜色写死在图里，不随主题变（和平台记号一个道理）。 */
    content: string;
    /** 给屏幕阅读器与设计评审看的一句话：画的是什么，为什么还认得出这个平台。 */
    description: string;
}

/** 把各平台图标文件共用的底板与内容外壳拼成一段 SVG 内容。 */
export const platformIconShell = (art: PlatformIconArt): string => [
    `<rect x="0" y="0" width="${PLATFORM_ICON_CANVAS}" height="${PLATFORM_ICON_CANVAS}" rx="12" fill="${art.background}"/>`,
    art.content,
].join('');
