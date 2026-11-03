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

    it('vinyl karaoke keeps the AI accent after asynchronous cover extraction', async () => {
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
        expect(box.style.getPropertyValue('--sung')).toBe(theme.accentColor);
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

    it('vinyl uses current primary color and refreshes cached rows when theme or type scale changes', async () => {
        const { default: activate } = await import('../../../public/mods/builtin/vinyl-disc/client.mjs');
        let definition: any;
        activate({ i18n: { language: () => 'zh-CN' }, registries: { visualizers: { register: (value: unknown) => { definition = value; } } }, theme: { resolveFontStack: () => 'sans-serif', resolveFontWeight: (_: unknown, fallback: number) => fallback } });
        const container = document.createElement('div'); document.body.append(container);
        let theme = toFoliumTheme(aiTheme(), false);
        let scale = 1;
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
        expect(lyric().style.color || (lyric().parentElement?.parentElement?.parentElement as HTMLElement)?.style.color).toBe('rgb(245, 235, 210)');
        const beforeSize = lyric().style.fontSize;
        const rowsBefore = container.querySelector('[data-active]');
        theme = toFoliumTheme(aiTheme({ primaryColor: '#203040', accentColor: '#ff2299' }), false);
        change();
        expect(container.querySelector('[data-active]')).toBe(rowsBefore);
        expect((container.querySelector('[data-active]')?.parentElement as HTMLElement).style.getPropertyValue('--sung')).toBe('#ff2299');
        theme = toFoliumTheme(aiTheme({ primaryColor: '#203040', secondaryColor: '#556677' }), true);
        scale = 1.5; change();
        expect(lyric().style.color || (lyric().parentElement?.parentElement?.parentElement as HTMLElement)?.style.color).toBe('rgb(32, 48, 64)');
        expect(lyric().style.fontSize).not.toBe(beforeSize);
        const translated = [...container.querySelectorAll('div')].find(node => node.textContent === 'Starlight' && node.children.length === 0)!;
        expect(translated.style.color).toBe('rgb(85, 102, 119)');
        dispose();
    });
});
