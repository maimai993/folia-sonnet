import { describe, expect, it } from 'vitest';
import { Line, Word } from '@/types';
import { DEFAULT_THEME } from '@/services/baseThemes';
import { DEFAULT_KINETIC_TUNING, resolveKineticTuning, type KineticTuning } from '@/components/visualizer/kinetic/types';
import {
    buildKineticViewport,
    buildKineticLayout,
    buildKineticLayoutCacheKey,
    type KineticLayout,
} from '@/components/visualizer/kinetic/kineticLayout';

// test/unit/visualizer/kineticLayout.test.ts
// 文字PV 布局的量测断言：任何 tuning 档位下字与字 0 重叠、行与行 0 重叠、横向不出界；
// tuning 的每个参数改动都带来可量测的布局变化，防「面板摆设」。

const makeLine = (text: string): Line => {
    const chars = Array.from(text);
    const step = 3 / chars.length;
    const words: Word[] = chars.map((char, index) => ({
        text: char,
        startTime: index * step,
        endTime: (index + 1) * step,
    }));
    return {
        id: 'line-0',
        words,
        startTime: 0,
        endTime: 2.9,
        fullText: text,
        translation: '',
        isChorus: false,
    };
};

/** 无 canvas 的单测环境退回按字素的粗估，与渲染侧同一份 estimate 逻辑（partitaTextWidth 内置）。 */
const VIEWPORTS = [
    { width: 360, height: 640, fontScale: 1 },
    { width: 390, height: 844, fontScale: 1.4 },
    { width: 1440, height: 900, fontScale: 1 },
];

const buildFor = (text: string, viewport: (typeof VIEWPORTS)[number], tuning: KineticTuning): KineticLayout => {
    const line = makeLine(text);
    const kineticViewport = buildKineticViewport(viewport.width, viewport.height, viewport.fontScale, DEFAULT_THEME);
    return buildKineticLayout(line, DEFAULT_THEME, kineticViewport, tuning);
};

interface Span { start: number; end: number }

const overlaps = (a: Span, b: Span) => Math.min(a.end, b.end) - Math.max(a.start, b.start) > 0.5;

describe('kinetic 布局', () => {
    // 24 与 31 字的中文行，三档视口（README 布局自检的同一组输入）。
    const LINES = [
        '迷惘在无边际这座幽深的森林里吹过星光',
        '我们慢慢走回去星河与风一起落在很远很远的地方把回忆折成纸船放进河流',
    ];

    it.each(VIEWPORTS.map((viewport, index) => [`${viewport.width}x${viewport.height}`, index, viewport]))
        ('%s 下字与字 0 重叠、行与行 0 重叠、横向不出界', (_label, _index, viewport) => {
            for (const text of LINES) {
                const layout = buildFor(text, viewport, DEFAULT_KINETIC_TUNING);
                expect(layout.rows.length).toBeGreaterThan(0);

                const charGap = layout.fontPx * 0.08;
                // 测量预算 = 视口 × 0.84（canvas 测量与 DOM 排版的余量），与实现一致。
                const halfBlock = (viewport.width * 0.84) / 2;

                layout.rows.forEach((row) => {
                    // 横向：行宽 + 偏移不出容器预算。
                    expect(row.width / 2 + Math.abs(row.offsetX)).toBeLessThanOrEqual(halfBlock + 1);

                    // 字与字：布局给每个字按峰值缩放留了位（width 含峰值），相邻字区间不重叠。
                    const spans: Span[] = [];
                    let cursor = -row.width / 2;
                    row.chars.forEach((char) => {
                        spans.push({ start: cursor, end: cursor + char.width });
                        cursor += char.width + charGap;
                    });
                    for (let i = 0; i < spans.length - 1; i++) {
                        expect(overlaps(spans[i], spans[i + 1])).toBe(false);
                    }
                });

                // 行与行：offsetY 区间（行高的一半）不重叠。
                for (let i = 0; i < layout.rows.length - 1; i++) {
                    const a = layout.rows[i];
                    const b = layout.rows[i + 1];
                    expect(overlaps(
                        { start: a.offsetY - a.height / 2, end: a.offsetY + a.height / 2 },
                        { start: b.offsetY - b.height / 2, end: b.offsetY + b.height / 2 },
                    )).toBe(false);
                }

                // 整块不出屏：块高不超过预算比例。
                expect(layout.totalHeight).toBeLessThanOrEqual(viewport.height * 0.72 + 1);
            }
        });

    it('放不下时按档位降字号，行数变多、字变小', () => {
        const viewport = VIEWPORTS[0];
        const longLine = '我们把整段很长很长的歌词放进一个很窄很窄的竖屏视口里看它怎么折行和降档';
        const layout = buildFor(longLine, viewport, DEFAULT_KINETIC_TUNING);
        const baseFontPx = buildKineticViewport(viewport.width, viewport.height, 1, DEFAULT_THEME).fontPx;
        expect(layout.fontPx).toBeLessThanOrEqual(baseFontPx);
        expect(layout.rows.length).toBeGreaterThan(1);
    });
});

