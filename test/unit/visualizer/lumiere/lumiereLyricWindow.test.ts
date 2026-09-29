import { describe, expect, it, vi } from 'vitest';
import type { Line } from '@/types';
import { LUMIERE_PROFILES } from '@/components/visualizer/lumiere/catalog';
import type { LightSprites } from '@/components/visualizer/lumiere/light/sprites';
import { resolveLumierePalette } from '@/components/visualizer/lumiere/scene';
import { frameBand } from '@/components/visualizer/lumiere/text/lineWrap';
import { createLyricWindow, type WindowTypography } from '@/components/visualizer/lumiere/text/lyricWindow';
import { installFakeTextMeasure } from './lumiereFixtures';

// test/unit/visualizer/lumiere/lumiereLyricWindow.test.ts
// 歌词窗口的排版：当前行（含逐词字号差异、长句）落在画框里、长句先给地方再折行而不是缩成一小团，
// 邻行按实际宽高排开不重叠，位置只由时刻决定且换行时连续；以及绘光的调色（暗场底只在浅色背景时出现）。
// 用假的 Pixi、假的字形条与假的 OffscreenCanvas（给 pretext 量字）跑纯布局，不碰 canvas / WebGL。
vi.mock('@/components/visualizer/lumiere/text/glyphLine', async importOriginal => {
    const actual = await importOriginal<typeof import('@/components/visualizer/lumiere/text/glyphLine')>();
    return {
        ...actual,
        // 字形条：中日文一个字宽一个字号，拉丁字母 0.55 个字号，空格 0.3 个字号。
        buildGlyphLine: (_pixi: unknown, options: { text: string; fontPx: number; letterSpacing?: number }) => {
            const chars = Array.from(options.text);
            let x = 0;
            const glyphs = chars.map(char => {
                const upright = actual.isUprightGlyph(char);
                const width = options.fontPx * (char.trim() === '' ? 0.3 : upright ? 1 : 0.55) + options.fontPx * (options.letterSpacing ?? 0);
                const slice = { char, x, width, charX: x, charWidth: width, anchorX: 0.5, anchorY: 0.5, texture: {}, blank: char.trim() === '', upright };
                x += width;
                return slice;
            });
            return { text: options.text, fontPx: options.fontPx, width: x, height: options.fontPx * 1.5, glyphs, destroy: () => undefined };
        },
    };
});

/** 只实现歌词窗口用到的那一点 Pixi：容器树、精灵属性、Graphics 的链式画线。 */
class FakeContainer {
    children: unknown[] = [];
    visible = true;
    alpha = 1;
    rotation = 0;
    tint = 0xffffff;
    width = 0;
    height = 0;
    position = { x: 0, y: 0, set: (x: number, y: number) => { this.position.x = x; this.position.y = y; } };
    scale = { x: 1, y: 1, set: (x: number, y = x) => { this.scale.x = x; this.scale.y = y; } };
    anchor = { set: () => undefined };
    addChild(...items: unknown[]) { this.children.push(...items); return items[0]; }
    destroy() { this.children = []; }
}
class FakeSprite extends FakeContainer {
    constructor(public texture?: unknown) { super(); }
}
class FakeGraphics extends FakeContainer {
    clear() { return this; }
    moveTo() { return this; }
    lineTo() { return this; }
    stroke() { return this; }
}
const pixi = { Container: FakeContainer, Sprite: FakeSprite, Graphics: FakeGraphics } as unknown as typeof import('pixi.js');
installFakeTextMeasure();
const sprites = { dot: {}, star: {}, bokeh: {}, streak: {}, destroy: () => undefined } as unknown as LightSprites;

const WIDTH = 1600;
const HEIGHT = 900;
const aspect = WIDTH / HEIGHT;

/** 逐字时间：每个字 0.25 秒，一行一个词。 */
const line = (fullText: string, startTime: number): Line => {
    const chars = Array.from(fullText);
    return {
        fullText,
        startTime,
        endTime: startTime + chars.length * 0.25,
        words: chars.map((text, index) => ({ text, startTime: startTime + index * 0.25, endTime: startTime + (index + 1) * 0.25 })),
    };
};

const LINES = [
    line('光落在晨雾里', 2),
    line('我们慢慢走回去，星河与风一起落在很远很远的地方', 6),
    line('light falls through the haze again', 14),
    line('回去', 20),
    line('我把名字写进晨雾里', 24),
];

const buildWindow = (profileIndex: number, typography: WindowTypography, lines: Line[] = LINES, decay = 1, drift = 1) => {
    const profile = LUMIERE_PROFILES[profileIndex]!;
    const region = { cx: profile.region.cx * aspect, cy: profile.region.cy, w: profile.region.w * aspect, h: profile.region.h };
    const heroPx = profile.heroSize * HEIGHT;
    const window = createLyricWindow(pixi, {
        width: WIDTH,
        height: HEIGHT,
        lines,
        font: 'sans-serif',
        weight: 500,
        resolution: 1,
        region,
        heroPx,
        neighbors: 2,
        typography,
        decay: { strength: decay, delay: 1 },
        drift,
        seed: `window:${profile.kind}`,
        sprites,
        letterSpacing: 0.04,
    });
    return { window, region, heroPx };
};

