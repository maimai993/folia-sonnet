import { afterEach, describe, expect, it, vi } from 'vitest';
import * as pixi from 'pixi.js';
import type { Mesh } from 'pixi.js';
import { LUMIERE_PROFILES } from '@/components/visualizer/lumiere/catalog';
import { createLightField } from '@/components/visualizer/lumiere/light/lightFieldShader';
import { createLineArt, type LineArtSpec } from '@/components/visualizer/lumiere/lineart/lineArt';
import { createLyricWindow } from '@/components/visualizer/lumiere/text/lyricWindow';
import { installFakeTextMeasure, syntheticSong } from './lumiereFixtures';
import { FakeGraphics, fakePixi, fakeSprites } from './lumiereWindowFakes';

// test/unit/visualizer/lumiere/lumiereGpuRelease.test.ts
// 单元被丢掉时，绘光自建的 GPU 资源要当场放掉，不能留给 Pixi 的 GC（空闲 60 秒才收）。
// 起因：Graphics.destroy({ children: true }) 不销毁 Graphics 自建的 GraphicsContext，每个 context 在渲染器里
// 挂着一个 batcher 和两块 WebGL 缓冲；段落一换，线稿、径迹层就各漏一份，长跑时缓冲涨到上百 MB。
vi.mock('@/components/visualizer/lumiere/text/glyphLine', async importOriginal => (
    (await import('./lumiereWindowFakes')).fakeGlyphLineModule(await importOriginal())
));
installFakeTextMeasure();

afterEach(() => { FakeGraphics.created.length = 0; });

describe('Pixi 的销毁约定（这里的修复依赖它）', () => {
    it('Graphics.destroy({ children: true }) 不销毁自建的 context，要写 context: true', () => {
        const kept = new pixi.Graphics().moveTo(0, 0).lineTo(10, 10).stroke({ width: 2, color: 0xffffff });
        const keptContext = kept.context;
        kept.destroy({ children: true });
        expect(keptContext.destroyed).toBe(false);
        keptContext.destroy();

        const released = new pixi.Graphics().moveTo(0, 0).lineTo(10, 10).stroke({ width: 2, color: 0xffffff });
        const releasedContext = released.context;
        released.destroy({ children: true, context: true });
        expect(releasedContext.destroyed).toBe(true);
    });
});

describe('绘光图层销毁时放掉 GPU 资源', () => {
    it('线稿：每条线的 GraphicsContext 都随图层销毁', () => {
        const spec: LineArtSpec = {
            paths: [
                { points: [[0.1, 0.1], [0.5, 0.2], [0.8, 0.6]], width: 0.002, alpha: 0.8, delay: 0, span: 0.5 },
                { points: [[0.2, 0.7], [0.9, 0.7]], width: 0.002, alpha: 0.6, delay: 0.2, span: 0.4, dash: [0.02, 0.01] },
            ],
            nodes: [{ at: [0.5, 0.2], size: 0.01, delay: 0.1, twinklePhase: 0 }],
        };
        const art = createLineArt(pixi, { height: 900, spec, starTexture: pixi.Texture.WHITE });
        // 画线动画期间每帧 clear() 重画，context 始终是同一个。
        for (let draw = 0; draw <= 1; draw += 0.1) art.update(draw * 4, draw, 1, [], 0xffffff);
        const contexts = (art.view.children[0]!.children as pixi.Graphics[]).map(graphics => graphics.context);
        expect(contexts).toHaveLength(2);
        art.destroy();
        expect(contexts.every(context => context.destroyed)).toBe(true);
    });

    it('歌词窗口：径迹层（Graphics）的 context 随窗口销毁', () => {
        const song = syntheticSong(1);
        const profile = LUMIERE_PROFILES[30]!;
        const aspect = 1600 / 900;
        const window = createLyricWindow(fakePixi, {
            width: 1600,
            height: 900,
            lines: song,
            font: 'x',
            weight: 500,
            resolution: 1,
            region: { cx: profile.region.cx * aspect, cy: profile.region.cy, w: profile.region.w * aspect, h: profile.region.h },
            heroPx: profile.heroSize * 900,
            neighbors: 2,
            typography: 'horizontal',
            decay: profile.decay,
            seed: 'gpu-release',
            sprites: fakeSprites,
        });
        for (let time = song[0]!.startTime; time < song[song.length - 1]!.endTime; time += 0.5) {
            window.update({ time, beams: [], litColor: [1, 0.85, 0.6], unlitColor: [0.5, 0.6, 0.8], unlitAlpha: 0.15, intensity: 1 });
        }
        expect(FakeGraphics.created.length).toBeGreaterThan(0);
        window.destroy();
        expect(FakeGraphics.created.every(graphics => graphics.contextDestroyed)).toBe(true);
    });

    it('光场：网格的顶点 / 索引缓冲随光场销毁', () => {
        // 编着色器要 WebGL 上下文，node 里没有；只替换程序与着色器，几何与网格用真的 Pixi。
        class HeadlessShader { destroy() { /* 没有 GPU 程序可放 */ } }
        const headless = { ...pixi, GlProgram: { from: () => ({}) }, Shader: HeadlessShader } as unknown as typeof pixi;
        const field = createLightField(headless, 1600, 900, 40);
        const { buffers, indexBuffer } = (field.view as Mesh).geometry;
        field.destroy();
        expect([...buffers, indexBuffer].every(buffer => buffer.destroyed)).toBe(true);
    });
});
