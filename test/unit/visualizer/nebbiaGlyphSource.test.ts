import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeNebbiaTuning } from '@/components/visualizer/nebbia/tuning';
import { DEFAULT_NEBBIA_TUNING } from '@/components/visualizer/nebbia/types';

// test/unit/visualizer/nebbiaGlyphSource.test.ts
// 字形来源（笔顺数据 ⇄ 跟随歌词字体）：默认还是笔顺数据、旧存档补默认、乱值退回默认、字形缓存按来源分开取。

const medians = { 我: [[[0, 0], [512, 512], [1024, 1024]]] } as Record<string, [number, number][][]>;

afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@/components/visualizer/nebbia/nebbiaStrokes');
    vi.doUnmock('@/components/visualizer/nebbia/nebbiaSkeleton');
});

describe('nebbia glyph source tuning', () => {
    it('defaults to the stroke data so nothing changes for existing users', () => {
        expect(DEFAULT_NEBBIA_TUNING.glyphSource).toBe('strokes');
        expect(normalizeNebbiaTuning({ mist: 0.5 }).glyphSource).toBe('strokes');
    });

    it('keeps a valid choice and rejects anything else', () => {
        expect(normalizeNebbiaTuning({ glyphSource: 'font' }).glyphSource).toBe('font');
        expect(normalizeNebbiaTuning({ glyphSource: 'strokes' }).glyphSource).toBe('strokes');
        for (const bad of ['', 'FONT', 7, null, undefined, {}]) {
            expect(normalizeNebbiaTuning({ glyphSource: bad }).glyphSource).toBe('strokes');
        }
    });
});

describe('nebbia glyph cache by source', () => {
    const load = async () => {
        const skeleton = vi.fn(() => [[[0.1, 0.1], [0.5, 0.5], [0.9, 0.9]]]);
        vi.doMock('@/components/visualizer/nebbia/nebbiaStrokes', () => ({ getNebbiaStrokeMedians: (ch: string) => medians[ch] ?? null }));
        vi.doMock('@/components/visualizer/nebbia/nebbiaSkeleton', () => ({ skeletonPolys: skeleton }));
        const { NebbiaGlyphCache } = await import('@/components/visualizer/nebbia/nebbiaGlyphs');
        return { cache: new NebbiaGlyphCache('serif', 600), skeleton };
    };

    it('uses the stroke data for a Chinese character by default and never traces the font', async () => {
        const { cache, skeleton } = await load();
        expect(cache.get('我')).not.toBeNull();
        expect(skeleton).not.toHaveBeenCalled();
    });

    it('traces the lyrics font once the source is "font", and clears what it had', async () => {
        const { cache, skeleton } = await load();
        cache.get('我');
        expect(cache.setSource('font')).toBe(true);
        expect(cache.get('我')).not.toBeNull();
        expect(skeleton).toHaveBeenCalledWith('我', 'serif', 600);
    });

    it('reports a change only when the source really changed', async () => {
        const { cache } = await load();
        expect(cache.setSource('strokes')).toBe(false);
        expect(cache.setSource('font')).toBe(true);
        expect(cache.setSource('font')).toBe(false);
        expect(cache.setSource('strokes')).toBe(true);
    });

    it('goes back to the stroke data when switched back', async () => {
        const { cache, skeleton } = await load();
        cache.setSource('font');
        cache.get('我');
        skeleton.mockClear();
        cache.setSource('strokes');
        cache.get('我');
        expect(skeleton).not.toHaveBeenCalled();
    });

    it('follows the font for letters whatever the source is', async () => {
        const { cache, skeleton } = await load();
        cache.get('a');
        expect(skeleton).toHaveBeenCalledTimes(1);
    });
});

describe('nebbia glyph cache font readiness', () => {
    // document.fonts.check(整条字体栈) 在有通用回退时总是 true，等不到字体市场的字体下载完；
    // 主题自己带的字体要等它注册的 FontFace 真的 loaded。
    const withFonts = async (faces: { family: string; status: string }[], check = true) => {
        const list = faces.map(face => ({ ...face, family: face.family }));
        const set = {
            check: () => check,
            forEach: (fn: (face: { family: string; status: string }) => void) => list.forEach(fn),
        };
        vi.stubGlobal('document', { fonts: set });
        const { NebbiaGlyphCache } = await import('@/components/visualizer/nebbia/nebbiaGlyphs');
        return new NebbiaGlyphCache('"My Market Font", serif', 600, ['My Market Font']);
    };

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('is not ready while the theme font is still loading, even though the stack resolves', async () => {
        const cache = await withFonts([{ family: 'My Market Font', status: 'loading' }], true);
        expect(cache.fontReady()).toBe(false);
    });

    it('is ready once the theme font has loaded', async () => {
        const cache = await withFonts([{ family: 'My Market Font', status: 'loaded' }], true);
        expect(cache.fontReady()).toBe(true);
    });

    it('ignores fonts that are not the theme\'s own', async () => {
        const cache = await withFonts([{ family: 'Some Other Font', status: 'loading' }], true);
        expect(cache.fontReady()).toBe(true);
    });

    it('falls back to the stack check when the theme has no font of its own', async () => {
        vi.stubGlobal('document', { fonts: { check: () => true, forEach: () => undefined } });
        const { NebbiaGlyphCache } = await import('@/components/visualizer/nebbia/nebbiaGlyphs');
        expect(new NebbiaGlyphCache('serif', 600, []).fontReady()).toBe(true);
    });
});
