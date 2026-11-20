// test/unit/nativeBridge/cookieReadTriState.test.ts
//
// H4：cookie 读不到**不能**长得像「没登录」。
//
// 改动之前，桥超时 / 插件抛错都被压成空结果（`[]` / `null` / `''`），与「确实没有这条 cookie」
// 一模一样。于是登录时的线程争用、WebView 重载抖动一下，界面就引导重新登录，
// 账号读取那一路还会判成登录失效、连带把本地凭据清掉 —— 一次临时故障变成持久的登出。
//
// 这里钉住三件事：
//   1. chrome.cookies 的读在桥没答时**抛出**，不再回空；
//   2. cookies.js 的读 cookie 函数把「确实没有」交成空串、把「读失败」交成 CookieReadError；
//   3. 各平台的状态查询（网易 / QQ）把读失败往上带，不自己说「没登录」。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NEVER = () => new Promise<never>(() => {});

/** 装一个「桥不回包」的 WebView 宿主：cookie 读写都永远挂着。 */
const installHangingHost = () => {
    vi.stubGlobal('chrome', {
        cookies: {
            getAll: () => NEVER(),
            get: () => NEVER(),
            set: async () => undefined,
        },
        storage: { local: { get: async () => ({}), set: async () => undefined, remove: async () => undefined } },
    });
};

/** 装一个「宿主抛错」的 WebView 宿主。 */
const installRejectingHost = () => {
    vi.stubGlobal('chrome', {
        cookies: {
            getAll: async () => { throw new Error('fixture bridge is gone'); },
            get: async () => { throw new Error('fixture bridge is gone'); },
            set: async () => undefined,
        },
        storage: { local: { get: async () => ({}), set: async () => undefined, remove: async () => undefined } },
    });
};

/** 装一个「确实没有 cookie」的宿主。 */
const installEmptyHost = () => {
    vi.stubGlobal('chrome', {
        cookies: {
            getAll: async () => [],
            get: async () => null,
            set: async () => undefined,
        },
        storage: { local: { get: async () => ({}), set: async () => undefined, remove: async () => undefined } },
    });
};

beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('cookie 读的三态（H4）', () => {
    it('宿主抛错时 getNeteaseCookie 抛 CookieReadError，而不是回空串', async () => {
        installRejectingHost();
        const { getNeteaseCookie, isCookieReadError } = await import('../../../src/nativeBridge/api/cookies.js');
        await expect(getNeteaseCookie()).rejects.toSatisfy(isCookieReadError);
    });

    it('确实没有 cookie 时回空串，不抛', async () => {
        installEmptyHost();
        const { getNeteaseCookie } = await import('../../../src/nativeBridge/api/cookies.js');
        await expect(getNeteaseCookie()).resolves.toBe('');
    });

    it('getNeteaseMusicU：读到 null 是空串，宿主抛错就是 CookieReadError', async () => {
        installEmptyHost();
        const cookies = await import('../../../src/nativeBridge/api/cookies.js');
        await expect(cookies.getNeteaseMusicU()).resolves.toBe('');

        vi.resetModules();
        installRejectingHost();
        const failing = await import('../../../src/nativeBridge/api/cookies.js');
        await expect(failing.getNeteaseMusicU()).rejects.toSatisfy(failing.isCookieReadError);
    });

    it('桥超时（4 秒不回包）也交成 CookieReadError，不退化成空串', async () => {
        vi.useFakeTimers();
        const { installCookieShim } = await import('../../../src/services/nativeAndroidBridge.js');
        // 直接驱动兼容层：cookiesGetAll 永远不回包，模拟 Capacitor 丢回包。
        installCookieShim({
            cookiesGetAll: NEVER,
            cookiesGet: NEVER,
            cookiesSet: async () => ({ ok: true }),
            cookiesRemove: async () => ({ ok: true }),
            cookiesRemoveBatch: async () => ({ ok: true }),
        } as never);
        const cookies = await import('../../../src/nativeBridge/api/cookies.js');
        const pending = cookies.getNeteaseCookie();
        const assertion = expect(pending).rejects.toSatisfy(cookies.isCookieReadError);
        await vi.advanceTimersByTimeAsync(4100);
        await assertion;
    });

    it('兼容层的 getAll 在桥抛错时抛出 NativeCookieCallError，不回空数组', async () => {
        const { installCookieShim, NativeCookieCallError } = await import('../../../src/services/nativeAndroidBridge.js');
        installCookieShim({
            cookiesGetAll: async () => { throw new Error('fixture plugin is gone'); },
            cookiesGet: async () => { throw new Error('fixture plugin is gone'); },
            cookiesSet: async () => ({ ok: true }),
            cookiesRemove: async () => ({ ok: true }),
            cookiesRemoveBatch: async () => ({ ok: true }),
        } as never);
        await expect((globalThis as any).chrome.cookies.getAll({ domain: 'music.163.com' }))
            .rejects.toBeInstanceOf(NativeCookieCallError);
    });
});

describe('平台登录状态不把「读不到」说成「没登录」（H4）', () => {
    it('网易云：cookie 读失败时 getLoginInfo 抛出，不回 loggedIn:false', async () => {
        installRejectingHost();
        const { getLoginInfo } = await import('../../../src/nativeBridge/api/netease.js');
        await expect(getLoginInfo('')).rejects.toThrow();
    });

    it('QQ：cookie 读失败时 getQQLoginStatus 抛出，不回「未检测到登录」', async () => {
        installRejectingHost();
        const { getQQLoginStatus } = await import('../../../src/nativeBridge/api/qq.js');
        await expect(getQQLoginStatus('')).rejects.toThrow();
    });
});
