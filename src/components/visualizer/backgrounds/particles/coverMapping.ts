// src/components/visualizer/backgrounds/particles/coverMapping.ts
// 封面粒子背景的「封面怎么摆、封面怎么采样」的纯函数，#435。
//
// 这里只放计算，不碰 three / DOM，所以能直接被单测钉住：
//   resolveCoverFrame  —— 封面在可视区里占多大、放在哪（按封面宽高比居中）
//   coverUvFromGrid    —— 粒子网格坐标 → 封面纹理采样坐标（纵向不翻转）
//
// 两条约定，改这里必须一起改着色器（particlesShaders.ts 里对应的 uniform）：
//   1. 封面不铺满视口，按自己的宽高比等比缩放后居中放进可视区；
//   2. 纵向不翻转：网格 v=0 在画面底部，封面第 0 行（图片顶部）在封面框顶部。

/**
 * 封面的世界尺寸，单位与世界坐标一致（相机在 z 轴上，画面可视高 2·camZ·tan(fov/2)）。
 *
 * width / height 是封面框在世界空间里的边长；centerX / centerY 是框心，
 * 基本恒为 (0, 0)，除非调用方要挪封面。写进 uniform 之后，着色器用它把
 * 「屏幕的一格」换算成「封面上的一格」。
 */
export interface CoverFrame {
    width: number;
    height: number;
    centerX: number;
    centerY: number;
}

/** 可视区在世界空间里的尺寸 + 封面自身的宽高比。 */
export interface ViewportAndCoverAspect {
    /** 可视宽度（世界空间）。 */
    viewWidth: number;
    /** 可视高度（世界空间）。 */
    viewHeight: number;
    /** 封面像素宽 / 像素高。拿不到真实尺寸时传 1（正方形）。 */
    coverAspect: number;
}

/**
 * 保持封面比例、放进可视区之后的大小。
 *
 * 这是 CSS `object-fit: contain` 的算法：短边先贴住可视区，长边等比例缩进去。
 * 所以正方形封面在 16:9 的屏幕上得到的是一个居中的正方形，而不是拉成横幅。
 */
const fittedBox = (
    viewWidth: number,
    viewHeight: number,
    coverAspect: number,
): { width: number; height: number } => {
    const safeCoverAspect = Number.isFinite(coverAspect) && coverAspect > 0 ? coverAspect : 1;
    const safeViewWidth = Number.isFinite(viewWidth) && viewWidth > 0 ? viewWidth : 1;
    const safeViewHeight = Number.isFinite(viewHeight) && viewHeight > 0 ? viewHeight : 1;
    // 可视区里能放下的最大封面尺寸（保持封面比例）。
    const widthIfFullHeight = safeViewHeight * safeCoverAspect;
    if (widthIfFullHeight <= safeViewWidth) {
        return { width: widthIfFullHeight, height: safeViewHeight };
    }
    return { width: safeViewWidth, height: safeViewWidth / safeCoverAspect };
};

/**
 * 封面在可视区里的世界尺寸：按封面自己的比例等比缩放、居中 —— #435 的前两条现象。
 *
 * 封面不再铺满视口，所以正方形封面在 16:9 的屏幕上是一个居中的正方形，
 * 露出来的两侧交给背景本身（粒子只铺在封面这块区域里）。
 *
 * `fill` 是等比放大倍数，默认 1（恰好 contain）。要「更满一点但要保持比例」时调它，
 * 而不是去改宽高比 —— 比例一旦跟着屏幕走，就又变成「被拉伸铺满」了。
 */
export const resolveCoverFrame = (
    view: ViewportAndCoverAspect,
    fill = 1,
): CoverFrame => {
    const box = fittedBox(view.viewWidth, view.viewHeight, view.coverAspect);
    const scale = Number.isFinite(fill) && fill > 0 ? fill : 1;
    return {
        width: box.width * scale,
        height: box.height * scale,
        centerX: 0,
        centerY: 0,
    };
};

/**
 * 粒子网格坐标（aGrid，0..1）→ 封面纹理采样坐标（0..1），#435 第三条现象。
 *
 * 换算式：
 *   · 网格 u/v 对应世界坐标（(u - 0.5) * planeWidth / planeHeight）；
 *   · 世界坐标里封面框占 frame.width / frame.height，框心在覆盖区域的中心；
 *   · 再除以封面框尺寸并加 0.5，得到「封面自己的 0..1」。
 * 框外的坐标会落到 <0 或 >1，交给采样器按纹理边缘处理（与以前一样）。
 *
 * ★ v 不翻转。
 *   网格 v=0 → 世界 y 最小 → 画面底部；three 的纹理默认 flipY，texture2D 的 v=0
 *   也是图片底部。两边本来就一致，再写 `1.0 - v` 就多翻了一次（就是「凸起上下
 *   反了」）。这里的 depth 已经和像素对齐，同一个 v 也送给片元去采样封面，
 *   两边用同一份坐标，就再也对不齐不上了。
 */
export const coverUvFromGrid = (
    gridU: number,
    gridV: number,
    planeWidth: number,
    planeHeight: number,
    frame: CoverFrame,
): { u: number; v: number } => {
    const worldX = (gridU - 0.5) * planeWidth;
    const worldY = (gridV - 0.5) * planeHeight;
    const frameWidth = frame.width > 0 ? frame.width : 1;
    const frameHeight = frame.height > 0 ? frame.height : 1;
    return {
        u: (worldX - frame.centerX) / frameWidth + 0.5,
        v: (worldY - frame.centerY) / frameHeight + 0.5,
    };
};

