import { isAndroidAppShell } from '../platform/runtime';

// 当前文件：解析 Web 与 Capacitor 共用的 Folia 服务端 API 地址。

export interface FoliaApiResolutionOptions {
  apiBase?: string | null;
  capacitorAndroid?: boolean;
}

/**
 * 本地桥的哨兵值：写 `extension` 表示「登录与曲库走内置接口，不出网」。
 *
 * 那几家音乐的流量另有去处（见 services/foliaExtensionBridge.ts），但 AI 主题之类的
 * 服务端能力确实没有后端可用了。这里把它当成「没配后端」，于是这些调用落到同源的
 * `/api/...` 上并得到一个明确的 404，而不是去请求一个叫 extension 的主机。
 */
const isExtensionSentinel = (value: string): boolean => (
  ['extension', 'folia-extension'].includes(value.toLowerCase())
);

const readConfiguredApiBase = (): string => {
  const value = String(import.meta.env.VITE_FOLIA_API_BASE || '').trim().replace(/\/+$/, '');
  return isExtensionSentinel(value) ? '' : value;
};

const normalizeApiBase = (value: string): string => value.replace(/\/+$/, '');
const normalizeEndpoint = (value: string): string => value.replace(/^\/+/, '').replace(/^api\/+/, '');

// Builds one API URL while preserving the existing same-origin Web fallback.
export const resolveFoliaApiUrl = (
  endpoint: string,
  options: FoliaApiResolutionOptions = {},
): string => {
  const configuredBase = options.apiBase === undefined
    ? readConfiguredApiBase()
    : String(options.apiBase || '').trim();
  // 用 isAndroidAppShell 而不是 isCapacitorAndroid：后者在冷启动桥尚未初始化时为 false，
  // 会把安卓请求错误放行到同源 /api/...（WebView 回 index.html），导致 JSON 解析失败。
  const capacitorAndroid = options.capacitorAndroid ?? isAndroidAppShell();
  const normalizedEndpoint = normalizeEndpoint(endpoint);

  if (configuredBase) {
    return `${normalizeApiBase(configuredBase)}/${normalizedEndpoint}`;
  }

  if (capacitorAndroid) {
    throw new Error('VITE_FOLIA_API_BASE must be configured for the Capacitor Android build.');
  }

  return `/api/${normalizedEndpoint}`;
};
