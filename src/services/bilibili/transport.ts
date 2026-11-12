import type { BilibiliBridgeResponse } from '../../types/bilibili';
import { isBilibiliNativeAvailable, requestBilibiliNative } from '../../platform/foliaNative';

// src/services/bilibili/transport.ts
//
// 一次 bilibili 请求该从哪儿出去。
//
// api.bilibili.com 不给任意来源 CORS 头，WebView / 浏览器里直连一定被拦下。
// 所以正常路径是走原生桥（安卓的 FoliaBilibili 插件用 OkHttp 代发）。
//
// 桌面版这里没接：上游那套是靠 electron/bilibili.cjs 在主进程转发，我们还没移植。
// 但请求层不该因此分叉 —— 原生桥不在时退回 fetch 直连，失败时明确说
// 「这个平台发不出去」，而不是把跨域错误伪装成「没找到 MV」。
//
// 这一层只负责「把请求发出去、把响应文本拿回来」，解析和业务判定在 api.ts。

export interface BilibiliTransportResponse {
    ok: boolean;
    status: number;
    bodyText: string;
    /** 响应的 Set-Cookie 头（扫码登录换 cookie 要用）。 */
    setCookies?: string[];
}

/** 这个平台发不出去时的失败标记：调用方据此说「仅安卓 App 可用」。 */
export const BRIDGE_UNAVAILABLE_CODE = -2;
const BRIDGE_UNAVAILABLE = 'bilibili requests need the Android app';

export const isBilibiliAvailable = (): boolean => isBilibiliNativeAvailable();

export const requestBilibiliUrl = async (
    url: string,
    init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<BilibiliTransportResponse> => {
    if (isBilibiliNativeAvailable()) {
        return requestBilibiliNative(url, init.headers) as Promise<BilibiliBridgeResponse>;
    }

    // 没有原生桥：试着直连。失败时把话说清楚。
    try {
        const response = await fetch(url, {
            method: init.method ?? 'GET',
            body: init.body,
            headers: init.headers,
            credentials: 'include',
            mode: 'cors',
        });
        return { ok: response.ok, status: response.status, bodyText: await response.text() };
    } catch (error) {
        console.warn('[Bilibili] Direct request blocked:', error);
        return {
            ok: false,
            status: 0,
            bodyText: JSON.stringify({ code: BRIDGE_UNAVAILABLE_CODE, message: BRIDGE_UNAVAILABLE }),
        };
    }
};