describe('kinetic tuning 收敛', () => {
    it('越界与错型回默认，数值夹到范围内', () => {
        expect(resolveKineticTuning({ entrance: 'explode' as never }).entrance).toBe('pop');
        expect(resolveKineticTuning({ layout: 'spiral' as never }).layout).toBe('cascade');
        expect(resolveKineticTuning({ staggerScale: 99 }).staggerScale).toBe(2);
        expect(resolveKineticTuning({ staggerScale: -4 }).staggerScale).toBe(0);
        expect(resolveKineticTuning({ activeScale: Number.NaN }).activeScale).toBe(DEFAULT_KINETIC_TUNING.activeScale);
        expect(resolveKineticTuning({ cameraShake: '1' as never }).cameraShake).toBe(DEFAULT_KINETIC_TUNING.cameraShake);
        expect(resolveKineticTuning({})).toEqual(DEFAULT_KINETIC_TUNING);
    });
});

describe('kinetic tuning 每个参数都改变布局（防面板摆设）', () => {
    const text = '迷惘在无边际这座幽深的森林里吹过星光';
    const viewport = VIEWPORTS[1];

    it('layout 模式改变行偏移', () => {
        const cascade = buildFor(text, viewport, { ...DEFAULT_KINETIC_TUNING, layout: 'cascade' });
        const grid = buildFor(text, viewport, { ...DEFAULT_KINETIC_TUNING, layout: 'grid' });
        const block = buildFor(text, viewport, { ...DEFAULT_KINETIC_TUNING, layout: 'block' });
        const offsetsOf = (layout: KineticLayout) => layout.rows.map(row => row.offsetX);
        expect(offsetsOf(cascade)).not.toEqual(offsetsOf(block));
        expect(offsetsOf(grid)).not.toEqual(offsetsOf(block));
        expect(offsetsOf(block).every(offset => offset === 0)).toBe(true);
    });

    it('activeScale 峰值增大时字留位变宽', () => {
        const low = buildFor(text, viewport, { ...DEFAULT_KINETIC_TUNING, activeScale: 1 });
        const high = buildFor(text, viewport, { ...DEFAULT_KINETIC_TUNING, activeScale: 1.6 });
        const totalCharWidth = (layout: KineticLayout) => layout.rows.reduce((sum, row) => sum + row.chars.reduce((s, c) => s + c.width, 0), 0);
        expect(totalCharWidth(high)).toBeGreaterThan(totalCharWidth(low));
    });

    it('offsetAmplitude 影响阶梯幅度（block 除外），并保持行在屏内', () => {
        const zero = buildFor(text, viewport, { ...DEFAULT_KINETIC_TUNING, layout: 'cascade', offsetAmplitude: 0 });
        const large = buildFor(text, viewport, { ...DEFAULT_KINETIC_TUNING, layout: 'cascade', offsetAmplitude: 48 });
        const maxOffset = (layout: KineticLayout) => Math.max(...layout.rows.map(row => Math.abs(row.offsetX)));
        expect(maxOffset(zero)).toBe(0);
        expect(maxOffset(large)).toBeGreaterThanOrEqual(maxOffset(zero));
        const halfBlock = (viewport.width * 0.84) / 2;
        large.rows.forEach((row) => {
            expect(row.width / 2 + row.offsetX).toBeLessThanOrEqual(halfBlock + 1);
            expect(row.width / 2 - row.offsetX).toBeLessThanOrEqual(halfBlock + 1);
        });
    });

    it('entrance / 装饰开关不改变布局几何（动画与装饰是渲染层的职责）', () => {
        const base = buildFor(text, viewport, DEFAULT_KINETIC_TUNING);
        const alt = buildFor(text, viewport, {
            ...DEFAULT_KINETIC_TUNING,
            entrance: 'drop',
            showUnderline: false,
            showEcho: true,
            showStroke: true,
            cameraShake: 2,
        });
        expect(alt.rows.map(row => row.offsetX)).toEqual(base.rows.map(row => row.offsetX));
        expect(alt.totalHeight).toBe(base.totalHeight);
    });
});

describe('kinetic 布局缓存键', () => {
    it('文本、视口、字体与 tuning 参与键', () => {
        const viewportA = buildKineticViewport(390, 844, 1, DEFAULT_THEME);
        const line = makeLine('把回忆折成纸船放进河流');
        const keyA = buildKineticLayoutCacheKey(line, viewportA, DEFAULT_KINETIC_TUNING);
        expect(buildKineticLayoutCacheKey(line, viewportA, DEFAULT_KINETIC_TUNING)).toBe(keyA);
        expect(buildKineticLayoutCacheKey(makeLine('另一句歌词'), viewportA, DEFAULT_KINETIC_TUNING)).not.toBe(keyA);
        expect(buildKineticLayoutCacheKey(line, buildKineticViewport(360, 640, 1, DEFAULT_THEME), DEFAULT_KINETIC_TUNING)).not.toBe(keyA);
        expect(buildKineticLayoutCacheKey(line, viewportA, { ...DEFAULT_KINETIC_TUNING, layout: 'grid' })).not.toBe(keyA);
        expect(buildKineticLayoutCacheKey(line, viewportA, { ...DEFAULT_KINETIC_TUNING, activeScale: 1.4 })).not.toBe(keyA);
    });
});
