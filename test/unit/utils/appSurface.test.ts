// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// test/unit/utils/appSurface.test.ts
// 哪个 HTML 入口算「主应用」：视频层、布局上报、开发者工具都读这一个答案。
// 壁纸 / 桌面叠层那一页是**另一个入口**（wallpaper.html），它一律不是主应用 —— issue #399：
// 那一页原来被当成主应用，于是叠层里多画了一层「歌词后方的视频层」，而且两个窗口抢同一份
// 本地视频句柄，主窗口那边看着就是「视频层加载不出来」。
//
// appSurface 在模块求值时读 location，所以每种情形都要重新 import。

const load = async (url: string) => {
    vi.resetModules();
    vi.stubGlobal('window', { location: new URL(url) });
    return import('../../../src/utils/appSurface');
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('appSurface', () => {
    it('treats the main entry as the main app surface', async () => {
        const surface = await load('http://localhost:5173/');
        expect(surface.isMainAppSurface).toBe(true);
        expect(surface.isWallpaperSurface).toBe(false);
    });

    it('keeps the wallpaper entry out of the main app surface', async () => {
        const surface = await load('http://localhost:5173/wallpaper.html');
        expect(surface.isWallpaperSurface).toBe(true);
        expect(surface.isMainAppSurface).toBe(false);
    });

    it('keeps the OBS source, the remote control and the perf check out too', async () => {
        expect((await load('http://localhost:5173/?obs=1')).isMainAppSurface).toBe(false);
        expect((await load('http://localhost:5173/?remote=1')).isMainAppSurface).toBe(false);
        expect((await load('http://localhost:5173/?perfCheck=1')).isMainAppSurface).toBe(false);
    });
});
