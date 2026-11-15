import { describe, expect, it } from 'vitest';
import {
    CLASSIC_DENSITY_LADDER,
    GLOW_WORD_ACTIVE_SCALE,
    GLOW_WORD_LINE_HEIGHT,
    measureClassicBlock,
    resolveClassicFontDensity,
    resolveClassicRowGapPx,
    type ClassicFitInput,
    type ClassicFitWord,
    type ClassicWordBox,
} from '@/components/visualizer/classic/classicRowSpacing';

// 流光的折行行距：这些断言钉住「相邻两行不会叠在一起」这条不变量（#187 对云阶做的同一件事）。
const lineBox = (fontPx: number) => fontPx * GLOW_WORD_LINE_HEIGHT;

/** 一行的视觉高度：字被 scale × 1.4 放大，再加上两端各 maxAbsY 的纵向偏移。 */
const visualRowHeight = (fontPx: number, scale: number, maxAbsY: number) => (
    lineBox(fontPx) * scale * GLOW_WORD_ACTIVE_SCALE + maxAbsY * 2
);

describe('resolveClassicRowGapPx', () => {
    it('空行与非法字号不产生行距', () => {
        expect(resolveClassicRowGapPx(36, [])).toBe(0);
        expect(resolveClassicRowGapPx(0, [{ scale: 1.2, y: 10 }])).toBe(0);
        expect(resolveClassicRowGapPx(Number.NaN, [{ scale: 1.2, y: 10 }])).toBe(0);
    });

    it('两行之间的行距至少补上各自的溢出，所以相邻两行不会叠在一起', () => {
        const scales = [0.8, 1.0, 1.1, 1.2, 1.3, 1.4];
        const offsets = [0, 6, 12, 20, 40, 60];
        const fontSizes = [24, 30, 36, 48, 72];

        fontSizes.forEach((fontPx) => {
            scales.forEach((scale) => {
                offsets.forEach((offsetY) => {
                    // 同一行里最挤的一组：一个词被推到 +y，另一个被推到 −y。
                    const words: ClassicWordBox[] = [{ scale, y: offsetY }, { scale, y: -offsetY }];
                    const rowGap = resolveClassicRowGapPx(fontPx, words);
                    const pitch = lineBox(fontPx) + rowGap;
                    const rowHeight = visualRowHeight(fontPx, scale, offsetY);

                    // 行距补齐后，相邻两行的行心间距不小于一行的视觉高度 —— 也就是溢出的一半 + 另一半。
                    expect(pitch).toBeGreaterThanOrEqual(rowHeight - 0.5);
                });
            });
        });
    });

    it('缩放或纵向偏移变大时行距只会变大，不会变小', () => {
        const base = resolveClassicRowGapPx(36, [{ scale: 1.1, y: 0 }]);
        expect(resolveClassicRowGapPx(36, [{ scale: 1.3, y: 0 }])).toBeGreaterThanOrEqual(base);
        expect(resolveClassicRowGapPx(36, [{ scale: 1.1, y: 20 }])).toBeGreaterThan(base);
        expect(resolveClassicRowGapPx(48, [{ scale: 1.1, y: 0 }])).toBeGreaterThan(base);
    });

    it('390 宽的竖屏上那一行（36px 字号、缩放 1.1~1.3、偏移 ±20）算出 73px 行距', () => {
        const words: ClassicWordBox[] = [
            { scale: 1.1, y: 18.4 },
            { scale: 1.26, y: -12.7 },
            { scale: 1.3, y: 6.2 },
        ];
        // 44px 行框 × (1.3 × 1.4 − 1) + 2 × 18.4 = 36 + 37 = 73
        expect(resolveClassicRowGapPx(36, words)).toBe(73);
    });

    it('只有一行时算出来的行距不会影响渲染（flex-wrap 只在折行时用 row-gap）', () => {
        // 单行不折行：容器只有一条 flex line，row-gap 不参与布局；这里只确认它不为负。
        expect(resolveClassicRowGapPx(36, [{ scale: 1.1, y: 0 }])).toBeGreaterThanOrEqual(0);
    });
});

// 下面的字宽 / 边距是照实测抄的：390 宽下 31 字行 12 个词合计 1731.7px、装 6 行；
// 24 字行合计 1266.5px、装 5 行（DENSITY_LADDER 那一版用真实 DOM 量过，贪心估行和浏览器完全一致）。
const makeWords = (count: number, width: number, marginRight: number): ClassicFitWord[] => (
    Array.from({ length: count }, () => ({ width, marginRight, scale: 1.2, y: 16 }))
);
/** 390 宽的竖屏：内容盒 min(390-64, 1152) = 326 宽、844 × 70% - 64 = 526.8 高。 */
const viewport390x844 = (words: ClassicFitWord[]): ClassicFitInput => ({
    baseFontPx: 36,
    availableWidth: 326,
    availableHeight: 526.8,
    words,
});
/** 360 宽的竖屏：326 → 296 宽、640 × 70% - 64 = 384 高。 */
const viewport360x640 = (words: ClassicFitWord[]): ClassicFitInput => ({
    baseFontPx: 36,
    availableWidth: 296,
    availableHeight: 384,
    words,
});

