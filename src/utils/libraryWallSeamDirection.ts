// src/utils/libraryWallSeamDirection.ts
// bravais 信息条的方向偏好（纯数据，叶子层）：竖向（从块与块之间的竖缝裂开）、横向（从块行之间的横缝裂开）、
// 自动（按视口的宽高比：竖着的屏幕用横条，横着的用竖缝）、自动（反向）（同一个判断，结果反过来：竖着的屏幕用竖缝，
// 横着的用横条）。store、设置分区、命令面板与 stage 共用这一份。
//
// 两个「自动」只看视口形状，不判断是不是手机：竖着拿的平板、拉成竖长条的桌面窗口一样算竖着的屏幕。高至少是宽的
// 1.1 倍才算竖着，接近方形的窗口在拖动时不会来回换方向。
//
// ⚠ 这里曾经有一个独立开关「反向」（useLibraryWallLookStore 的 seamDirectionReverse，默认开，用户定 2026-10-24），
// 它只翻「自动」那一支，界面上是方向下面缩进的一行 Toggle。上游把它并进了取值列表（自动（反向）），我们跟过来：
// 一个取值能说清的事不该多一个开关，而且那个开关在明确选了竖向 / 横向时是灰的、没道理还留在那儿。
// 迁移在 store 里（见 useLibraryWallLookStore 的 readStoredSeamDirection），旧存储键只读不写。

export type LibraryWallSeamDirection = 'auto' | 'auto-reverse' | 'vertical' | 'horizontal';

/** 设置分区与命令面板列出的顺序。 */
export const LIBRARY_WALL_SEAM_DIRECTIONS: readonly LibraryWallSeamDirection[] = Object.freeze(['auto', 'auto-reverse', 'vertical', 'horizontal'] as const);

/**
 * 默认方向：**自动（反向）**（用户定）。
 *
 * 与上游不同（上游默认「自动」）：我们这边那个独立开关默认就是「开」，迁移过来等价于自动（反向）。
 * 改这一行等于改所有新用户的默认观感，别顺手改。
 */
export const DEFAULT_LIBRARY_WALL_SEAM_DIRECTION: LibraryWallSeamDirection = 'auto-reverse';

export const isLibraryWallSeamDirection = (value: unknown): value is LibraryWallSeamDirection => (
    value === 'auto' || value === 'auto-reverse' || value === 'vertical' || value === 'horizontal'
);

/** 存储或导入的取值：认识的原样返回，其余回默认（自动（反向））。 */
export const normalizeLibraryWallSeamDirection = (value: unknown): LibraryWallSeamDirection => (
    isLibraryWallSeamDirection(value) ? value : DEFAULT_LIBRARY_WALL_SEAM_DIRECTION
);

/** 各取值的界面名与说明（设置分区、命令面板 picker、导入确认框共用）。 */
export const LIBRARY_WALL_SEAM_DIRECTION_TEXT: Readonly<Record<LibraryWallSeamDirection, { label: string; description: string }>> = Object.freeze({
    auto: { label: 'options.bravaisSeamDirectionAuto', description: 'options.bravaisSeamDirectionAutoDesc' },
    'auto-reverse': { label: 'options.bravaisSeamDirectionAutoReverse', description: 'options.bravaisSeamDirectionAutoReverseDesc' },
    vertical: { label: 'options.bravaisSeamDirectionVertical', description: 'options.bravaisSeamDirectionVerticalDesc' },
    horizontal: { label: 'options.bravaisSeamDirectionHorizontal', description: 'options.bravaisSeamDirectionHorizontalDesc' },
});

/** 「竖着」的阈值：高 ≥ 宽 × 1.1（宽高比 ≤ 10 / 11）。 */
export const LIBRARY_WALL_PORTRAIT_RATIO = 1.1;

/** 「竖着的屏幕」的媒体查询，留着给只拿得到视口、量不到墙面的地方用。 */
export const LIBRARY_WALL_PORTRAIT_QUERY = '(max-aspect-ratio: 10/11)';

/**
 * 这块画面是不是竖着的。舞台用**墙面的实测尺寸**问这一句，不用媒体查询：
 * 量的是它自己那个盒子（ResizeObserver，转屏 / 分屏 / 抽屉开合都会重新量），
 * 既不会跟窗口尺寸对不上，也不会因为某个 WebView 没派发 `change` 就卡在一边 ——
 * 那正是「自动」在横竖两边都开成横条的样子。
 */
export const isPortraitWall = (width: number, height: number): boolean => (
    width > 0 && height > 0 && height >= width * LIBRARY_WALL_PORTRAIT_RATIO
);

/** 此刻信息条该不该横着开：自动时竖着的屏幕横着开，自动（反向）时横着的屏幕横着开。 */
export const resolveLibraryWallSeamHorizontal = (
    direction: LibraryWallSeamDirection,
    portrait: boolean,
): boolean => {
    if (direction === 'auto') return portrait;
    if (direction === 'auto-reverse') return !portrait;
    return direction === 'horizontal';
};
