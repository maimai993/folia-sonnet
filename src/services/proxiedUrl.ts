import { isCapacitorAndroid } from '../platform/runtime';
import { isBridgedApiUrl } from './nativeAndroidBridge';
import { resolveFoliaApiUrl } from './webApi';

// src/services/proxiedUrl.ts
//
// 取一个「在浏览器里会被 CORS 挡住」的外部地址。
//
// 网页与桌面端要靠后端的 lyric-proxy 转发（浏览器不允许页面直连这些主机）；
// Android 上不一样：本地桥已经把这些主机的 fetch 接管到原生 OkHttp，CORS 根本不适用，
// 而 App 里也没有那个服务端可以转发。所以桥接得上的主机直接给原地址，
// 接不上的（各家 CDN 之类）照旧走 proxy。

export const resolveProxiedUrl = (targetUrl: string): string => (
  isCapacitorAndroid() && isBridgedApiUrl(targetUrl)
    ? targetUrl
    : resolveFoliaApiUrl(`lyric-proxy?url=${encodeURIComponent(targetUrl)}`)
);
