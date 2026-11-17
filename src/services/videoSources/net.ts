// src/services/videoSources/net.ts
// 影视源的取数通道。桌面版有 CORS 限制（webSecurity 开着），第三方影视配置与 CMS 接口几乎都不带
// 跨域头，所以在桌面版优先走主进程转发（若宿主自己注册了 `window.electron.lxFetch`：
// 主进程发请求、把文本带回来，环回与私网地址会被主进程拒绝）。网页版没有主进程，退化成直连 fetch。
//
// 只做「拿到文本」：配置要么是 JSON、要么是图片（图片形态在这里拿不到二进制，会明确报错而不是返回乱码）。

export type VideoHttpResponse = {
    ok: boolean;
    status: number;
    bodyText: string;
};

const HTTP_TIMEOUT = 12000;

/**
 * 桌面端的主进程取数通道。
 *
 * 本仓库的内核没有这条 IPC：它由宿主的那份集成在 preload 里注册成 `window.electron.lxFetch`
 * （主进程发请求、只把文本带回来，并且会拒绝环回与私网地址）。所以这里按「宿主有就有、没有就没有」
 * 取：有它就走主进程转发绕开 CORS 并复用那套地址拦截，没有就退回渲染层直连 `fetch`（受同源策略约束）。
 */
export type DesktopFetchResult = {
    ok: boolean;
    status: number;
    bodyText?: string;
    error?: string;
};

export type DesktopFetch = (
    url: string,
    init: { method: 'GET'; headers?: Record<string, string> },
) => Promise<DesktopFetchResult>;

export const desktopFetch = (): DesktopFetch | undefined => {
    if (typeof window === 'undefined') return undefined;
    const host = window as unknown as { electron?: { lxFetch?: DesktopFetch } };
    return host.electron?.lxFetch;
};

/**
 * 冒充 TVBox 客户端的那套请求头。
 * 影视配置与站点接口普遍按 UA 认人：浏览器 UA 会被 403 或被喂一份空配置，
 * 而 TVBox 自己发的是 okhttp 的 UA。这里默认就带上，需要时再按站点覆盖。
 */
export const TVBOX_HEADERS: Record<string, string> = {
    'User-Agent': 'okhttp/3.15',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
};

/** 桌面版走主进程转发，网页版直连；headers 会并到 TVBox 那套头上。 */
export const fetchVideoText = async (
    url: string,
    signal?: AbortSignal,
    headers?: Record<string, string>,
): Promise<VideoHttpResponse> => {
    const merged = { ...TVBOX_HEADERS, ...headers };
    const desktop = desktopFetch();
    if (desktop) {
        const result = await desktop(url, { method: 'GET', headers: merged });
        if (!result.ok) {
            throw new Error(result.error || `HTTP ${result.status}`);
        }
        return { ok: true, status: result.status, bodyText: result.bodyText ?? '' };
    }
    const response = await fetch(url, { signal, redirect: 'follow', headers: merged });
    return { ok: response.ok, status: response.status, bodyText: await response.text() };
};

/** 12 秒超时的取数（与主进程那条通道的预算一致）。 */
export const fetchVideoTextWithTimeout = async (url: string): Promise<VideoHttpResponse> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT);
    try {
        return await fetchVideoText(url, controller.signal);
    } finally {
        clearTimeout(timer);
    }
};

/**
 * 拿原始字节（要判是不是图片藏配置）。
 * 桌面版走主进程已经注册好的 `folia-lx://stream` 协议：它把上游的字节原样透传、带 CORS 头，
 * 渲染层可以直接 fetch，拿到的是 Blob 而不是文本；网页版直连。
 */
export const fetchVideoBytesWithTimeout = async (url: string, timeoutMs = HTTP_TIMEOUT): Promise<Blob> => {
    const desktop = desktopFetch();
    const target = desktop
        // eslint-disable-next-line no-restricted-syntax -- 这个自定义协议的地址只能由这里拼
        ? `folia-lx://stream?url=${encodeURIComponent(url)}`
        : url;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(target, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.blob();
    } finally {
        clearTimeout(timer);
    }
};
