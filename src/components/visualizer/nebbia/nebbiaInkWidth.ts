// src/components/visualizer/nebbia/nebbiaInkWidth.ts
// 一个字的笔画宽度（em）：用户设的宽度 × 笔画数的收细系数，再兜一个「细到看不见」的下限。
// 下限只管可见性，不参与观感：原来的实现把下限写成固定的 8 像素，小字号时它比用户能设的最大值还大，
// 「笔画粗细」滑块在最细那一端完全失效（#257）。

/** 下限约 1.6 CSS 像素：擦痕遮罩是半分辨率，落到遮罩上还有 3 像素，着色器取阈值时不会消失。 */
export const INK_MIN_CSS_PX = 1.6;

/** 笔画越多收得越细，不然密字挤在一起糊成一团；收细程度夹在 0.55~1，部件位置还对。 */
export const inkThinFactor = (strokeCount: number) => (
    Math.min(1, Math.max(0.55, Math.sqrt(9 / Math.max(1, strokeCount))))
);

/**
 * `strokeWidth` 是 tuning 里的笔画粗细（× 字号），`sizePx` 是这个字在屏幕上的字号（CSS 像素）。
 * 返回 em 单位的线宽。
 */
export const nebbiaInkWidth = (strokeWidth: number, sizePx: number, strokeCount: number) => {
    const thin = inkThinFactor(strokeCount);
    const floorEm = INK_MIN_CSS_PX / Math.max(1, sizePx);
    return Math.max(strokeWidth * thin, floorEm);
};
