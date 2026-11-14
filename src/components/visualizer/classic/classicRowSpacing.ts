// src/components/visualizer/classic/classicRowSpacing.ts
// 流光折行后的行距：把每个词缩放、纵向偏移之后的实际占位算进去，避免上下两行叠在一起。
//
// 为什么需要它：流光用 flex-wrap 排一行歌词，折行时浏览器只按词框（1em 宽 × 1.22em 高）算行距，
// 可是 GlowWord 会把字 scale 放大（active 态还要再 ×1.4）、并用 y 把它推离原位 —— transform 不参与
// 布局，所以放大后的字形会溢出词框，上下两行各溢出一半就直接叠在一起。
// 390×844 实测：24 字行折成 3 行、行距 44px，相邻两行视觉上叠 49px；31 字行折成 4 行，叠 53px。

/** GlowWord 的行高（GlowWord.tsx style.lineHeight）。 */
export const GLOW_WORD_LINE_HEIGHT = 1.22;
/** active 态在词自己的 scale 上再乘的倍数（glowWordVariants 的 active 变体）。 */
export const GLOW_WORD_ACTIVE_SCALE = 1.4;

export interface ClassicWordBox {
    /** 词自己的常驻缩放（waiting 态是 0.5，active 是 scale × 1.4，passed 是 scale）。 */
    scale: number;
    /** 词的纵向随机偏移，active / passed 态都会带上。 */
    y: number;
}

/**
 * 折行行距（px）。相邻两行的间距要保持 ≥ 各自溢出词框的那一半之和：
 *   行距 = 行框高 × (最大峰值缩放 − 1) + 两行各自最大的 |y|
 * 取这一行真实的最大缩放与最大纵向偏移，不按最坏情况常量估。
 */
export const resolveClassicRowGapPx = (fontPx: number, words: readonly ClassicWordBox[]): number => {
    if (!Number.isFinite(fontPx) || fontPx <= 0 || words.length === 0) {
        return 0;
    }
    const lineBoxPx = fontPx * GLOW_WORD_LINE_HEIGHT;
    let peakScale = 1;
    let maxOffsetY = 0;
    words.forEach((word) => {
        const scale = Number.isFinite(word.scale) ? word.scale : 1;
        peakScale = Math.max(peakScale, scale * GLOW_WORD_ACTIVE_SCALE);
        maxOffsetY = Math.max(maxOffsetY, Math.abs(Number.isFinite(word.y) ? word.y : 0));
    });
    return Math.max(0, Math.round(lineBoxPx * (peakScale - 1) + maxOffsetY * 2));
};

/**
 * 字号档位。补齐行距之后整块会变高，很矮的屏上会顶出屏幕上沿；放不下时按档位降字号再排，
 * 和云阶 partitaLayout 的 DENSITY_LADDER 是同一套做法。放得下时永远是第一档 1（观感不变）。
 */
export const CLASSIC_DENSITY_LADDER: readonly number[] = [1, 0.9, 0.8, 0.72, 0.65, 0.58];

export interface ClassicFitWord extends ClassicWordBox {
    /** density = 1 时这个词的实测宽度（px）。 */
    width: number;
    /** 词的右边距（px，rem 已换算）。 */
    marginRight: number;
}

export interface ClassicFitInput {
    /** density = 1 时的主行字号（px）。 */
    baseFontPx: number;
    /** 折行容器的可用宽度（px）。 */
    availableWidth: number;
    /** 歌词容器的可用高度（px）；整块超过它就是「顶出屏幕」。 */
    availableHeight: number;
    words: readonly ClassicFitWord[];
}

export interface ClassicBlockMetrics {
    rows: number;
    lineBoxPx: number;
    rowGapPx: number;
    height: number;
}

/** 某个档位下这块歌词占多高：字号缩小时字宽跟着缩，右边距是 px 不缩。 */
export const measureClassicBlock = (input: ClassicFitInput, density: number): ClassicBlockMetrics => {
    const fontPx = input.baseFontPx * density;
    const lineBoxPx = fontPx * GLOW_WORD_LINE_HEIGHT;
    const rowGapPx = resolveClassicRowGapPx(fontPx, input.words);

    // 贪心装行，和 flex-wrap 的规则一致：放不下就换行，单个词不拆。
    let rows = 1;
    let rowWidth = 0;
    input.words.forEach((word, index) => {
        const itemWidth = word.width * density + word.marginRight;
        if (index > 0 && rowWidth + itemWidth > input.availableWidth) {
            rows += 1;
            rowWidth = itemWidth;
            return;
        }
        rowWidth += itemWidth;
    });

    return {
        rows,
        lineBoxPx,
        rowGapPx,
        height: rows * lineBoxPx + Math.max(0, rows - 1) * rowGapPx,
    };
};

/** 挑最大的、能放下的档位；一档都放不下就用最小那档（宁可小也不顶出屏幕）。 */
export const resolveClassicFontDensity = (input: ClassicFitInput): number => {
    if (!Number.isFinite(input.baseFontPx) || input.baseFontPx <= 0 || input.words.length === 0) {
        return 1;
    }
    if (!Number.isFinite(input.availableHeight) || input.availableHeight <= 0) {
        return 1;
    }
    for (const density of CLASSIC_DENSITY_LADDER) {
        if (measureClassicBlock(input, density).height <= input.availableHeight) {
            return density;
        }
    }
    return CLASSIC_DENSITY_LADDER[CLASSIC_DENSITY_LADDER.length - 1];
};
