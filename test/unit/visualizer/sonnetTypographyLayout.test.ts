import { describe, expect, it } from 'vitest';
import type { SonnetSemanticSegment } from '@/components/visualizer/sonnet/types';
import {
    findSonnetHeroSegmentIndex,
    findSonnetSemiHeroSegmentIndex,
    findSonnetSemiHeroSegmentIndices,
    isSonnetEmphasisRole,
    isSonnetLayoutSegment,
    resolveSonnetTypographyLayout,
} from '@/components/visualizer/sonnet/sonnetTypographyLayout';
import {
    layoutSonnetPosterBlocks,
    type SonnetPosterBlockBox,
} from '@/components/visualizer/sonnet/sonnetPosterBlocksLayout';

// test/unit/visualizer/sonnetTypographyLayout.test.ts
// Locks the semantic hero/support hierarchy and true stacked Japanese typography.
const segment = (text: string, isWordLike = true): SonnetSemanticSegment => ({
    text,
    startOffset: 0,
    endOffset: text.length,
    startTime: 0,
    endTime: 1,
    wordIndices: [],
    graphemes: Array.from(text, (char, index) => ({
        char,
        startTime: index / text.length,
        endTime: (index + 1) / text.length,
    })),
    isWordLike,
});

describe('Sonnet typography layout', () => {
    const segments = [segment('明かり'), segment('に', false), segment('あなたへ')];

    it('chooses one semantic hero deterministically', () => {
        expect(findSonnetHeroSegmentIndex(segments)).toBe(2);
        expect(findSonnetHeroSegmentIndex(segments))
            .toBe(findSonnetHeroSegmentIndex(segments));
    });

    it('adds one smaller semi-hero when a long leading block precedes the hero', () => {
        const longSentence = [
            segment('在'),
            segment('漫长'),
            segment('句子'),
            segment('前部重点'),
            segment('仍然'),
            segment('不断'),
            segment('延伸'),
            segment('最终的核心词语'),
        ];
        const heroIndex = findSonnetHeroSegmentIndex(longSentence);
        const semiHeroIndex = findSonnetSemiHeroSegmentIndex(longSentence, heroIndex);
        const layout = resolveSonnetTypographyLayout({
            lines: [longSentence],
            shotKind: 'type-impact',
            paragraphKind: 'chorus',
            width: 1280,
            height: 720,
            baseFontSize: 40,
            fontFamily: 'sans-serif',
            fontWeight: 700,
        }).filter(item => item.role !== 'decoration');
        const hero = layout.find(item => item.role === 'hero')!;
        const semiHero = layout.find(item => item.role === 'semi-hero')!;
        const supports = layout.filter(item => item.role === 'support');

        expect(heroIndex).toBe(7);
        expect(semiHeroIndex).toBe(3);
        expect(semiHero.segmentIndex).toBe(semiHeroIndex);
        expect(semiHero.fontScale).toBeLessThan(hero.fontScale);
        expect(semiHero.fontScale).toBeGreaterThan(Math.max(...supports.map(item => item.fontScale)));
        expect(isSonnetEmphasisRole(semiHero.role)).toBe(true);
    });

    it('does not add a semi-hero for a short leading block', () => {
        const shortSentence = [
            segment('一'), segment('二'), segment('三'), segment('四'), segment('五'), segment('核心词语'),
        ];
        const heroIndex = findSonnetHeroSegmentIndex(shortSentence);
        expect(findSonnetSemiHeroSegmentIndex(shortSentence, heroIndex)).toBe(-1);
        expect(resolveSonnetTypographyLayout({
            lines: [shortSentence],
            shotKind: 'type-impact',
            paragraphKind: 'chorus',
            width: 1280,
            height: 720,
            baseFontSize: 40,
            fontFamily: 'sans-serif',
            fontWeight: 700,
        }).some(item => item.role === 'semi-hero')).toBe(false);
    });

    it('keeps semi-hero selection local to each long line in a grouped shot', () => {
        const longLine = [
            segment('很'), segment('长'), segment('的'), segment('前部重点'),
            segment('还'), segment('在'), segment('继续'), segment('最终核心词语'),
        ];
        const layout = resolveSonnetTypographyLayout({
            lines: [longLine, [segment('下一句'), segment('核心')]],
            shotKind: 'fragment-collage',
            paragraphKind: 'verse',
            width: 1280,
            height: 720,
            baseFontSize: 40,
            fontFamily: 'sans-serif',
            fontWeight: 700,
        }).filter(item => item.role !== 'decoration');

        expect(layout.filter(item => item.role === 'semi-hero')).toHaveLength(1);
        expect(layout.find(item => item.role === 'semi-hero')!.segmentIndex).toBe(3);
        expect(layout.filter(item => item.role === 'hero')).toHaveLength(2);
    });

    it('stacks the hero by grapheme and keeps support text small', () => {
        const layout = resolveSonnetTypographyLayout({
            lines: [segments],
            shotKind: 'editorial-column',
            paragraphKind: 'verse',
            width: 1280,
            height: 720,
            baseFontSize: 40,
            fontFamily: 'sans-serif',
            fontWeight: 700,
        });
        const hero = layout.find(item => item.role === 'hero')!;
        const supports = layout.filter(item => item.role === 'support');
        const textPlacements = layout.filter(item => item.role !== 'decoration');

        expect(hero.displayText).toBe('あ\nな\nた\nへ');
        expect(supports.every(item => item.fontScale < hero.fontScale)).toBe(true);
        expect(textPlacements.map(item => item.timingPhase)).toEqual([0, 0.5, 1]);
        expect(supports[0].x).toBeLessThan(supports[1].x);
    });

    it('changes composition across templates without changing segment order', () => {
        const impact = resolveSonnetTypographyLayout({
            lines: [segments],
            shotKind: 'type-impact',
            paragraphKind: 'chorus',
            width: 1280,
            height: 720,
            baseFontSize: 40,
            fontFamily: 'sans-serif',
            fontWeight: 700,
        });
        const quiet = resolveSonnetTypographyLayout({
            lines: [segments],
            shotKind: 'quiet-tableau',
            paragraphKind: 'outro',
            width: 1280,
            height: 720,
            baseFontSize: 40,
            fontFamily: 'sans-serif',
            fontWeight: 700,
        });

        expect(impact.filter(item => item.role !== 'decoration').map(item => item.role))
            .toEqual(quiet.map(item => item.role));
        expect(impact.find(item => item.role === 'hero')!.fontScale)
            .toBeGreaterThan(quiet.find(item => item.role === 'hero')!.fontScale);
    });

    it('uses semantic duration and timing order instead of seeded scatter', () => {
        const timed = [
            { ...segment('短'), startTime: 0, endTime: 0.3 },
            { ...segment('持续的主词'), startTime: 0.4, endTime: 2.2 },
            { ...segment('尾'), startTime: 2.3, endTime: 2.6 },
        ];
        const layout = resolveSonnetTypographyLayout({
            lines: [timed],
            shotKind: 'fragment-collage',
            paragraphKind: 'verse',
            width: 1280,
            height: 720,
            baseFontSize: 40,
            fontFamily: 'sans-serif',
            fontWeight: 700,
        });

        expect(findSonnetHeroSegmentIndex(timed)).toBe(1);
        const textPlacements = layout.filter(item => item.role !== 'decoration');
        expect(textPlacements.map(item => item.timingPhase)).toEqual([0, 0.5, 1]);
        expect(textPlacements.map(item => item.segmentIndex)).toEqual([0, 1, 2]);
    });

    it('tracks the segment flow direction independently from glyph writing direction', () => {
        const words = ['愛', 'を', '懐', 'い', 'て', '理想', 'を', '号', 'ん', 'だ'].map(text => segment(text));
        const layout = resolveSonnetTypographyLayout({
            lines: [words],
            shotKind: 'type-impact',
            paragraphKind: 'chorus',
            width: 1280,
            height: 720,
            baseFontSize: 40,
            fontFamily: 'sans-serif',
            fontWeight: 700,
        }).filter(item => item.role !== 'decoration');

        expect(layout.filter(item => [0, 1, 8, 9].includes(item.segmentIndex))
            .every(item => item.layoutDirection === 'vertical')).toBe(true);
        expect(layout.filter(item => [2, 3, 4, 6, 7].includes(item.segmentIndex))
            .every(item => item.layoutDirection === 'horizontal')).toBe(true);

        const bySegmentIndex = new Map(layout.map(item => [item.segmentIndex, item]));
        expect(Math.abs(bySegmentIndex.get(0)!.y - bySegmentIndex.get(1)!.y)).toBeGreaterThanOrEqual(96);
        expect(Math.abs(bySegmentIndex.get(8)!.y - bySegmentIndex.get(9)!.y)).toBeGreaterThanOrEqual(96);
    });

    it('keeps a visible gap in the compact centered vertical stack', () => {
        const layout = resolveSonnetTypographyLayout({
            lines: [[segment('傷'), segment('付け'), segment('合う')]],
            shotKind: 'quiet-tableau',
            paragraphKind: 'breath',
            width: 1280,
            height: 720,
            baseFontSize: 40,
            fontFamily: 'sans-serif',
            fontWeight: 700,
        });
        const hero = layout.find(item => item.role === 'hero')!;
        const supports = layout.filter(item => item.role === 'support');

        expect(supports.every(item => Math.abs(item.y - hero.y) >= 122.4)).toBe(true);
    });

    it('excludes whitespace-only semantic segments from scene layout', () => {
        expect(['a', ' ', 'bit'].map(text => segment(text, text !== ' ')).filter(isSonnetLayoutSegment)
            .map(item => item.text)).toEqual(['a', 'bit']);
    });

    it('measures a vertical non-CJK word as a rotated horizontal block', () => {
        const words = [segment('a'), segment('café'), segment('c')];
        const layout = resolveSonnetTypographyLayout({
            lines: [words],
            shotKind: 'quiet-tableau',
            paragraphKind: 'breath',
            width: 1280,
            height: 720,
            baseFontSize: 40,
            fontFamily: 'sans-serif',
            fontWeight: 700,
        }).filter(item => item.role !== 'decoration');
        const word = layout.find(item => item.segmentIndex === 1)!;

        expect(word.vertical).toBe(false);
        expect(word.rotation).toBeCloseTo(Math.PI / 2);
        expect(Math.abs(layout[0].y - word.y)).toBeLessThan(300);
    });

    it('builds poster blocks from measured text while retaining semantic hierarchy', () => {
        const words = [
            segment('沿着'), segment('漫长'), segment('叙事'), segment('半主视觉'),
            segment('继续'), segment('抵达'), segment('最终的英雄文字'), segment('之后'),
        ];
        const layout = resolveSonnetTypographyLayout({
            lines: [words],
            shotKind: 'poster-blocks',
            paragraphKind: 'verse',
            width: 1280,
            height: 720,
            baseFontSize: 40,
            fontFamily: 'sans-serif',
            fontWeight: 700,
        });
        const hero = layout.find(item => item.role === 'hero')!;
        const semiHero = layout.find(item => item.role === 'semi-hero')!;
        const supports = layout.filter(item => item.role === 'support');

        expect(layout).toHaveLength(words.length);
        expect(layout.every(item => item.layoutDirection === 'horizontal' && item.rotation === 0)).toBe(true);
        expect(layout.every(item => Number.isFinite(item.x) && Number.isFinite(item.y))).toBe(true);
        expect(hero.fontScale).toBeGreaterThan(semiHero.fontScale);
        expect(semiHero.fontScale).toBeGreaterThan(Math.max(...supports.map(item => item.fontScale)));
        // Supports never grow beyond their role size; global fitting only shrinks.
        expect(supports.every(item => item.fontScale <= 1.15 + 1e-6)).toBe(true);
    });

    it('picks a semi-hero after the hero when the hero leans early', () => {
        const words = [
            segment('核心词语'), segment('接着'), segment('继续'),
            segment('次要重点'), segment('还有'), segment('尾巴'),
        ];
        const heroIndex = findSonnetHeroSegmentIndex(words);
        expect(heroIndex).toBe(0);
        expect(findSonnetSemiHeroSegmentIndices(words, heroIndex)).toEqual([3]);
    });

    it('picks two semi-heroes on both sides of the hero in long lines', () => {
        const words = [
            segment('引子'), segment('主旋律'), segment('铺陈'), segment('展开'), segment('推进'),
            segment('英雄核心'), segment('过渡'), segment('余韵'), segment('副重点'), segment('收尾'),
        ];
        const heroIndex = findSonnetHeroSegmentIndex(words);
        expect(heroIndex).toBe(5);
        expect(findSonnetSemiHeroSegmentIndices(words, heroIndex)).toEqual([1, 8]);
    });

    it('never promotes particles or single glyphs to semi-hero', () => {
        const particles = [segment('あ'), segment('い'), segment('う'), segment('核心')];
        const heroIndex = findSonnetHeroSegmentIndex(particles);
        expect(findSonnetSemiHeroSegmentIndices(particles, heroIndex)).toEqual([]);
    });
});

