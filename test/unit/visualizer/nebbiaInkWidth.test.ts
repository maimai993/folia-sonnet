import { describe, expect, it } from 'vitest';
import { INK_MIN_CSS_PX, inkThinFactor, nebbiaInkWidth } from '@/components/visualizer/nebbia/nebbiaInkWidth';

// test/unit/visualizer/nebbiaInkWidth.test.ts
// 笔画宽度的下限只防「细到看不见」，不能盖过用户设的宽度（#257：手机上把笔画粗细调到最细，
// 复杂字还是一整块，因为原来的下限是固定 8 像素，比滑块最大值还大）。

const px = (em: number, size: number) => em * size;

describe('nebbia ink width', () => {
    it('thins dense glyphs and keeps sparse ones as they are', () => {
        expect(inkThinFactor(9)).toBeCloseTo(1);
        expect(inkThinFactor(4)).toBe(1);
        expect(inkThinFactor(36)).toBeCloseTo(0.55);
        expect(inkThinFactor(0)).toBe(1);
    });

    it('lets the user\'s width win on a small glyph at the thin end (the #257 case)', () => {
        // 32px 的密字，用户调到最细 0.04
        const width = nebbiaInkWidth(0.04, 32, 24);
        const cssPx = px(width, 32);
        // 最细那一端必须明显细于滑块最大值，而不是被下限顶死
        expect(cssPx).toBeLessThan(px(nebbiaInkWidth(0.16, 32, 24), 32));
        // 且细到接近可见下限，不再是 8 像素那种一整块
        expect(cssPx).toBeLessThanOrEqual(INK_MIN_CSS_PX + 0.01);
    });

    it('scales monotonically with the setting at every size', () => {
        for (const size of [20, 32, 48, 96]) {
            let previous = 0;
            for (const setting of [0.04, 0.06, 0.09, 0.12, 0.16]) {
                const cssPx = px(nebbiaInkWidth(setting, size, 16), size);
                expect(cssPx).toBeGreaterThanOrEqual(previous - 1e-9);
                previous = cssPx;
            }
        }
    });

    it('never goes below the visibility floor', () => {
        for (const size of [12, 20, 32, 64]) {
            const cssPx = px(nebbiaInkWidth(0.001, size, 40), size);
            expect(cssPx).toBeGreaterThanOrEqual(INK_MIN_CSS_PX - 1e-9);
        }
    });

    it('a thin setting is visibly thinner than a thick one on a phone-sized glyph', () => {
        const thin = px(nebbiaInkWidth(0.04, 40, 18), 40);
        const thick = px(nebbiaInkWidth(0.16, 40, 18), 40);
        expect(thick / thin).toBeGreaterThan(2.5);
    });
});
