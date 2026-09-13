import { describe, expect, it } from 'vitest';
import {
    collectionMorphFlyIn,
    collectionMorphReach,
    collectionMorphRectSeed,
    collectionMorphSeed,
    estimateCenterTarget,
    flipFromRect,
    flipTo,
    isNearViewportCenter,
    toMorphTarget,
    type CollectionMorphRect,
} from '@/components/collectionOpenMorph/morphGeometry';

// test/unit/collectionOpenMorph/morphGeometry.test.ts
// 移形换影的几何部分。这些公式之前散在三处（overlay / GridView / ArtistGridView），
// 每处各写一遍，所以「飞到哪里」这件事一直没有被任何测试约束过。

const rect = (x: number, y: number, width: number, height: number): CollectionMorphRect => ({ x, y, width, height });

describe('flipTo', () => {
    it('moves the centre and scales by the size ratio', () => {
        const flip = flipTo(rect(0, 0, 100, 100), rect(300, 200, 200, 50));
        // 中心 (50,50) → (400,225)
        expect(flip.x).toBe(350);
        expect(flip.y).toBe(175);
        expect(flip.scaleX).toBe(2);
        expect(flip.scaleY).toBe(0.5);
    });

    it('renders the start rect exactly onto the target rect', () => {
        const start = rect(20, 40, 120, 90);
        const target = rect(500, 300, 60, 45);
        const flip = flipTo(start, target);
        // 元素渲染在 start，加上 transform 之后的实际盒应该等于 target。
        const renderedCenterX = start.x + start.width / 2 + flip.x;
        const renderedCenterY = start.y + start.height / 2 + flip.y;
        const renderedWidth = start.width * flip.scaleX;
        const renderedHeight = start.height * flip.scaleY;
        expect(renderedWidth).toBeCloseTo(target.width, 6);
        expect(renderedHeight).toBeCloseTo(target.height, 6);
        expect(renderedCenterX).toBeCloseTo(target.x + target.width / 2, 6);
        expect(renderedCenterY).toBeCloseTo(target.y + target.height / 2, 6);
    });

    it('leaves the scale alone for a degenerate start rect', () => {
        expect(flipTo(rect(0, 0, 0, 0), rect(10, 10, 50, 50))).toMatchObject({ scaleX: 1, scaleY: 1 });
    });
});

describe('flipFromRect', () => {
    // 快进时用 flipFromRect(当前屏幕矩形, 基准矩形) 从半途接着播；它和 flipTo 是同一个映射，
    // 只是参数顺序相反。两者一旦分叉，快进就会跳一下。
    it('is flipTo with the arguments swapped', () => {
        const pairs: Array<[CollectionMorphRect, CollectionMorphRect]> = [
            [rect(0, 0, 100, 100), rect(300, 200, 200, 50)],
            [rect(-40, 12, 33, 77), rect(9, 9, 33, 77)],
            [rect(5, 5, 1, 1), rect(5, 5, 1, 1)],
        ];
        for (const [a, b] of pairs) {
            expect(flipFromRect(b, a)).toEqual(flipTo(a, b));
        }
    });
});

describe('estimateCenterTarget', () => {
    it('sits on the viewport centre and is sized within the documented clamp', () => {
        for (const viewport of [{ width: 1440, height: 1100 }, { width: 800, height: 600 }, { width: 3840, height: 2160 }]) {
            const target = estimateCenterTarget(viewport);
            expect(target.x + target.width / 2).toBeCloseTo(viewport.width / 2, 6);
            expect(target.y + target.height / 2).toBeCloseTo(viewport.height / 2, 6);
            expect(target.width).toBeGreaterThanOrEqual(160);
            expect(target.width).toBeLessThanOrEqual(280);
            expect(target.height / target.width).toBeCloseTo(1.16, 6);
        }
    });
});

describe('isNearViewportCenter', () => {
    const viewport = { width: 1000, height: 800 };

    it('counts a centred card and rejects one beyond the exclusion radius', () => {
        expect(isNearViewportCenter(rect(400, 300, 200, 200), viewport)).toBe(true);
        expect(isNearViewportCenter(rect(0, 0, 100, 100), viewport)).toBe(false);
    });

    it('keeps the strict 100px boundary the scatter relies on', () => {
        // 中心正好偏 99px：算 hero；偏 101px：算可四散的卡片。
        expect(isNearViewportCenter(rect(500 - 50 + 99, 400 - 50, 100, 100), viewport)).toBe(true);
        expect(isNearViewportCenter(rect(500 - 50 + 101, 400 - 50, 100, 100), viewport)).toBe(false);
    });
});

