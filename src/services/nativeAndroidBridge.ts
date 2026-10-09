// Android 专用：让内置在 App 里的 Folia Bridge API 模块相信自己正跑在浏览器扩展里，
// 所有需要特权的动作（Cookie、跨域请求）都转交给原生 Capacitor 插件 FoliaNative。
//
// 装好之后，页面侧的 foliaExtensionBridge 发来的 FOLIA_API_REQUEST 会被转给
// src/nativeBridge/api/folia.js —— 网易云 / QQ / 酷狗的接口代码就在这包里，
// 因此扫码登录、取曲库这些事不再需要任何外部自建服务器。

import { isCapacitorAndroid } from '../platform/runtime';

const PAGE_SOURCE = 'folia-web-page';
const BRIDGE_SOURCE = 'folia-extension-bridge';
const BRIDGE_VERSION = 'android-0.1.0';
// 上游某个节点挂住（比如酷狗某个 CDN 不回包）时不让页面一直等到 OkHttp 自己的 45 秒读超时，
// 那已经长到像是卡死了。AI 与图片请求直接调插件，各自有自己的预算。
const BRIDGED_REQUEST_TIMEOUT_MS = 15000;
// Cookie 调用本身是毫秒级的事，但 Capacitor 有可能丢回包（插件抛异常、WebView 重载），
// 而页面侧那条桥请求并没有自己的定时器。登录就卡在这些调用上：手机端明明已经确认了，
// 二维码弹窗却因为没等到回包一直停在「等待扫码」。所以每个 cookie 调用都必须在预算内结束。
const COOKIE_CALL_TIMEOUT_MS = 4000;

const API_HOSTS = [
  'music.163.com',
  'interface.music.163.com',
  'interface3.music.163.com',
  'c.y.qq.com',
  'u.y.qq.com',
  'ssl.ptlogin2.qq.com',
  'xui.ptlogin2.qq.com',
  'graph.qq.com',
  // 微信扫码通道：qrconnect 取 uuid、qrcode 取图、lp 长轮询都在 weixin.qq.com 下。
  // 这三个请求同样只有走原生代理才能绕开 CORS，漏掉就是一句毫无特征的 "Failed to fetch"。
  'weixin.qq.com',
  // 酷狗的接口分散在很多主机上（songsearch、complexsearch、trackercdn、vip ...）而且还在变，
  // 所以按整个域名匹配而不是逐个列举。只有留在 WebView 里的请求才受 CORS 限制；
  // 经由桥发出的请求必须在这里代理，漏掉一个主机的后果是静默返回空结果而不是报错。
  'kugou.com',
  'kuwo.cn',
  'api.qrserver.com',
  // 封面：这几个 CDN 不下发 CORS 头，coverCache 用 fetch 取字节存缓存时在浏览器里必然失败。
  // 走原生桥取回字节就没有同源问题了。
  'y.gtimg.cn',
  'kgimg.com',
];

type NativePlugin = {
  cookiesGetAll: (options: Record<string, unknown>) => Promise<{ cookies?: unknown[] }>;
  cookiesGet: (options: Record<string, unknown>) => Promise<{ cookie?: unknown }>;
  cookiesSet: (options: Record<string, unknown>) => Promise<{ ok?: boolean }>;
  cookiesRemove: (options: Record<string, unknown>) => Promise<{ ok?: boolean }>;
  cookiesRemoveBatch: (options: Record<string, unknown>) => Promise<{ ok?: boolean; removed?: number }>;
  httpRequest: (options: Record<string, unknown>) => Promise<{
    status: number;
    headers?: Array<{ name?: string; value?: string }> | Record<string, string>;
    bodyBase64?: string;
  }>;
};

type ApiHandler = (input: Record<string, unknown>) => Promise<unknown>;

let apiHandler: ApiHandler | null = null;
const queuedRequests = new Map<string, Record<string, unknown>>();

const getPlugin = (): NativePlugin | null => {
  const capacitor = (window as any).Capacitor;
  return capacitor?.Plugins?.FoliaNative ?? null;
};

const postToPage = (payload: Record<string, unknown>) => {
  window.postMessage({ source: BRIDGE_SOURCE, ...payload }, '*');
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
};

