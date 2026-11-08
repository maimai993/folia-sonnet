// src/services/nativeHttpFetch.ts
//
// 安卓 WebView 里的一条「不受 CORS 管」的 fetch。
//
// 为什么要有它：WebView 里的页面是有来源的（capacitor.config 里 androidScheme=https，
// 页面跑在 https://localhost），所以跨域请求照样走浏览器的同源检查 —— 服务端没给
// `Access-Control-Allow-Origin` 就是一句毫无特征的 `TypeError: Failed to fetch`。
// 桌面端那些靠 Electron 主进程转发绕开的接口，在安卓上缺的就是这么一条路。
//
// 已有的原生 OkHttp 桥（FoliaNative.httpRequest）正好就是这条路：任意 URL、任意头、
// 还会自动带上 WebView 自己的 cookie。这里只把它包装成与 fetch 同形的函数。
//
// 与 aiNativeFetch 的分工：那边是「AI 请求走原生」这个**用法**（含云缓存那条旁路）；
// 这里是那条路本身。两边共用一份实现，免得第二处要用时再抄一遍。

import { nativePayloadBytes } from '../platform/foliaNative';

type NativeHeaderEntry = { name?: string; value?: string };

export type NativeHttpResponse = {
    status: number;
    headers?: NativeHeaderEntry[] | Record<string, string>;
    /** 文本类响应（#262）：原生已经按 UTF-8 解好，优先用它。 */
    bodyText?: string;
    bodyBase64?: string;
    byteLength?: number;
};

export type NativeHttpPlugin = {
    httpRequest: (options: {
        url: string;
        method: string;
        headers: Record<string, string>;
        bodyText: string;
        bodyBase64: string;
        redirect: string;
        timeoutMs?: number;
        maxBytes?: number;
        responseMode?: 'auto' | 'text' | 'base64';
    }) => Promise<NativeHttpResponse>;
};

/** 默认读超时。普通接口调用不该接近这个值，超时基本意味着网络已经断了。 */
export const NATIVE_HTTP_TIMEOUT_MS = 45_000;

/**
 * 默认的响应体上限（字节）。
 *
 * 与原生侧的 `DEFAULT_MAX_RESPONSE_BYTES` 对齐：接口 JSON 远小于 8MiB，更大的东西
 * 本来就不该整段过桥 —— 走桥的响应在 Java heap 里会被放大好几倍，256MB 堆的机器
 * 20MB 左右就会 OOM（#261）。
 */
export const NATIVE_HTTP_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * 拿原生插件。
 *
 * ⚠️ 判「插件在不在」不能写成 `typeof plugin?.httpRequest === 'function'`：
 * `registerPlugin()` 给回来的是一个**代理**，任何方法名问过去都是 function，原生侧一行
 * 没写时这一句也返回 true（真出过一次：于是凭空点亮平台入口，报「未登录却有账号」）。
 * 同步的 `Capacitor.isPluginAvailable()` 查的是原生上报的 pluginHeaders，那才是真的。
 */
const getNativePlugin = (): NativeHttpPlugin | null => {
    if (typeof window === 'undefined') return null;
    const capacitor = (window as unknown as {
        Capacitor?: {
            isPluginAvailable?: (name: string) => boolean;
            isNativePlatform?: () => boolean;
            getPlatform?: () => string;
            Plugins?: { FoliaNative?: NativeHttpPlugin };
        };
    }).Capacitor;
    if (!capacitor) return null;
    if (capacitor.isNativePlatform?.() !== true && capacitor.getPlatform?.() !== 'android') return null;
    if (typeof capacitor.isPluginAvailable === 'function' && !capacitor.isPluginAvailable('FoliaNative')) return null;
    return capacitor.Plugins?.FoliaNative ?? null;
};

/** 这条原生路现在能不能用（决定要不要把平台入口点亮）。 */
export const isNativeHttpFetchAvailable = (): boolean => getNativePlugin() !== null;

const buildHeaders = (entries: NativeHttpResponse['headers']): Headers => {
    const headers = new Headers();
    if (Array.isArray(entries)) {
        entries.forEach((entry) => {
            if (!entry?.name || entry.value == null) return;
            // 只有 Set-Cookie 允许重复；其余同名头后者覆盖前者。
            if (entry.name.toLowerCase() === 'set-cookie') headers.append(entry.name, String(entry.value));
            else headers.set(entry.name, String(entry.value));
        });
    } else if (entries) {
        Object.entries(entries).forEach(([name, value]) => {
            if (value != null) headers.set(name, String(value));
        });
    }
    return headers;
};

/**
 * 返回一个与 fetch 同形的函数：安卓上走原生 OkHttp，其它平台回落到全局 fetch。
 *
 * 只覆盖「文本 / 二进制请求体 + 整段响应」的用法，不做流式读取。
 *
 * 第二个参数是允许整段回传的字节上限：超过时原生直接 reject（#261），而不是把 heap
 * 撑爆。要取大文件（封面、字体、音视频）不要走这里，让原生下载到磁盘（见 coverBytes）。
 */
export const createNativeFetch = (
    timeoutMs: number = NATIVE_HTTP_TIMEOUT_MS,
    maxBytes: number = NATIVE_HTTP_MAX_RESPONSE_BYTES,
): typeof fetch => {
    const plugin = getNativePlugin();
    if (!plugin?.httpRequest) {
        return ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)) as typeof fetch;
    }

    return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = typeof Request !== 'undefined' && input instanceof Request ? input : null;
        const url = request?.url ?? String(input);
        const method = (init?.method || request?.method || 'GET').toUpperCase();
        const headers = new Headers(request?.headers || init?.headers || {});

        let bodyText = '';
        const rawBody = init?.body ?? null;
        if (typeof rawBody === 'string') {
            bodyText = rawBody;
        } else if (rawBody instanceof URLSearchParams) {
            bodyText = rawBody.toString();
            if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded');
        } else if (rawBody != null) {
            bodyText = String(rawBody);
        }

        const headerObject: Record<string, string> = {};
        headers.forEach((value, name) => {
            headerObject[name] = value;
        });

        let result: NativeHttpResponse;
        try {
            result = await plugin.httpRequest({
                url,
                method,
                headers: headerObject,
                bodyText,
                bodyBase64: '',
                redirect: init?.redirect || request?.redirect || 'follow',
                timeoutMs,
                maxBytes,
            });
        } catch (error) {
            /*
             * 超上限时原生直接 reject（#261）。这条日志是为了让「某条接口突然失败」
             * 可诊断：只记主机名，不记 URL 的查询串（里面可能有凭据）。
             */
            const message = String((error as { message?: unknown })?.message ?? error);
            if (message.includes('bridge size limit')) {
                let host = '';
                try { host = new URL(url).host; } catch { /* 地址本身不合法，就不记 */ }
                console.warn('[NativeHttp] response exceeds the bridge size limit', {
                    host,
                    maxBytes,
                    method,
                });
            }
            throw error;
        }

        // 文本响应原生给 bodyText（#262），二进位才是 base64；两种都在这个 helper 里收口。
        const bytes = nativePayloadBytes(result);
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        return new Response(buffer, {
            status: result.status,
            headers: buildHeaders(result.headers),
        });
    }) as typeof fetch;
};