describe('collectionMorphSeed', () => {
    it('is deterministic and stays in [0, 1)', () => {
        for (const key of ['song-1', 'song-2', '', '曲目', 'a'.repeat(200)]) {
            const first = collectionMorphSeed(key);
            expect(collectionMorphSeed(key)).toBe(first);
            expect(first).toBeGreaterThanOrEqual(0);
            expect(first).toBeLessThan(1);
        }
    });

    it('spreads different ids apart instead of collapsing them', () => {
        const seeds = new Set(Array.from({ length: 40 }, (_, i) => collectionMorphSeed(`track-${i}`)));
        expect(seeds.size).toBeGreaterThan(35);
    });
});

describe('collectionMorphRectSeed', () => {
    it('is stable for the same rect and unsigned for the rotate/sign derivations', () => {
        const seed = collectionMorphRectSeed(rect(120.4, 33.6, 200, 200));
        expect(collectionMorphRectSeed(rect(120.4, 33.6, 200, 200))).toBe(seed);
        expect(seed).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(seed)).toBe(true);
    });
});

describe('collectionMorphFlyIn', () => {
    const origin = { x: 0, y: 0 };
    const flyIn = (card: { x: number; y: number }, spacing = 100, reach = 900) => (
        collectionMorphFlyIn(card, origin, spacing, reach, collectionMorphSeed(`card-${card.x}-${card.y}`))
    );

    it('pushes the card radially outward by exactly the reach', () => {
        const card = { x: 300, y: 400 };
        const result = flyIn(card);
        expect(Math.hypot(result.x, result.y)).toBeCloseTo(900, 6);
        // 方向沿着 origin → card 的径向。
        expect(result.x / result.y).toBeCloseTo(300 / 400, 6);
    });

    it('falls back to straight up for a card sitting on the origin', () => {
        const result = collectionMorphFlyIn({ x: 0, y: 0 }, origin, 100, 900, 0.5);
        expect(result.x).toBe(0);
        expect(result.y).toBe(-900);
    });

    it('keeps the tilt inside ±3.2° and the delay inside its window', () => {
        for (let x = -3; x <= 3; x += 1) {
            for (let y = -3; y <= 3; y += 1) {
                const result = flyIn({ x: x * 300, y: y * 300 });
                expect(Math.abs(result.rotate)).toBeLessThanOrEqual(3.2 + 1e-9);
                expect(result.delay).toBeGreaterThanOrEqual(0.04);
                expect(result.delay).toBeLessThanOrEqual(0.46);
            }
        }
    });

    it('starts nearer cards earlier than far ones with the same seed', () => {
        const near = collectionMorphFlyIn({ x: 50, y: 0 }, origin, 100, 900, 0.5);
        const far = collectionMorphFlyIn({ x: 5000, y: 0 }, origin, 100, 900, 0.5);
        expect(near.delay).toBeLessThan(far.delay);
    });
});

describe('collectionMorphReach', () => {
    it('scales with the viewport and stays beyond the diagonal', () => {
        const small = collectionMorphReach(800, 600);
        const large = collectionMorphReach(1920, 1080);
        expect(small).toBeGreaterThan(Math.hypot(800, 600) * 0.62);
        expect(large).toBeGreaterThan(small);
    });
});

describe('toMorphTarget', () => {
    it('falls back to the frame when the capture had no title line', () => {
        const frame = rect(10, 20, 30, 40);
        const target = toMorphTarget({ frame, cover: frame, coverUrl: null, title: null, titleText: 'Song' });
        expect(target.title).toBe(frame);
        expect(target.titleText).toBe('Song');
    });

    it('keeps a measured title rect as is', () => {
        const frame = rect(10, 20, 30, 40);
        const title = rect(12, 50, 26, 8);
        expect(toMorphTarget({ frame, cover: frame, coverUrl: null, title, titleText: '' }).title).toBe(title);
    });
});
