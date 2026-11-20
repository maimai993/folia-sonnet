// src/components/shared/platformIcons/platformIconShapes.ts
// 本目录所有平台图标共用的一套几何语言：同一个 48×48 画布、同一种圆角底板、同一种描边粗细、
// 同一处留白。每个平台的图标文件只画「自己的那一笔特征」，底板、圆角与内边距都由这里给，
// 所以摆在一起时是一组，而不是十几个来源不同的图。
//
// 尺寸：画布 48，底板圆角 12，内容框 12..36（留白 12），描边宽度 3，线端为圆头。
// 这些数字要在 16 / 24 / 32 / 48 四种尺寸上都站得住：16px 时描边还有 1px。
//
// 同一份特征还有第二个出口：安卓通知栏的角标（`android/.../res/drawable/ic_provider_*.xml`）
// 是从这里同一份几何数据机械转出来的**纯白剪影**（见 `platformGesturePaths` 与
// `test/scripts/buildProviderBadges.ts`）。所以平台文件里的特征只写「外框 + 描边」两种笔画，
// 不写填充规则、不写内联样式里的颜色以外的东西，两份产物才是同一张图形。

/** 各平台图标共用的画布边长（viewBox 用，不是渲染尺寸）。 */
export const PLATFORM_ICON_CANVAS = 48;

/** 占位图形在画布里的内容框：画特征时只往这个范围里放，保证四周留白一致。 */
export const PLATFORM_ICON_INSET = { x: 12, y: 12, size: 24 } as const;

/** 共用的描边粗细与线端。 */
export const PLATFORM_ICON_STROKE = { width: 3, linecap: 'round', linejoin: 'round' } as const;

/**
 * 一个平台图标里的一笔特征。
 *
 * - `outline`：只画外框、不填充（`fill="none"` + 粗描边）。图标上是那根线，通知栏剪影里是
 *   同粗细的**白色描边**——通知栏的 smallIcon 只认 alpha，纯白线画在透明底上正合它。
 * - `stroke`：实心的一笔（`fill` 有值，可选 `stroke` 加一圈同色描边把细笔画撑粗）。剪影里一律纯白。
 *
 * 一个平台文件里的特征按这个结构写，`platformIconPaths` 拼成图标内容，安卓那边按同一种结构
 * 转成 VectorDrawable 的 `pathData`。
 */
export type PlatformIconGesture =
    | { kind: 'outline'; d: string }
    | { kind: 'stroke'; d: string; fill: string; stroke?: { color: string; width: number } };

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
    /**
     * 拼出 `content` 的那几笔**原始几何**（坐标系是 48 画布，未缩放）。
     *
     * 前端画图只读 `content`；留这一份是为了让安卓通知栏的角标能机械转出来
     * （`scripts/buildProviderBadges.mjs` 与 `test/unit/platformIcons`）：两份产物出自同一组数字，
     * 而不是「照着一张图再手抄一遍」。`content` 必须等于 `platformIconPaths(gestures)`，用例会核。
     */
    gestures: readonly PlatformIconGesture[];
}

/** 一笔特征拼成一段 SVG 内容。 */
const gestureSvg = (gesture: PlatformIconGesture): string => (
    gesture.kind === 'outline'
        ? `<path d="${gesture.d}" fill="none" stroke="#FFFFFF" stroke-width="${PLATFORM_ICON_STROKE.width}" stroke-linecap="round" stroke-linejoin="round"/>`
        : `<path d="${gesture.d}" fill="${gesture.fill}"`
            + `${gesture.stroke ? ` stroke="${gesture.stroke.color}" stroke-width="${gesture.stroke.width}" stroke-linejoin="round"` : ''}/>`
);

/** 把各平台图标文件的特征拼成一段 SVG 内容。 */
export const platformIconPaths = (gestures: readonly PlatformIconGesture[]): string => gestures.map(gestureSvg).join('');

/** 把各平台图标文件共用的底板与内容外壳拼成一段 SVG 内容。 */
export const platformIconShell = (art: PlatformIconArt): string => [
    `<rect x="0" y="0" width="${PLATFORM_ICON_CANVAS}" height="${PLATFORM_ICON_CANVAS}" rx="12" fill="${art.background}"/>`,
    art.content,
].join('');

/**
 * 一个平台图标的 art：底板颜色、说明、几笔原始几何，外加由这几笔拼出来的内容。
 *
 * 平台文件只需要写前三样 —— 内容从 `gestures` 算出来，不在文件里再抄一份，两份才不会走样。
 */
export const platformIconArt = (
    art: Pick<PlatformIconArt, 'background' | 'description'> & { gestures: readonly PlatformIconGesture[] },
): PlatformIconArt => ({
    background: art.background,
    description: art.description,
    gestures: art.gestures,
    content: platformIconPaths(art.gestures),
});

/** 通知栏剪影的视口边长（dp）。安卓通知栏的 smallIcon 是 24dp 见方，图形再往里留一点边。 */
export const BADGE_VIEWPORT = 24;

/** 剪影在视口里留的边（dp）：描边宽 3 的一半是 1.5，留 2 就不会被视口裁掉。 */
export const BADGE_INSET = 2;
