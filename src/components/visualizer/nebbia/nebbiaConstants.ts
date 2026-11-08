// src/components/visualizer/nebbia/nebbiaConstants.ts
// 原型（feat/fog-write-prototype 分支 dev/prototypes/fog-write/index.html）里能调的参数已全部开放进 types.ts 的 NebbiaTuning（预设值不变）；
// 这里只剩真正写死的几项，和几个共用的小工具。

export const NEBBIA_FIXED = {
    /** 收笔处堆起的大水珠；字号小于 endBeadMin 像素的不留。大小倍数是 tuning.endBead。 */
    endBeadMin: 48,
} as const;

/** 擦痕遮罩相对 CSS 像素的分辨率。 */
export const MASK_SCALE = 0.5;
/** 雾的预渲染相对画布的缩小倍数。 */
export const FOG_DIV = 4;

export const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
export const smooth = (t: number) => t * t * (3 - 2 * t);
