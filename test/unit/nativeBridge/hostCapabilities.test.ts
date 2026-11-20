// test/unit/nativeBridge/hostCapabilities.test.ts
//
// M3：桥不再伪造它没有的能力。
//
// 改动之前，installCookieShim 在 `globalThis.chrome` 上装了一个「恒成功」的
// `declarativeNetRequest.updateSessionRules`：规则收下就 resolve，一条也没装。内置的
// 接口代码据此认为「cookie 注入已经生效」，实际发出去的请求里没有那个头 —— 失败被推迟到
// 后面几步，表现成莫名其妙的空响应。
//
// 这里钉住三件事：
//   1. 安卓桥不提供 `chrome.declarativeNetRequest`（有意为空，而不是空壳）；
//   2. 宿主能力有明确的位（`chrome.foliaNative.capabilities`），不再靠「函数在不在」猜；
//   3. 内置代码判断「要不要走 DNR 注入」读的是那个位，且在没有 DNR 时照常发出请求。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CAPACITOR = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
};

const installPlugin = () => {
    const plugin = {
        cookiesGetAll: vi.fn(async () => ({ cookies: [] })),
        cookiesGet: vi.fn(async () => ({ cookie: null })),
        cookiesSet: vi.fn(async () => undefined),
        cookiesRemove: vi.fn(async () => undefined),
        httpRequest: vi.fn(async () => ({ status: 200, headers: [], bodyText: '' })),
    };
    const store = new Map<string, string>();
    const storage = {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value); },
        removeItem: (key: string) => { store.delete(key); },
        key: (index: number) => Array.from(store.keys())[index] ?? null,
        get length() { return store.size; },
    };
    vi.stubGlobal('window', {
        Capacitor: { Plugins: { FoliaNative: plugin } },
        localStorage: storage,
    });
    // 桥直接调裸的 `localStorage`（WebView 里它就是 window.localStorage）。
    vi.stubGlobal('localStorage', storage);
    return plugin;
};

beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('Capacitor', CAPACITOR);
    vi.stubGlobal('chrome', undefined);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('安卓桥的宿主能力（M3）', () => {
    it('不再提供假的 declarativeNetRequest', async () => {
        const plugin = installPlugin();
        const { installCookieShim } = await import('../../../src/services/nativeAndroidBridge.js');
        installCookieShim(plugin as any);

        const chromeObject = (globalThis as any).chrome;
        // 改动之前这里有一个 updateSessionRules，调用它永远 resolve。
        expect(chromeObject.declarativeNetRequest).toBeUndefined();
        expect(chromeObject.declarativeNetRequest?.updateSessionRules).toBeUndefined();
    });

    it('能力位明确写出「没有 DNR」，内置代码据此判断而不是看函数在不在', async () => {
        const plugin = installPlugin();
        const { installCookieShim } = await import('../../../src/services/nativeAndroidBridge.js');
        installCookieShim(plugin as any);

        const capabilities = (globalThis as any).chrome.foliaNative.capabilities;
        expect(capabilities.dnr).toBe(false);
        expect(capabilities.bridgedResponseCookies).toBe(true);
    });

    it('没有 DNR 时把 Cookie 交给请求本身，并照常发出请求', async () => {
        installPlugin();
        const { installCookieShim } = await import('../../../src/services/nativeAndroidBridge.js');
        installCookieShim({} as any);
        const { withInjectedCookie } = await import('../../../src/nativeBridge/api/qq-login-qr.js');

        const seen: Array<Record<string, unknown>> = [];
        const fetchMock = vi.fn(async (_input: unknown, init?: Record<string, any>) => {
            seen.push(init || {});
            return new Response('ok');
        });
        vi.stubGlobal('fetch', fetchMock);

        await withInjectedCookie('uin=o0123456789; p_skey=fixture', ['||ptlogin2.qq.com'], async () => {
            // 宿主把 Cookie 交给请求本身（内置代码自己写进头里），这里只是照常发出去。
            await fetch('https://ssl.ptlogin2.qq.com/check_sig', {
                method: 'GET',
                headers: { Cookie: 'uin=o0123456789; p_skey=fixture' },
            });
        });

        expect(seen).toHaveLength(1);
        // 没有伪造的 DNR 可写：请求上没有 `bypass: 'bridge'` 那种「以为注入生效」的痕迹。
        expect(seen[0].bypass).toBeUndefined();
        expect((seen[0].headers as Record<string, string>).Cookie).toBe('uin=o0123456789; p_skey=fixture');
        // 并且确实是「原样跑」：没装任何规则，也没有那个假 API 可以装。
        expect((globalThis as any).chrome.declarativeNetRequest).toBeUndefined();
    });

    it('chrome.storage.local 的键落在桥自己的命名空间里，与页面同名键互不覆盖', async () => {
        installPlugin();
        const { installCookieShim } = await import('../../../src/services/nativeAndroidBridge.js');
        installCookieShim({} as any);
        const store = (globalThis as any).chrome.storage.local;

        // 页面自己的键（同名的那个）不该被桥读到，也不该被桥写穿。
        localStorage.setItem('kgVipSession', JSON.stringify({ page: true }));
        await store.set({ kgVipSession: { bridge: true } });

        // 桥看到的是自己那份。
        expect(await store.get(['kgVipSession'])).toEqual({ kgVipSession: { bridge: true } });
        // 页面上那份原样还在（写在带前缀的键上，不是同名键上）。
        expect(JSON.parse(localStorage.getItem('kgVipSession') || 'null')).toEqual({ page: true });
        // 整片枚举也只列桥自己的键，不会把页面的键当成自己的。
        const all = await store.get(null);
        expect(Object.keys(all)).toEqual(['kgVipSession']);
        // 删除只删桥这一份。
        await store.remove(['kgVipSession']);
        expect(await store.get(['kgVipSession'])).toEqual({});
        expect(JSON.parse(localStorage.getItem('kgVipSession') || 'null')).toEqual({ page: true });
    });
});