const base64ToBytes = (value?: string): Uint8Array => {
  if (!value) return new Uint8Array();
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

/** 请求必须走原生 OkHttp 代理、而不是 WebView 自己的 fetch 时为 true。 */
export const isBridgedApiUrl = (url: string): boolean => {
  try {
    const { hostname } = new URL(url, location.href);
    return API_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
};

const serializeBody = async (body: BodyInit | null | undefined): Promise<{
  bodyText?: string;
  bodyBase64?: string;
  contentType?: string;
}> => {
  if (body == null) return {};
  if (typeof body === 'string') return { bodyText: body };
  if (body instanceof URLSearchParams) {
    return {
      bodyText: body.toString(),
      contentType: 'application/x-www-form-urlencoded',
    };
  }
  const response = new Response(body as BodyInit);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    bodyBase64: bytesToBase64(bytes),
    contentType: response.headers.get('content-type') || undefined,
  };
};

/**
 * 把 chrome.* 补齐成扩展的样子。
 *
 * 内置的 API 模块是直接从浏览器扩展里搬过来的，它们读写 cookie 走 chrome.cookies、
 * 存登录态走 chrome.storage.local。这里把它们分别接到 Android CookieManager 与 localStorage，
 * 于是那份代码一行都不用改就能在 App 里跑。
 */
const installCookieShim = (plugin: NativePlugin) => {
  const chromeObject = ((globalThis as any).chrome ??= {});
  chromeObject.runtime = {
    id: 'folia-native-android',
    getManifest: () => ({ version: BRIDGE_VERSION }),
  };
  chromeObject.storage = {
    local: {
      get: async (keys?: string | string[] | null) => {
        const result: Record<string, unknown> = {};
        const requested = keys == null
          ? Object.keys(localStorage)
          : Array.isArray(keys)
            ? keys
            : [keys];
        requested.forEach((key) => {
          const value = localStorage.getItem(String(key));
          if (value != null) {
            try {
              result[String(key)] = JSON.parse(value);
            } catch {
              result[String(key)] = value;
            }
          }
        });
        return result;
      },
      set: async (values: Record<string, unknown>) => {
        Object.entries(values || {}).forEach(([key, value]) => {
          localStorage.setItem(key, JSON.stringify(value));
        });
      },
      remove: async (keys: string | string[]) => {
        const list = Array.isArray(keys) ? keys : [keys];
        list.forEach((key) => localStorage.removeItem(key));
      },
    },
  };
  /** 每个 cookie 调用都在预算内收敛：丢包时退回空结果，不能把登录永远挂在等待里。 */
  const callPlugin = <T,>(label: string, fallback: T, run: () => Promise<T>): Promise<T> => {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const work = (async () => {
      try {
        return await run();
      } catch (error) {
        console.warn(`[FoliaNativeBridge] ${label} failed`, error);
        return fallback;
      }
    })();
    const deadline = new Promise<T>((resolve) => {
      timeoutHandle = setTimeout(() => {
        console.warn(`[FoliaNativeBridge] ${label} timed out after ${COOKIE_CALL_TIMEOUT_MS}ms`);
        resolve(fallback);
      }, COOKIE_CALL_TIMEOUT_MS);
    });
    return Promise.race([work, deadline]).finally(() => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    });
  };
  chromeObject.cookies = {
    getAll: async (details: Record<string, unknown> = {}) => callPlugin(
      'cookies.getAll',
      [] as unknown[],
      async () => (await plugin.cookiesGetAll(details)).cookies || [],
    ),
    get: async (details: Record<string, unknown>) => callPlugin(
      'cookies.get',
      null,
      async () => (await plugin.cookiesGet(details)).cookie || null,
    ),
    set: async (details: Record<string, unknown>) => {
      await callPlugin('cookies.set', { ok: false }, () => plugin.cookiesSet(details));
      return details;
    },
    remove: async (details: Record<string, unknown>) => callPlugin(
      'cookies.remove',
      null,
      async () => ((await plugin.cookiesRemove(details)).ok ? details : null),
    ),
    // 非标准扩展：一次删一批 cookie。切换登录通道要清几十条，逐条过桥会拖过调用方的
    // 截止时间、结果只清掉一半。失败或超时返回 null，调用方会退回逐条删除。
    removeBatch: async (entries: Array<{ url: string; name: string }>) => callPlugin(
      'cookies.removeBatch',
      null,
      async () => {
        await plugin.cookiesRemoveBatch({ entries });
        return entries;
      },
    ),
  };
  chromeObject.declarativeNetRequest = {
    RuleActionType: { MODIFY_HEADERS: 'modifyHeaders' },
    updateSessionRules: async () => undefined,
  };
  chromeObject.tabs = {
    create: async ({ url }: { url?: string } = {}) => {
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      return {};
    },
    query: async () => [],
    onRemoved: { addListener: () => undefined },
    onUpdated: { addListener: () => undefined },
  };
};

