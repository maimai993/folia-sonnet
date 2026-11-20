// src/services/onlineMusic/lxmusic/lxRequest.ts
// 音源取歌的那条 HTTP 通路：复刻 LX 桌面端的 lx.request(url, options, callback)。
//
// 为什么单独一个文件：沙箱宿主（lxSourceSandbox.ts）要替脚本发请求，lxRuntime.ts 又要把它重新导出，
// 放在 lxRuntime 里就成环（Dedicatus D301，两条边都算「加载时执行」）。提到这里之后，
// lxRuntime → lxSourceSandbox → lxRequest，一条线下来没有回头路。
//
// 这一层是所有音源请求的必经之路，因此闸门也放在这里：指向本机 / 内网（含云端元数据服务）的地址
// 一律不发（规则见 lxRequestGuard.ts）。

import { resolveProxiedUrl } from '../../proxiedUrl';
import { hasNativeHttp, nativeHttpRequest } from '../../nativeAndroidBridge';
import { isAllowedLxRequestUrl } from './lxRequestGuard';

// ---------------------------------------------------------------------------
// HTTP 请求：复刻 lx.request(url, options, callback)
// ---------------------------------------------------------------------------

export type LxRequestOptions = {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Record<string, unknown> | FormData;
    form?: Record<string, string>;
    formData?: Record<string, string | Blob>;
    timeout?: number;
};

const buildRequestBody = (options: LxRequestOptions): { body?: BodyInit; headers?: Record<string, string> } => {
    const headers = { ...(options.headers ?? {}) };
    if (options.form) {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(options.form)) params.set(k, v);
        return { body: params.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } };
    }
    if (options.formData) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(options.formData)) fd.append(k, v);
        return { body: fd, headers };
    }
    if (options.body !== undefined) {
        if (typeof options.body === 'string') return { body: options.body, headers };
        if (options.body instanceof FormData) return { body: options.body, headers };
        return { body: JSON.stringify(options.body), headers: { 'content-type': 'application/json', ...headers } };
    }
    return { headers };
};

export type LxRequestResponse = {
    statusCode: number;
    statusMessage?: string;
    headers: Record<string, string>;
    bytes?: number;
    raw?: string;
    /** 与 LX 一致：能 JSON.parse 就给对象，否则给原始文本。脚本大量使用 resp.body.code。 */
    body?: unknown;
};

export const lxRequest = (
    url: string,
    options: LxRequestOptions,
    callback: (err: unknown, resp?: LxRequestResponse, body?: unknown) => void,
): (() => void) => {
    const controller = new AbortController();
    const timer = options.timeout ? window.setTimeout(() => controller.abort(), options.timeout) : null;
    const { body, headers = {} } = buildRequestBody(options);

    // 闸门：音源只该取公网上的东西。指向本机 / 内网（含云端元数据服务）的地址一律不发出去 ——
    // 沙箱宿主已经拦过一次，这里再拦一次是因为 lxRequest 本身也可能被别处调用。
    if (!isAllowedLxRequestUrl(url)) {
        const blocked = new Error(`[lx] 拒绝请求内网或本机地址：${url.slice(0, 96)}`);
        console.warn(blocked.message);
        // 异步回调，与真正的失败保持同一时序（脚本常在 Promise 里等它）。
        window.setTimeout(() => callback(blocked), 0);
        return () => undefined;
    }

    /**
     * 安卓上必须走原生 OkHttp，而且**不能**按主机白名单过滤。
     *
     * 音源脚本的第一步是去它自己的服务器要地址，那些域名千奇百怪；以前这里走
     * `resolveProxiedUrl`，白名单外的主机在安卓包里会直接抛
     * "VITE_FOLIA_API_BASE must be configured"，等于每个音源第一跳就失败。
     * 白名单内的主机反而能过——所以现象是「少数音源能用、大部分不能播」。
     */
    const run = async (): Promise<Response> => {
        if (hasNativeHttp()) {
            let bodyText: string | undefined;
            let bodyBase64: string | undefined;
            if (typeof body === 'string') {
                bodyText = body;
            } else if (options.form) {
                bodyText = body as unknown as string;
            } else if (body instanceof FormData) {
                // 少数音源会用 FormData 上传：整段编成 base64 交给原生，顺带拿到带 boundary 的 content-type。
                const formResponse = new Response(body);
                const contentType = formResponse.headers.get('content-type');
                if (contentType && !headers['content-type'] && !headers['Content-Type']) {
                    headers['content-type'] = contentType;
                }
                const bytes = new Uint8Array(await formResponse.arrayBuffer());
                let binary = '';
                for (let index = 0; index < bytes.length; index += 0x8000) {
                    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
                }
                bodyBase64 = btoa(binary);
            }
            return nativeHttpRequest(url, {
                method: (options.method || 'GET').toUpperCase(),
                headers,
                bodyText,
                bodyBase64,
                // 音源的服务器有时很慢（要先回源、要签名），给足预算；底下还有脚本自己的 timeout。
                timeoutMs: Math.max(options.timeout ?? 0, 20000),
            });
        }
        return fetch(resolveProxiedUrl(url), {
            method: options.method || 'GET',
            headers,
            body,
            signal: controller.signal,
            mode: 'cors',
        });
    };

    run()
        .then(async (resp) => {
            const text = await resp.text();
            const respHeaders: Record<string, string> = {};
            resp.headers.forEach((value, key) => { respHeaders[key] = value; });
            // LX 会把响应体解析成对象塞进 resp.body，同时作为第三个参数传出去。
            // 少了这个字段，音源里 `resp.body.code === 200` 这类判断会直接抛
            // 「Cannot read properties of undefined」，取地址就永远失败。
            let parsed: unknown = text;
            try {
                parsed = JSON.parse(text);
            } catch {
                parsed = text;
            }
            const response: LxRequestResponse = {
                statusCode: resp.status,
                statusMessage: resp.statusText,
                headers: respHeaders,
                bytes: text.length,
                raw: text,
                body: parsed,
            };
            callback(null, response, parsed);
        })
        .catch((err) => {
            callback(err);
        })
        .finally(() => {
            if (timer !== null) window.clearTimeout(timer);
        });

    return () => {
        controller.abort();
    };
};
