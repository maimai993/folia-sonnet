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
import { registerSelfHostedService } from '../../nativeSelfHostedServices';
import { isAllowedLxRequestUrl } from './lxRequestGuard';

// ---------------------------------------------------------------------------
// 音源主机授信（C1）
// ---------------------------------------------------------------------------

/**
 * 某支音源脚本会连的主机。
 *
 * 原生 `httpRequest` 现在有主机白名单，而自定义音源的第一步是去它自己的服务器要地址 ——
 * 那些域名千奇百怪，出厂白名单里不可能有。所以按「谁被用户装进来了」授信：用户导入 /
 * 启用一支音源时，脚本里出现的域名就是这支音源的出网范围，收进来交给原生登记。
 *
 * 为什么从脚本里扫，而不是等第一次请求再登记：等请求来才登记就退化成「任意主机登记即
 * 放行」，那正是 C1 要堵的那条路。这里的输入只有**用户自己导入的那份脚本文本**，扫出来的
 * 是「这支脚本自己写下的服务器」，用户装它的时候等于已经同意了。
 */
export const lxScriptHosts = (rawScript: string): string[] => {
    const hosts = new Set<string>();
    const pattern = /https?:\/\/([^\s'"`/?#<>()\\{},;|*^[\]]+)/gi;
    const matches = rawScript.match(pattern) ?? [];
    for (const entry of matches) {
        const host = entry.replace(/^https?:\/\//i, '').split('/')[0]?.split(':')[0]?.toLowerCase();
        if (!host || host.length === 0) continue;
        // 脚本里拼模板字符串时会留下 `${...}`，那不是主机名。
        if (host.includes('$') || host.includes('{') || host.includes('}')) continue;
        hosts.add(host);
    }
    return Array.from(hosts).sort();
};

/** 本次运行期已登记给原生的音源主机（避免重复过桥）。 */
const grantedLxHosts = new Set<string>();

/**
 * 把已装音源的出网主机登记给原生（C1）。
 *
 * 输入是「用户装进来的全部脚本文本」：每支脚本的域名都在里面，所以这里登记的范围等于
 * 「用户自己装过的那几支音源可能连的服务器」。没有装任何音源时不登记任何东西。
 */
export const syncLxSourceHosts = async (scripts: string[]): Promise<void> => {
    if (!hasNativeHttp()) return;
    const hosts = new Set<string>();
    for (const script of scripts) {
        for (const host of lxScriptHosts(script)) hosts.add(host);
    }
    for (const host of hosts) {
        if (grantedLxHosts.has(host)) continue;
        grantedLxHosts.add(host);
        await registerSelfHostedService(`https://${host}/`).catch(() => undefined);
    }
};

/**
 * 原生拒绝一台主机时，从错误里取出那个主机名（C1 的补登、M16 的跳转逐跳复核共用）。
 *
 * 原生会回两种：
 *   - `host is not allowlisted: <host>`：请求的第一跳就不在白名单里（见 FoliaNativeAccess）；
 *   - `redirect not allowed: <host>`：跳转要去的下一台主机不在授权集合里（M16 的逐跳复核）。
 *
 * 认不出来就回 null —— 别把别的错误也当成「补登一下就重试」。
 */
const nativeDeniedHostOf = (error: unknown): string | null => {
    const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error ?? '');
    const matched = /(?:host is not allowlisted|redirect not allowed):\s*([a-z0-9.:_-]+)/i.exec(message);
    return matched ? matched[1].toLowerCase() : null;
};

/** 单次请求最多补登这么多次（一次跳转链 + 一次重试就够）。 */
const MAX_GRANTS_PER_REQUEST = 2;

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
                // 跳转逐跳复核（M16）：原生那边一旦被跳到授权集合以外的主机就直接报错（带
                // `redirect not allowed:`），由下面的补登那一层决定要不要把这台主机收进白名单。
                redirect: 'follow-strict',
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

    /**
     * 原生拒绝一跳时，把那个主机补登进来再试一次（C1 / M16）。
     *
     * 为什么需要这一层：脚本里的地址常常是运行时拼出来的（读配置、解密串、跟随跳转），
     * [lxScriptHosts] 扫字面量扫不到，于是第一次请求会被原生拒。补登的依据是「这支已装
     * 音源真的在向这台服务器要东西」，比静默放行窄得多，也不会让白名单彻底形同虚设。
     *
     * M16 之后跳转也走这里：原生对每一跳复核目标主机，越界那一跳回自己「不在集合里」，
     * 于是「跳转去 CDN」这种正常用法照样能用，而跳去哪台主机仍然是被这里记下来的一台。
     *
     * 只对这两种错补登，别的错原样抛；补登上限 2 次，防止被一个恶意脚本用无限跳转拖成
     * 任意主机放行。
     */
    const runWithGrant = async (grantDepth = 0): Promise<Response> => {
        try {
            return await run();
        } catch (error) {
            const host = nativeDeniedHostOf(error);
            if (!host || grantDepth >= MAX_GRANTS_PER_REQUEST) throw error;
            if (!grantedLxHosts.has(host)) {
                grantedLxHosts.add(host);
                await registerSelfHostedService(`https://${host}/`).catch(() => undefined);
            }
            return runWithGrant(grantDepth + 1);
        }
    };

    runWithGrant()
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