describe('resolveClassicFontDensity（放不下就降一档字号）', () => {
    it('短句不折行时永远是原字号档位 1', () => {
        const shortLine = makeWords(3, 36, 12.8);
        [viewport390x844(shortLine), viewport360x640(shortLine)].forEach((input) => {
            expect(measureClassicBlock(input, 1).rows).toBe(1);
            expect(resolveClassicFontDensity(input)).toBe(1);
        });
    });

    it('390×844 的 24 字行（5 行）放得下，保持原字号档位 1', () => {
        const input = viewport390x844(makeWords(10, 80, 46.5));
        expect(measureClassicBlock(input, 1).rows).toBe(5);
        expect(resolveClassicFontDensity(input)).toBe(1);
    });

    it('放不下时选最大的、放得下的那一档：档位越大越放不下就选它下一档', () => {
        const words = makeWords(12, 92, 52);
        // 从「只够一行」到「绰绰有余」扫一遍可用高度。
        [80, 120, 200, 260, 300, 340, 400, 460, 520, 600, 700].forEach((availableHeight) => {
            const input: ClassicFitInput = { baseFontPx: 36, availableWidth: 326, availableHeight, words };
            const density = resolveClassicFontDensity(input);
            const chosenIndex = CLASSIC_DENSITY_LADDER.indexOf(density);
            const chosen = measureClassicBlock(input, density);

            if (chosenIndex > 0) {
                // 选了这一档，说明比它大一档一定放不下（否则就该选大的那档）。
                const larger = measureClassicBlock(input, CLASSIC_DENSITY_LADDER[chosenIndex - 1]);
                expect(larger.height).toBeGreaterThan(availableHeight);
            }
            // 除非已经是最小档，选中的这一档必须真的放得下。
            if (chosenIndex < CLASSIC_DENSITY_LADDER.length - 1) {
                expect(chosen.height).toBeLessThanOrEqual(availableHeight);
            }
        });
    });

    it('可用高度越大（或越宽），选到的档位只会更大，不会更小', () => {
        const words = makeWords(12, 92, 52);
        const heights = [120, 200, 300, 400, 520, 640, 800];
        const densities = heights.map((availableHeight) => (
            resolveClassicFontDensity({ baseFontPx: 36, availableWidth: 326, availableHeight, words })
        ));
        densities.forEach((density, index) => {
            if (index > 0) {
                expect(density).toBeGreaterThanOrEqual(densities[index - 1]);
            }
        });
        // 越宽就越少折行，档位同样只能变大。
        const wide = resolveClassicFontDensity({ baseFontPx: 36, availableWidth: 900, availableHeight: 300, words });
        const narrow = resolveClassicFontDensity({ baseFontPx: 36, availableWidth: 296, availableHeight: 300, words });
        expect(wide).toBeGreaterThanOrEqual(narrow);
    });

    it('一档都放不下时退到最小档，不会返回比档位表更小的值', () => {
        const input: ClassicFitInput = { baseFontPx: 36, availableWidth: 120, availableHeight: 40, words: makeWords(12, 92, 52) };
        expect(resolveClassicFontDensity(input)).toBe(CLASSIC_DENSITY_LADDER[CLASSIC_DENSITY_LADDER.length - 1]);
    });

    it('实测那两档：390×844 的 31 字行要降档，360×640 降得更多', () => {
        const words = makeWords(12, 92, 52);
        const density390 = resolveClassicFontDensity(viewport390x844(words));
        const density360 = resolveClassicFontDensity(viewport360x640(words));
        expect(density390).toBeLessThan(1);
        expect(density360).toBeLessThanOrEqual(density390);
    });

    it('空词表或非法输入不降档', () => {
        expect(resolveClassicFontDensity({ baseFontPx: 36, availableWidth: 326, availableHeight: 300, words: [] })).toBe(1);
        expect(resolveClassicFontDensity({ baseFontPx: 0, availableWidth: 326, availableHeight: 300, words: makeWords(4, 92, 52) })).toBe(1);
        expect(resolveClassicFontDensity({ baseFontPx: 36, availableWidth: 326, availableHeight: Number.NaN, words: makeWords(4, 92, 52) })).toBe(1);
    });
});
