import { describe, expect, it } from 'vitest';
import {
    DEFAULT_LIBRARY_WALL_SEAM_DIRECTION,
    LIBRARY_WALL_PORTRAIT_QUERY,
    LIBRARY_WALL_SEAM_DIRECTIONS,
    isLibraryWallSeamDirection,
    normalizeLibraryWallSeamDirection,
    resolveLibraryWallSeamHorizontal,
} from '@/utils/libraryWallSeamDirection';

// test/unit/utils/libraryWallSeamDirection.test.ts
// bravais 信息条方向的取值规则：四个取值（自动 / 自动（反向）/ 竖向 / 横向）、默认自动（反向）、非法值回默认；
// 两个自动都只看视口形状（高 ≥ 宽 × 1.1），「自动（反向）」把结果反过来。

/** 按 CSS 的 max-aspect-ratio 语义算这条查询在某个视口上命不命中（宽 / 高 ≤ 比值）。 */
const matchesPortraitQuery = (width: number, height: number) => {
    const ratio = /max-aspect-ratio:\s*(\d+)\s*\/\s*(\d+)/.exec(LIBRARY_WALL_PORTRAIT_QUERY);
    if (!ratio) throw new Error('portrait query is not a max-aspect-ratio query');
    return width * Number(ratio[2]) <= height * Number(ratio[1]);
};

describe('libraryWallSeamDirection', () => {
    it('lists auto / auto-reverse / vertical / horizontal, defaults to the reversed automatic, normalizes anything else to it', () => {
        expect(LIBRARY_WALL_SEAM_DIRECTIONS).toEqual(['auto', 'auto-reverse', 'vertical', 'horizontal']);
        // 默认「自动（反向）」是 dev 定的观感（见 src/utils/libraryWallSeamDirection.ts 那条注释）。
        expect(DEFAULT_LIBRARY_WALL_SEAM_DIRECTION).toBe('auto-reverse');
        expect(LIBRARY_WALL_SEAM_DIRECTIONS.every(isLibraryWallSeamDirection)).toBe(true);
        expect(normalizeLibraryWallSeamDirection('vertical')).toBe('vertical');
        for (const value of [undefined, null, '', 'Horizontal', 'sideways', 'autoReverse', 1, true]) {
            expect(normalizeLibraryWallSeamDirection(value)).toBe('auto-reverse');
        }
    });

    it('opens rows on portrait screens when automatic, on landscape ones when reversed, and follows a fixed choice otherwise', () => {
        expect(resolveLibraryWallSeamHorizontal('auto', true)).toBe(true);
        expect(resolveLibraryWallSeamHorizontal('auto', false)).toBe(false);
        expect(resolveLibraryWallSeamHorizontal('auto-reverse', true)).toBe(false);
        expect(resolveLibraryWallSeamHorizontal('auto-reverse', false)).toBe(true);
        expect(resolveLibraryWallSeamHorizontal('horizontal', false)).toBe(true);
        expect(resolveLibraryWallSeamHorizontal('vertical', true)).toBe(false);
    });

    it('counts only clearly tall viewports as portrait, so near-square windows do not flip back and forth', () => {
        expect(matchesPortraitQuery(390, 844)).toBe(true);
        expect(matchesPortraitQuery(768, 1024)).toBe(true);
        expect(matchesPortraitQuery(1000, 1100)).toBe(true);
        expect(matchesPortraitQuery(1000, 1099)).toBe(false);
        expect(matchesPortraitQuery(900, 950)).toBe(false);
        expect(matchesPortraitQuery(1440, 900)).toBe(false);
        expect(matchesPortraitQuery(852, 393)).toBe(false);
    });
});
