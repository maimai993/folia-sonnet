// src/services/fontMarket/http.ts
//
// 字体天下的页面抓取。
//
// 为什么走原生桥：站点不会给 `capacitor://localhost` 发 CORS 头，
// WebView 里裸 fetch 会被拦。安卓上用 OkHttp（nativeHttpFetch），
// 其它平台它自己回落到全局 fetch。

import { createNativeFetch } from '../nativeHttpFetch';

/** 列表页约 100 KB，详情页几十 KB；给足到 4 MB。 */
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

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
