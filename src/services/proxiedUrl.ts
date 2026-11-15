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
//
// 注意：Android 包里没有配 VITE_FOLIA_API_BASE，`resolveFoliaApiUrl` 在这种情况下
// 是**直接抛异常**的。之前洛雪音源调用它时没人接这个异常，于是「音源的服务器域名不在
// 白名单里」就等于「这次请求当场失败」—— 大部分音源就是这么死的。这里退回原地址，
// 让请求照原样发出去（安卓侧应优先走 nativeHttpRequest 绕开 CORS）。

const canBridge = (targetUrl: string): boolean => {
  try {
    return isCapacitorAndroid() && isBridgedApiUrl(targetUrl);
  } catch {
    return false;
  }
};

export const resolveProxiedUrl = (targetUrl: string): string => {
  if (canBridge(targetUrl)) return targetUrl;
  try {
    return resolveFoliaApiUrl(`lyric-proxy?url=${encodeURIComponent(targetUrl)}`);
  } catch {
    // 安卓上没有可用的转发服务：原地址返回，谁需要绕 CORS 谁自己走原生桥。
    return targetUrl;
  }
};
