// src/services/aiNativeFetch.ts
// 浏览器直接请求 AI 服务会被 CORS 拦掉，安卓容器里改用已经存在的原生 OkHttp 桥转发。
//
// 那条转发本身与 AI 无关，已经抽到 services/nativeHttpFetch（别处也在用它绕过同源检查）；
// 这里是 AI 这个**用法**：更宽的超时 + 云缓存那条旁路。

import { createNativeFetch, isNativeHttpFetchAvailable, type NativeHttpPlugin } from './nativeHttpFetch';

/** AI 请求通常比接口调用慢，给一个比默认 45s 更宽的上限。 */
export const AI_REQUEST_TIMEOUT_MS = 180_000;

type NativeAiPlugin = NativeHttpPlugin & {
    /*
     * 云缓存的原生读法（FoliaNativePlugin.aiCloudCacheGet）。
     *
     * 可选：老版本 App 没有这个方法，那时照旧走 httpRequest 那条通用路。
     */
    aiCloudCacheGet?: (options: { key: string; url: string }) => Promise<{
        ok?: boolean;
        body?: string;
        cached?: boolean;
    } | null>;
    /*
     * 原生替网页发一次 AI 请求（FoliaNativePlugin.aiRequest）。
     *
     * 可选：老版本 App 没有这个方法，回落 httpRequest。
     */
    aiRequest?: (options: {
        url: string;
        method: string;
        headers: Record<string, string>;
        body: string;
    }) => Promise<{ ok?: boolean; status?: number; body?: string } | null>;
};

const getNativePlugin = (): NativeAiPlugin | null => {
    if (typeof window === 'undefined') return null;
    const capacitor = (window as unknown as {
        Capacitor?: {
            isPluginAvailable?: (name: string) => boolean;
            isNativePlatform?: () => boolean;
            getPlatform?: () => string;
            Plugins?: { FoliaNative?: NativeAiPlugin };
        };
    }).Capacitor;
    if (!capacitor) return null;
    if (capacitor.isNativePlatform?.() !== true && capacitor.getPlatform?.() !== 'android') return null;
    if (typeof capacitor.isPluginAvailable === 'function' && !capacitor.isPluginAvailable('FoliaNative')) return null;
    return capacitor.Plugins?.FoliaNative ?? null;
};

export const isAiBridgeFetchAvailable = (): boolean => isNativeHttpFetchAvailable();

/**
 * 安卓上读一条 AI 云缓存：请求由原生发出，答案留在原生侧。
 *
 * 为什么要绕开 httpRequest 那套通用转发：那一次是**网页发起**的，界面退到后台之后
 * WebView 的 JS 会被节流甚至冻住 —— 发起的那一步就卡在那儿，或者回调回来时 JS 已经
 * 不在跑，于是「切了歌，云缓存一次都没问」。交给原生，OkHttp 在自己的线程池里把请求
 * 做完，网页什么时候回来问都能拿到。
 *
 * 回的是**服务端响应体原文**，解析留给调用方；拿不到（没有这个方法、桥出错）返回 null，
 * 调用方照旧回落。
 */
export const fetchAiCacheViaNative = async (
    key: string,
    url: string,
): Promise<{ ok: boolean; body: string } | null> => {
    const plugin = getNativePlugin();
    if (!plugin?.aiCloudCacheGet) return null;
    try {
        const result = await plugin.aiCloudCacheGet({ key, url });
        if (!result || typeof result.body !== 'string' || !result.body) return null;
        return { ok: result.ok !== false, body: result.body };
    } catch {
        return null;
    }
};

/**
 * 原生替网页发一次 AI 请求（`FoliaNativePlugin.aiRequest`）。
 *
 * 与 `createAiFetch` 的区别只在「谁来发」：
 *   · `createAiFetch` 也是走原生 OkHttp（见 nativeHttpFetch），但**发起方是网页**——
 *     退到后台后 WebView 的 JS 被系统挂起，请求出得去，回来的那一刻却没人接着跑，
 *     于是「后台切歌，AI 主题一次都没生成」。
 *   · 这里整趟都交给原生：OkHttp 在自己的线程池里做完，结果原样交回。
 *
 * 拿不到（老版本没这个方法 / 桥出错）返回 null，调用方回落 `createAiFetch`。
 */
export const requestAiViaNative = async (
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ ok: boolean; status: number; body: string } | null> => {
    const plugin = getNativePlugin();
    if (!plugin?.aiRequest) return null;
    try {
        const result = await plugin.aiRequest({
            url,
            method: (init.method || 'POST').toUpperCase(),
            headers: init.headers ?? {},
            body: init.body ?? '',
        });
        if (!result || typeof result.body !== 'string') return null;
        return {
            ok: result.ok !== false,
            status: typeof result.status === 'number' ? result.status : 200,
            body: result.body,
        };
    } catch {
        return null;
    }
};

/**
 * 返回一个与 fetch 同形的函数：安卓上走原生桥，其他平台回落到全局 fetch。
 * 只覆盖 AI 需要的用法（JSON 文本请求体），不做流式读取。
 *
 * ⭐ 有 `aiRequest`（原生替发）时**一律走原生**，不再分前后台。
 *
 * 以前只在前台不可见时才切过去 —— 判据是 `document.visibilityState`。但「页面可见」
 * 不等于「JS 活得好好的」：WebView 冻结 / 节流期间请求可能卡在发起那一行，或者 OkHttp
 * 回来了却没有人接着跑后半段。AI 云缓存那几条（候选解析 / 按键直取 / 上传）全都从
 * 这里出，冻住时表现就是「云缓存拉取没走原生」—— 主题高亮色拉不回来。
 * `aiRequest` 整趟由 OkHttp 在自己的线程池里做完，不依赖 JS 在跑；前台跑它的代价
 * 只是少了一些 header 细节覆盖，而 AI 这几条全是简单 JSON，用不到。
 *
 * 原生那条路不通（老版本没这个方法 / 桥出错）：回落 OkHttp 通用转发那条，别把请求丢掉。
 */
export const createAiFetch = (): typeof fetch => {
    const base = createNativeFetch(AI_REQUEST_TIMEOUT_MS);
    const plugin = getNativePlugin();
    if (!plugin?.aiRequest) return base;

    return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = typeof Request !== 'undefined' && input instanceof Request ? input : null;
        const url = request?.url ?? String(input);
        const headers = new Headers(request?.headers || init?.headers || {});
        const headerObject: Record<string, string> = {};
        headers.forEach((value, name) => {
            headerObject[name] = value;
        });
        const rawBody = init?.body ?? null;
        const bodyText = typeof rawBody === 'string' ? rawBody : rawBody == null ? '' : String(rawBody);

        const result = await requestAiViaNative(url, {
            method: init?.method || request?.method || 'POST',
            headers: headerObject,
            body: bodyText,
        });
        if (!result) return base(input, init);
        return new Response(result.body, {
            status: result.status,
            headers: { 'content-type': 'application/json' },
        });
    }) as typeof fetch;
};