describe('Sonnet poster blocks zone flow', () => {
    const posterBox = (partial: Partial<SonnetPosterBlockBox>): SonnetPosterBlockBox => ({
        isHero: false,
        isSemiHero: false,
        displayText: '詞',
        fontScale: 1.15,
        measuredWidth: 60,
        measuredHeight: 46,
        x: 0,
        y: 0,
        rotation: 0,
        vertical: false,
        layoutDirection: 'horizontal',
        enterX: 0,
        enterY: 0,
        ...partial,
    });

    const verticalDims = {
        verticalDisplayText: '詞',
        verticalMeasuredWidth: 46,
        verticalMeasuredHeight: 60,
        verticalFontScale: 1.15,
    };

    const buildBoxes = () => [
        posterBox({ displayText: '旅' }),
        posterBox({ displayText: 'は' }),
        posterBox({ displayText: '英雄', isHero: true, fontScale: 4.4, measuredWidth: 400, measuredHeight: 150 }),
        posterBox({ displayText: '副題', isSemiHero: true, fontScale: 3.2, measuredWidth: 200, measuredHeight: 100 }),
        posterBox({ displayText: '続く' }),
        posterBox({ displayText: '言葉' }),
        posterBox({ displayText: '粒々' }),
        posterBox({ displayText: '終わり' }),
    ];

    const rectOf = (box: SonnetPosterBlockBox) => ({
        left: box.x - box.measuredWidth / 2,
        right: box.x + box.measuredWidth / 2,
        top: box.y - box.measuredHeight / 2,
        bottom: box.y + box.measuredHeight / 2,
    });

    it('keeps horizontal zones spread out with gaps and strict reading order', () => {
        const boxes = buildBoxes();
        const { gap } = layoutSonnetPosterBlocks(boxes, 1280, 720, 40, 2);
        const rects = boxes.map(rectOf);

        boxes.forEach(box => {
            expect(box.layoutDirection).toBe('horizontal');
            expect(box.vertical).toBe(false);
        });
        const hero = boxes.find(box => box.isHero)!;
        const semi = boxes.find(box => box.isSemiHero)!;
        const supports = boxes.filter(box => !box.isHero && !box.isSemiHero);
        expect(hero.fontScale).toBeGreaterThan(semi.fontScale);
        expect(semi.fontScale).toBeGreaterThan(Math.max(...supports.map(box => box.fontScale)));
        expect(supports.every(box => box.fontScale <= 1.15 + 1e-6)).toBe(true);

        for (let i = 0; i < rects.length; i++) {
            for (let j = i + 1; j < rects.length; j++) {
                const dx = Math.max(rects[i].left - rects[j].right, rects[j].left - rects[i].right);
                const dy = Math.max(rects[i].top - rects[j].bottom, rects[j].top - rects[i].bottom);
                expect(Math.max(dx, dy)).toBeGreaterThanOrEqual(gap * 0.98);
            }
        }
        // Reading order: earlier segments sit on an earlier line, or further left on the same line.
        for (let i = 0; i < rects.length - 1; i++) {
            const sameLine = Math.abs(rects[i].top - rects[i + 1].top) <= 1;
            if (sameLine) expect(rects[i].left).toBeLessThanOrEqual(rects[i + 1].left + 1);
            else expect(rects[i].top).toBeLessThanOrEqual(rects[i + 1].top + 1);
        }
    });

    it('flows vertical columns right-to-left while preserving reading order', () => {
        const boxes = buildBoxes().map(box => ({ ...box, ...verticalDims }));
        layoutSonnetPosterBlocks(boxes, 1280, 720, 40, 3);

        boxes.forEach(box => {
            expect(box.layoutDirection).toBe('vertical');
            expect(box.vertical).toBe(true);
        });
        const rects = boxes.map(rectOf);
        for (let i = 0; i < rects.length; i++) {
            for (let j = i + 1; j < rects.length; j++) {
                const dx = Math.max(rects[i].left - rects[j].right, rects[j].left - rects[i].right);
                const dy = Math.max(rects[i].top - rects[j].bottom, rects[j].top - rects[i].bottom);
                expect(Math.max(dx, dy)).toBeGreaterThan(0);
            }
        }
        // Japanese vertical reading order: earlier columns sit further right,
        // earlier segments within a column sit higher.
        for (let i = 0; i < rects.length - 1; i++) {
            const sameColumn = Math.abs(rects[i].right - rects[i + 1].right) <= 1;
            if (sameColumn) expect(rects[i].top).toBeLessThanOrEqual(rects[i + 1].top + 1);
            else expect(rects[i].right).toBeGreaterThanOrEqual(rects[i + 1].right - 1);
        }
    });

    it('centers a lone hero zone when the shot has no supports', () => {
        const boxes = [
            posterBox({ displayText: '英雄', isHero: true, fontScale: 4.4, measuredWidth: 400, measuredHeight: 150 }),
        ];
        layoutSonnetPosterBlocks(boxes, 1280, 720, 40, 2);
        expect(Math.abs(boxes[0].x)).toBeLessThan(1);
    });
});
