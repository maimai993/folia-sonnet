// test/unit/nativeBridge/responseCookieHandoff.test.ts
//
// M1：Set-Cookie 不再镜像成 JS 可读的响应头。
//
// 改动之前，桥接层把原生回包里的每一条 Set-Cookie 再 append 一份到 `x-folia-set-cookie`
// 上（一个普通、JS 能读的自定义响应头）。页面上任意一段脚本只要发一次登录相关的请求，
// 就能读到 qrsig / p_skey / NMTID 这些本该只躺在 Cookie 罐里的原始值。
//
// 这里钉住两件事：
//   1. 走桥的响应上既没有 `x-folia-set-cookie`，也读不到 Set-Cookie 本身；
//   2. 内置接口代码仍能从桥这一侧拿到那份原始值（否则扫码登录就没法换 p_skey）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CAPACITOR = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
};

const SET_COOKIES = [
    'qrsig=fixture-qrsig-value; Path=/; HttpOnly',
    'p_skey=fixture-p-skey-value; Domain=.qq.com; Path=/',
];

/** 装一个会回 Set-Cookie 的原生插件；`headers` 按原生回的形状（数组）给出。 */
const installNativeHost = (headers: Array<{ name: string; value: string }>) => {
    const httpRequest = vi.fn(async () => ({
        status: 200,
        headers,
        bodyText: 'ok',
        byteLength: 2,
    }));
    vi.stubGlobal('window', {
        Capacitor: { Plugins: { FoliaNative: { httpRequest } } },
    });
    return httpRequest;
};

beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('Capacitor', CAPACITOR);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('桥接响应里的 Set-Cookie（M1）', () => {
    it('普通调用的响应上没有 x-folia-set-cookie，也读不到 Set-Cookie', async () => {
        const httpRequest = installNativeHost(SET_COOKIES.map(value => ({ name: 'Set-Cookie', value })));
        const { nativeHttpRequest } = await import('../../../src/services/nativeAndroidBridge.js');

        const response = await nativeHttpRequest('https://ssl.ptlogin2.qq.com/ptqrshow');

        expect(httpRequest).toHaveBeenCalledTimes(1);
        // 镜像头已经不存在：这条断言在改动之前会读到 qrsig / p_skey 的原文。
        expect(response.headers.get('x-folia-set-cookie')).toBeNull();
        // Set-Cookie 是禁止暴露给 JS 的响应头，任何人都读不到。
        expect(response.headers.get('set-cookie')).toBeNull();
        expect([...response.headers.keys()]).not.toContain('x-folia-set-cookie');
    });

    it('没有显式索取时不把原始 Set-Cookie 留在内存里', async () => {
        installNativeHost(SET_COOKIES.map(value => ({ name: 'Set-Cookie', value })));
        const { nativeHttpRequest, nativeRawSetCookies } = await import('../../../src/services/nativeAndroidBridge.js');

        const response = await nativeHttpRequest('https://y.qq.com/portal/');

        expect(nativeRawSetCookies(response)).toEqual([]);
    });

    it('内置接口代码显式索取时，桥这一侧仍拿得到原始值', async () => {
        installNativeHost(SET_COOKIES.map(value => ({ name: 'Set-Cookie', value })));
        const { nativeHttpRequest, nativeRawSetCookies } = await import('../../../src/services/nativeAndroidBridge.js');

        const response = await nativeHttpRequest(
            'https://ssl.ptlogin2.qq.com/check_sig',
            {},
            { keepRawSetCookies: true },
        );

        expect(nativeRawSetCookies(response)).toEqual(SET_COOKIES);
        // 拿得到原始值的这条响应，对页面脚本同样不暴露任何东西。
        expect(response.headers.get('x-folia-set-cookie')).toBeNull();
        expect(response.headers.get('set-cookie')).toBeNull();
    });

    it('readRawSetCookies 从桥那一侧取值，且不再认识镜像头', async () => {
        installNativeHost(SET_COOKIES.map(value => ({ name: 'Set-Cookie', value })));
        const { nativeHttpRequest } = await import('../../../src/services/nativeAndroidBridge.js');
        const { readRawSetCookies } = await import('../../../src/nativeBridge/api/setCookieHeaders.js');

        const bridged = await nativeHttpRequest('https://ssl.ptlogin2.qq.com/check_sig', {}, { keepRawSetCookies: true });
        expect(readRawSetCookies(bridged)).toEqual(SET_COOKIES);

        // 只有镜像头、没有桥那一份的响应（页面上伪造的对象）：不再被当成 Set-Cookie。
        const forged = {
            headers: {
                get: (name: string) => (String(name).toLowerCase() === 'x-folia-set-cookie' ? 'qrsig=forged' : null),
            },
        };
        expect(readRawSetCookies(forged)).toEqual([]);
    });
});