/**
 * 封面图中的像素坐标 → 网格上的 0..1 采样坐标（景深那张低频图的取样用）。
 *
 * `coverUvFromGrid` 的逆运算：给出「封面上这一格在哪」，算回「网格坐标是多少」。
 * 落在封面框之外（采样器取到边缘色）就夹到边缘，和采样行为一致。
 *
 * ★ 纵向要翻，正是这一处的翻转让凸起方向才对（#435 的第三条现象）。
 *
 * 像素坐标 py=0 是图片**顶部**；网格的 v=0 是画面**底部**（见 coverUvFromGrid：
 * 采样坐标 v=0 对应纹理的第 0 行，而 three 的 flipY 让第 0 行就是图片底部）。
 * 两者原点相反，所以这里必须 `1 - py / (size - 1)`：
 *   · 图片顶部那行 → 网格 v≈1 → 画面上方的粒子 → 也被抬得最靠前；
 *   · 图片底部那行 → 网格 v≈0 → 画面下方。
 * 以前这里直接拿 py/(size-1) 当网格 v 用，等于把深度图上下颠倒了 ——
 * 这就是「凸起的上下方向完全反了」。
 */
export const gridFromCoverPixel = (
    pixelX: number,
    pixelY: number,
    pixelSize: number,
    planeWidth: number,
    planeHeight: number,
    frame: CoverFrame,
): { u: number; v: number } => {
    const size = pixelSize > 1 ? pixelSize : 1;
    const cu = Math.min(1, Math.max(0, pixelX / (size - 1)));
    /* 像素行 → 封面自身的 0..1（cv=0 是封面底部，与采样坐标同一方向）。 */
    const cv = Math.min(1, Math.max(0, 1 - pixelY / (size - 1)));
    const worldX = (cu - 0.5) * (frame.width > 0 ? frame.width : 1) + frame.centerX;
    const worldY = (cv - 0.5) * (frame.height > 0 ? frame.height : 1) + frame.centerY;
    const width = planeWidth > 0 ? planeWidth : 1;
    const height = planeHeight > 0 ? planeHeight : 1;
    return {
        u: worldX / width + 0.5,
        v: worldY / height + 0.5,
    };
};

/**
 * 着色器里用的「网格→封面」系数，也就是 coverUv 的线性部分。
 *
 * 片元着色器每个像素都算一遍 coverUvFromGrid，m 是逐帧变化的，
 * 所以把结果预计算成两个 vec2（scale / offset）传进去：
 *   coverUv = vSampleUv * scale + offset
 * 两个形态（丝绸 / 星球）共用它；行为与 coverUvFromGrid 一一对应，单测两边一起钉。
 */
export const coverUvCoefficients = (
    planeWidth: number,
    planeHeight: number,
    frame: CoverFrame,
): { scaleU: number; scaleV: number; offsetU: number; offsetV: number } => {
    const frameWidth = frame.width > 0 ? frame.width : 1;
    const frameHeight = frame.height > 0 ? frame.height : 1;
    const width = planeWidth > 0 ? planeWidth : 1;
    const height = planeHeight > 0 ? planeHeight : 1;
    return {
        scaleU: width / frameWidth,
        scaleV: height / frameHeight,
        /*
         * 常数项来自 coverUvFromGrid 的展开：
         *   (u - 0.5) * plane / frame + 0.5 - center / frame
         * = u * (plane / frame) + [0.5 - 0.5 * plane / frame - center / frame]
         * 下面第二项就是那个方括号。写成「0.5 - center / frame」会漏掉
         * 「网格中心本来就对应 plane 中点」带来的 -0.5 * scale，
         * 结果整张封面被推偏半个封面宽（单测里这对系数与 coverUvFromGrid 互相钉住）。
         */
        offsetU: 0.5 - 0.5 * (width / frameWidth) - frame.centerX / frameWidth,
        offsetV: 0.5 - 0.5 * (height / frameHeight) - frame.centerY / frameHeight,
    };
};

/**
 * 网格实际铺在世界空间里的那块区域。
 *
 * 丝绸铺封面框（——封面多大，粒子就铺多大，这就是「按封面真实比例摆放」）；
 * 其余形态铺满可视区，位置由各自的 3D 几何决定，网格只提供 aGrid 与格距。
 */
export const resolveGridSpan = (
    layoutByCover: boolean,
    planeWidth: number,
    planeHeight: number,
    frame: CoverFrame,
): { width: number; height: number } => (layoutByCover
    ? { width: frame.width, height: frame.height }
    : { width: planeWidth, height: planeHeight });

/**
 * 横向格数：让每格在它铺的那块区域里是正方形。
 *
 * 纵向固定 grid 格，横向按区域宽高比取。区域是封面框而比例却按屏幕算的话，
 * 丝绸的格子会被拉成长方形 —— 而 gl_PointSize 画出来一定是正圆，
 * 结果就是「横向稀、纵向密」的竖纹（这条背景上以前踩过）。
 */
export const resolveGridColumns = (
    grid: number,
    layoutByCover: boolean,
    screenAspect: number,
    frame: CoverFrame,
): number => {
    const coverAspect = frame.height > 0 ? frame.width / frame.height : 1;
    const aspect = layoutByCover ? coverAspect : screenAspect;
    return Math.max(8, Math.round(grid * aspect));
};