const installFetchShim = (plugin: NativePlugin) => {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const rawUrl = request?.url ?? String(input);
    if (!isBridgedApiUrl(rawUrl)) {
      return originalFetch(input, init);
    }

    const method = (init?.method || request?.method || 'GET').toUpperCase();
    const headers = new Headers(request?.headers || init?.headers || {});
    const serialized = await serializeBody(init?.body ?? null);
    if (serialized.contentType && !headers.has('content-type')) {
      headers.set('content-type', serialized.contentType);
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const result = await Promise.race([
      plugin.httpRequest({
        url: rawUrl,
        method,
        headers: Object.fromEntries(headers.entries()),
        bodyText: serialized.bodyText || '',
        bodyBase64: serialized.bodyBase64 || '',
        redirect: init?.redirect || request?.redirect || 'follow',
      }),
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`Bridged request timed out after ${BRIDGED_REQUEST_TIMEOUT_MS}ms: ${method} ${rawUrl}`)),
          BRIDGED_REQUEST_TIMEOUT_MS,
        );
      }),
    ]).finally(() => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    });
    const responseBytes = base64ToBytes(result.bodyBase64);
    const responseBuffer = responseBytes.buffer.slice(
      responseBytes.byteOffset,
      responseBytes.byteOffset + responseBytes.byteLength,
    ) as ArrayBuffer;
    const responseHeaders = new Headers();
    const exposedSetCookies: string[] = [];
    if (Array.isArray(result.headers)) {
      result.headers.forEach((entry) => {
        if (!entry?.name || entry.value == null) return;
        // Headers.set() 会把重复项折叠成一个，所以 Set-Cookie 要逐个 append，
        // 否则服务端下发的多个 cookie 只剩最后一个 —— 登录态就是这么丢的。
        if (entry.name.toLowerCase() === 'set-cookie') {
          responseHeaders.append(entry.name, String(entry.value));
          // 但 Set-Cookie 属于禁止暴露给 JS 的响应头，这里构造 Response 时会被静默丢掉。
          // 内置的接口代码需要这些值（qrsig、p_skey、NMTID …），拿不到就只能从 cookie 罐里
          // 回捞 —— 而罐里可能还留着上一次会话的旧值，新建的二维码第一次轮询就「已失效」。
          // 所以把同一批值镜像到一个 JS 能读的头里。
          exposedSetCookies.push(String(entry.value));
        } else {
          responseHeaders.set(entry.name, String(entry.value));
        }
      });
    } else if (result.headers) {
      Object.entries(result.headers).forEach(([name, value]) => {
        if (value != null) responseHeaders.set(name, String(value));
      });
    }
    exposedSetCookies.forEach((value) => responseHeaders.append('x-folia-set-cookie', value));
    return new Response(responseBuffer, {
      status: result.status,
      headers: responseHeaders,
    });
  };
};

const flushQueuedRequests = () => {
  if (!apiHandler) return;
  queuedRequests.forEach((payload, id) => {
    void handleApiRequest(id, payload);
  });
  queuedRequests.clear();
};

const handleApiRequest = async (id: string, payload: Record<string, unknown>) => {
  if (!apiHandler) {
    queuedRequests.set(id, payload);
    return;
  }
  try {
    const data = await apiHandler(payload);
    postToPage({ type: 'FOLIA_API_RESPONSE', id, ok: true, data });
  } catch (error) {
    postToPage({
      type: 'FOLIA_API_RESPONSE',
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const installMessageBridge = () => {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data as Record<string, any> | null;
    if (!data || data.source !== PAGE_SOURCE) return;

    if (data.type === 'FOLIA_BRIDGE_PING') {
      postToPage({
        type: 'FOLIA_BRIDGE_PONG',
        ready: true,
        version: BRIDGE_VERSION,
        extId: 'folia-native-android',
      });
      return;
    }

    if (data.type === 'FOLIA_API_REQUEST' && typeof data.id === 'string') {
      void handleApiRequest(data.id, data.payload || {});
    }
  });
};

export const installNativeAndroidBridge = async (): Promise<void> => {
  if (typeof window === 'undefined') return;
  if (!isCapacitorAndroid()) return;

  const plugin = getPlugin();
  if (!plugin) {
    console.error('[FoliaNativeBridge] FoliaNative Capacitor plugin is not registered');
    return;
  }

  installCookieShim(plugin);
  installFetchShim(plugin);
  installMessageBridge();

  // @ts-ignore 内置的那份扩展代码是纯 JavaScript，没有类型声明。
  const module = await import('../nativeBridge/api/folia.js');
  apiHandler = module.handleFoliaApiRequest as ApiHandler;
  postToPage({
    type: 'FOLIA_BRIDGE_READY',
    ready: true,
    version: BRIDGE_VERSION,
    extId: 'folia-native-android',
  });
  flushQueuedRequests();
};
