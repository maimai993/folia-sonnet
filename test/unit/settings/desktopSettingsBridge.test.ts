import { afterEach, describe, expect, it, vi } from 'vitest';
import { canReadDesktopSettings } from '@/components/modal/settings/desktopSettingsBridge';

// 当前文件：设置窗启动时「能不能向主进程读桌面设置」的判据。
//
// 回归点（真机崩溃）：安卓为了让模组能用，会往 `window.electron` 上装一份只有
// `mods` / `appleMusicRequest` 的 shim。设置窗以前只问「对象在不在」，于是在安卓上
// 打开设置就调 `electron.getSettings()` → `TypeError: electron.getSettings is not a
// function`，整块设置页变成报错回退。

describe('desktop settings bridge', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('treats the android mods shim as unreadable', () => {
        vi.stubGlobal('window', {
            electron: {
                mods: { listMods: async () => ({ mods: [] }) },
                appleMusicRequest: async () => ({ ok: false, error: 'unsupported' }),
            },
        });

        expect(canReadDesktopSettings()).toBe(false);
    });

    it('needs both readers, not just one', () => {
        vi.stubGlobal('window', {
            electron: {
                platform: 'win32',
                getSettings: async () => ({}),
            },
        });

        expect(canReadDesktopSettings()).toBe(false);
    });

    it('accepts the desktop preload shape', () => {
        vi.stubGlobal('window', {
            electron: {
                platform: 'win32',
                getSettings: async () => ({}),
                getCacheDirectory: async () => ({ path: '', isDefault: true }),
            },
        });

        expect(canReadDesktopSettings()).toBe(true);
    });

    it('is false on a plain web page', () => {
        vi.stubGlobal('window', {});

        expect(canReadDesktopSettings()).toBe(false);
    });
});
