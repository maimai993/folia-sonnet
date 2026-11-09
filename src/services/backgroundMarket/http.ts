// src/services/backgroundMarket/http.ts
//
// 背景市场专用的取页面函数。
//
// 为什么不能直接 fetch：这些站点是给浏览器看的，不会给 `capacitor://localhost`
// 发 CORS 头。在 WebView 里裸 fetch 会被 CORS 拦掉（预检直接失败），
// 所以安卓上必须走原生的 OkHttp 桥（nativeHttpFetch），桌面浏览器才用全局 fetch。

import { createNativeFetch } from '../nativeHttpFetch';

/** 页面往往几百 KB，给足上限；超过就当失败，不硬撑。 */
const MAX_HTML_BYTES = 6 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

/**
 * 取一个 HTML 页面。
 *
 * 原生桥在没有原生实现的平台会自己回落到全局 fetch，所以这里不用判断平台。
 */
export const fetchHtml = async (
    url: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
): Promise<Response> => {
    const send = createNativeFetch(TIMEOUT_MS, MAX_HTML_BYTES);
    return send(url, {
        method: 'GET',
        headers: {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            ...headers,
        },
        signal,
    });
};
