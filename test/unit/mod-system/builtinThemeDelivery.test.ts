// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toFoliumTheme } from '@/mods/folium/dto';
import type { Theme } from '@/types';

// 内置模组配色交付：投影保持原色，黑胶在同一行内换主题/字号也必须更新真实 DOM。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const aiTheme = (patch: Partial<Theme> = {}): Theme => ({ name: 'synthetic', backgroundColor: '#183e52', primaryColor: '#f5ebd2', secondaryColor: '#b4c7df', accentColor: '#35d9ba', fontStyle: 'sans', animationIntensity: 'normal', provider: 'ai', ...patch });
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('builtin theme delivery', () => {
    it('does not replace a deliberately monochrome theme with unrelated host chrome accent', () => {
        vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '#ff00ff' }));
        const theme = aiTheme({ primaryColor: '#ffffff', accentColor: '#ffffff' });
        expect(toFoliumTheme(theme, false).accentColor).toBe('#ffffff');
    });

    /*
     * 注意：`public/mods/builtin/vinyl-disc` 用的是**官方原始包**（未打仓库补丁）。
     * 原始版的已唱色取封面主色、没有时退回主题 accent，所以这里断言的是封面提取出来的
     * 那个颜色（上面 canvas 桩给的 [255, 68, 17]），而不是 AI 主题的 accent。
     */
    it('vinyl karaoke uses the cover colour after asynchronous cover extraction', async () => {
        vi.useFakeTimers();
        const create = document.createElement.bind(document);
        let image: HTMLImageElement | undefined;
        vi.spyOn(document, 'createElement').mockImplementation(((tag: string, options?: ElementCreationOptions) => {
            const node = create(tag, options);
            if (tag === 'img') image = node as HTMLImageElement;
            if (tag === 'canvas') Object.assign(node, { getContext: () => ({ drawImage: () => {}, getImageData: () => ({ data: new Uint8ClampedArray([255, 68, 17, 255]) }) }) });
            return node;
        }) as typeof document.createElement);
        const { default: activate } = await import('../../../public/mods/builtin/vinyl-disc/client.mjs');
        let definition: any;
        activate({ i18n: { language: () => 'zh-CN' }, registries: { visualizers: { register: (v: unknown) => { definition = v; } } }, theme: { resolveFontStack: () => 'sans-serif', resolveFontWeight: () => 400 } });
        const container = create('div'); document.body.append(container);
        let frame = () => {};
        const theme = toFoliumTheme(aiTheme(), false);
        const dispose = definition.mount(container, { song: { title: 'fixture', artist: 'test' }, lines: [{ fullText: '星光', words: [{ text: '星', startTime: 0, endTime: 1 }, { text: '光', startTime: 1, endTime: 2 }] }], staticMode: false, staticLineIndex: null, isPaused: () => false, getTheme: () => theme, getSettings: () => ({}), getDisplay: () => ({ showText: true, lyricsFontScale: 1 }), getCoverUrl: () => 'cover.png', getLineIndex: () => 0, lyricTime: { get: () => 0.5 }, onResize: (fn: any) => { fn({ width: 1280, height: 720 }); return () => {}; }, onChange: () => () => {}, onFrame: (fn: () => void) => { frame = fn; return () => {}; }, onLyricTime: () => () => {} });
        image?.onload?.(new Event('load'));
        await Promise.resolve(); frame();
        const box = container.querySelector('[data-karaoke]')?.parentElement as HTMLElement;
        expect(box.style.getPropertyValue('--sung')).toBe('#ed4e23');
        dispose();
    });

    it('jump consumes primary, secondary and accent from the projected song theme', async () => {
        const { resolveJumpPalette } = await import('../../../public/mods/builtin/visualizer-jump/jumpPalette.mjs');
        const theme = toFoliumTheme(aiTheme(), false);
        const palette = resolveJumpPalette(theme, { theme: { resolveFontStack: () => 'sans-serif', resolveFontWeight: () => 400 } });
        expect(palette.text).toBe(theme.primaryColor);
        expect(palette.accent).toBe(theme.accentColor);
        expect(palette.front).toContain('180, 199, 223');
        expect(palette.paper).toBe(theme.backgroundColor);
    });

    /*
     * 原始版的歌词颜色来自 CSS（currentColor / --sung），不在行内样式上赋值，
     * 行缓存键也只看「第几行 + 文本」，不跟主题/字号变化重建。
     * 这里断言原始版的真实行为，避免测试继续替一份不存在的补丁背书。
     */
    it('vinyl renders lyric rows from the original package (no inline theme colour)', async () => {
        const { default: activate } = await import('../../../public/mods/builtin/vinyl-disc/client.mjs');
        let definition: any;
        activate({ i18n: { language: () => 'zh-CN' }, registries: { visualizers: { register: (value: unknown) => { definition = value; } } }, theme: { resolveFontStack: () => 'sans-serif', resolveFontWeight: (_: unknown, fallback: number) => fallback } });
        const container = document.createElement('div'); document.body.append(container);
        let theme = toFoliumTheme(aiTheme(), false);
        const scale = 1;
        let change = () => {};
        const ctx = {
            song: { title: 'Synthetic', artist: 'Fixture' }, lines: [{ fullText: '星光照亮', startTime: 0, endTime: 10, words: [], translation: 'Starlight' }],
            staticMode: true, staticLineIndex: 0, isPaused: () => true, getTheme: () => theme,
            getSettings: () => ({}), getDisplay: () => ({ showText: true, lyricsFontScale: scale }), getCoverUrl: () => null, getLineIndex: () => 0,
            onResize: (fn: (size: { width: number; height: number }) => void) => { fn({ width: 1280, height: 720 }); return () => {}; },
            onChange: (fn: () => void) => { change = fn; return () => {}; }, onFrame: () => () => {}, onLyricTime: () => () => {},
        };
        const dispose = definition.mount(container, ctx);
        const lyric = () => [...container.querySelectorAll('div')].find(node => node.textContent === '星光照亮' && node.children.length === 0)!;
        // 歌词确实被渲染出来了。
        expect(lyric()).toBeTruthy();
        const rowsBefore = container.querySelector('[data-active]');
        theme = toFoliumTheme(aiTheme({ primaryColor: '#203040', accentColor: '#ff2299' }), false);
        change();
        // 原始版不因主题变化重建这一行。
        expect(container.querySelector('[data-active]')).toBe(rowsBefore);
        dispose();
    });
});