/** 某行所有可见字的包围盒（像素，字心 ± 半个字号）。 */
const lineBox = (window: ReturnType<typeof buildWindow>['window'], lineIndex: number, time: number) => {
    const glyphs = window.glyphTimes(lineIndex).map(({ glyphIndex }) => window.glyphAnchor(lineIndex, glyphIndex, time));
    return {
        left: Math.min(...glyphs.map(g => g.x - g.fontPx / 2)),
        right: Math.max(...glyphs.map(g => g.x + g.fontPx / 2)),
        top: Math.min(...glyphs.map(g => g.y - g.fontPx / 2)),
        bottom: Math.max(...glyphs.map(g => g.y + g.fontPx / 2)),
    };
};

const overlaps = (a: number[], b: number[]) => a[0]! < b[1]! && b[0]! < a[1]!;

describe('歌词窗口的排版', () => {
    // 每族挑第一个光位（文字区各不相同）。
    const profiles = LUMIERE_PROFILES.map((profile, index) => [profile.kind, index] as const).filter((_, index) => index % 10 === 0);
    const band = frameBand(WIDTH, HEIGHT);
    // 标准光位：字号 0.085 个画面高的第一个。
    const standard = LUMIERE_PROFILES.findIndex(profile => profile.heroSize === 0.085);

    it.each(profiles)('%s：当前行（含长句）落在画框里（文字区只定中心，不限行长）', (_kind, profileIndex) => {
        for (const typography of ['horizontal', 'vertical', 'crossed'] as const) {
            const { window, heroPx } = buildWindow(profileIndex, typography);
            LINES.forEach((item, lineIndex) => {
                // 换行滑动结束之后、字开始崩解之前。
                const time = item.startTime + 0.7;
                const box = lineBox(window, lineIndex, time);
                // 漂移、绕行、呼吸与转动留一点余量。
                const margin = 0.06 * HEIGHT + heroPx * 0.35;
                expect(box.left, `${typography} ${lineIndex}`).toBeGreaterThanOrEqual(band.left * HEIGHT - margin);
                expect(box.right, `${typography} ${lineIndex}`).toBeLessThanOrEqual(band.right * HEIGHT + margin);
                expect(box.top, `${typography} ${lineIndex}`).toBeGreaterThanOrEqual(band.top * HEIGHT - margin);
                expect(box.bottom, `${typography} ${lineIndex}`).toBeLessThanOrEqual(band.bottom * HEIGHT + margin);
            });
            window.destroy();
        }
    });

    it('12 个字的竖排当前行折成两列、保持接近原大小（不再缩成一半）；横排时保持单行', () => {
        const lines = [line('光落在晨雾里', 2), line('迷失在无边际这幽深的森林', 6), line('风吹过', 11)];
        const vertical = buildWindow(standard, 'vertical', lines).window;
        expect(vertical.lineAnchor(1, 6.7).scale).toBeGreaterThanOrEqual(0.9);
        const columns = new Set(vertical.glyphTimes(1).map(({ glyphIndex }) => Math.round(vertical.glyphAnchor(1, glyphIndex, 6.7).x / 40)));
        expect(columns.size).toBeGreaterThan(1);
        // 邻行也不再是一小团：槽位缩放 0.58 左右，不再额外缩。
        expect(vertical.lineAnchor(0, 6.7).scale).toBeGreaterThan(0.5);
        const horizontal = buildWindow(standard, 'horizontal', lines).window;
        expect(horizontal.lineAnchor(1, 6.7).scale).toBeGreaterThanOrEqual(0.95);
        const rows = new Set(horizontal.glyphTimes(1).map(({ glyphIndex }) => horizontal.glyphAnchor(1, glyphIndex, 6.7).y > horizontal.lineAnchor(1, 6.7).y + 30));
        expect(rows.size).toBe(1);
    });

    // 当前行与邻行的组合：单列 / 两列（竖排）、单行 / 两行（横排）轮流出现。
    const MIXED = [
        line('光落在晨雾里', 2),
        line('我们慢慢走回去，星河与风一起落在很远很远的地方', 6),
        line('迷失在无边际这幽深的森林', 14),
        line('晚安', 19),
        line('我听见远方的海潮一遍一遍拍打着沉默的礁石和灯塔', 22),
        line('风吹过', 30),
        line('你说夜色会把所有的名字都轻轻藏起来', 33),
    ];

    it.each(['vertical', 'horizontal', 'crossed'] as const)('%s：当前行与邻行按实际宽高排开，落定时互不重叠，邻行沿行方向也在画框里', typography => {
        for (const profileIndex of profiles.map(([, index]) => index)) {
            // 看落定的槽位：不崩解（未唱的邻行聚拢之前是散开的）、不漂移（行从开始唱起一直匀速漂，老的行会漂开）。
            const { window, heroPx } = buildWindow(profileIndex, typography, MIXED, 0, 0);
            const margin = 0.06 * HEIGHT + heroPx * 0.35;
            MIXED.forEach((item, current) => {
                // 当前行 0.6 秒、下一行 0.8 秒滑到位。
                const time = item.startTime + 0.9;
                const box = lineBox(window, current, time);
                for (const neighbor of [current - 1, current + 1]) {
                    if (neighbor < 0 || neighbor >= MIXED.length || window.lineAnchor(neighbor, time).alpha < 0.3) continue;
                    const other = lineBox(window, neighbor, time);
                    const label = `${typography} ${profileIndex} ${current}/${neighbor}`;
                    if (typography === 'vertical') {
                        expect(overlaps([box.left, box.right], [other.left, other.right]), label).toBe(false);
                        // 竖排右起：上一行在右，下一行在左。
                        if (neighbor < current) expect(other.left, label).toBeGreaterThan(box.left);
                        else expect(other.right, label).toBeLessThan(box.right);
                        expect(other.top, label).toBeGreaterThanOrEqual(band.top * HEIGHT - margin);
                        expect(other.bottom, label).toBeLessThanOrEqual(band.bottom * HEIGHT + margin);
                    } else if (typography === 'horizontal') {
                        expect(overlaps([box.top, box.bottom], [other.top, other.bottom]), label).toBe(false);
                        expect(other.left, label).toBeGreaterThanOrEqual(band.left * HEIGHT - margin);
                        expect(other.right, label).toBeLessThanOrEqual(band.right * HEIGHT + margin);
                    } else {
                        // 纵横交错：自由落点（横竖都有）让开当前行，上一行在上、下一行在下。
                        expect(overlaps([box.top, box.bottom], [other.top, other.bottom]), label).toBe(false);
                        if (neighbor < current) expect(other.bottom, label).toBeLessThan(box.top);
                        else expect(other.top, label).toBeGreaterThan(box.bottom);
                    }
                }
            });
            window.destroy();
        }
    });

    it('换行时字在单行与折行之间连续移动（不跳）', () => {
        for (const typography of ['vertical', 'horizontal', 'crossed'] as const) {
            const { window, heroPx } = buildWindow(standard, typography, MIXED);
            // 第 1 行（24 字）从邻行变成当前行的那次滑动：开始前 1.3 秒到开始后 0.7 秒，按 60fps 采样。
            let previous: Array<{ x: number; y: number }> | null = null;
            for (let frame = 0; frame <= 120; frame += 1) {
                const time = 6 - 1.3 + frame / 60;
                const glyphs = window.glyphTimes(1).map(({ glyphIndex }) => window.glyphAnchor(1, glyphIndex, time));
                if (previous) {
                    const step = Math.max(...glyphs.map((glyph, index) => Math.hypot(glyph.x - previous![index]!.x, glyph.y - previous![index]!.y)));
                    expect(step, `${typography} ${time.toFixed(3)}`).toBeLessThan(heroPx * 0.8);
                }
                previous = glyphs;
            }
            window.destroy();
        }
    });

    it('位置只由时刻决定（与之前查过哪些时刻无关）', () => {
        const { window } = buildWindow(0, 'crossed');
        const probe = () => [1, 2, 3].map(index => window.lineAnchor(index, 15.3));
        const first = probe();
        [0, 30, 7.7, 2].forEach(time => window.lineAnchor(2, time));
        expect(probe()).toEqual(first);
    });
});

describe('绘光的调色', () => {
    const theme = (backgroundColor: string) => ({ backgroundColor, accentColor: '#88aaff' }) as Parameters<typeof resolveLumierePalette>[0];

    it('深色背景不铺暗场底，浅色背景铺一层压暗的暗场底', () => {
        expect(resolveLumierePalette(theme('#0b0d12')).dark[3]).toBe(0);
        const bright = resolveLumierePalette(theme('#f4efe6'));
        expect(bright.dark[3]).toBeCloseTo(0.94);
        // 预乘：颜色不超过 alpha。
        bright.dark.slice(0, 3).forEach(channel => expect(channel).toBeLessThanOrEqual(bright.dark[3]));
    });

    it('光色最亮的通道归一到 1，未点亮色比点亮色暗', () => {
        const palette = resolveLumierePalette(theme('#000000'));
        expect(Math.max(...palette.light)).toBeCloseTo(1);
        const sum = (rgb: number[]) => rgb.reduce((a, b) => a + b, 0);
        expect(sum(palette.unlit)).toBeLessThan(sum(palette.lit));
    });
});
