// Android 专用：让内置在 App 里的 Folia Bridge API 模块相信自己正跑在浏览器扩展里，
// 所有需要特权的动作（Cookie、跨域请求）都转交给原生 Capacitor 插件 FoliaNative。
//
// 装好之后，页面侧的 foliaExtensionBridge 发来的 FOLIA_API_REQUEST 会被转给
// src/nativeBridge/api/folia.js —— 网易云 / QQ / 酷狗的接口代码就在这包里，
// 因此扫码登录、取曲库这些事不再需要任何外部自建服务器。

import { isCapacitorAndroid } from '../platform/runtime';

// src/services/nativeAndroidBridge.ts
// Android 专用的「冒充 Folia Bridge 扩展」层：装上 chrome.* 兼容层、把白名单主机的 fetch 转到原生
// OkHttp、并在页面与内置 API 模块（src/nativeBridge/api/folia.js）之间转发 FOLIA_API_REQUEST。

const PAGE_SOURCE = 'folia-web-page';
const BRIDGE_SOURCE = 'folia-extension-bridge';
const BRIDGE_VERSION = 'android-0.1.0';

/**
 * 这一会话与页面共用的随机 nonce（M2）。
 *
 * 以前这条通道只靠 `source` 这个公开字符串认身份：同页任何脚本都能监听 postMessage 拿到
 * 请求 id，抢先发一条 `FOLIA_API_RESPONSE`，页面就当真的用了；反过来桥也不认页面，
 * 谁发 `FOLIA_API_REQUEST` 都照做。
 *
 * 现在桥在启动时生成一个 16 字节的随机 nonce 并在 READY 里交给页面；页面发 PING / 请求时
 * 带上它，桥回的每一条应答也带上它，任一侧对不上一律丢掉。拿不到
 * `crypto.getRandomValues` 时桥的应答**不带** nonce，页面那边也因此判它不就绪 —— 宁可
 * 通道不可用，也不留一条能被冒充的路。
 */
const createBridgeNonce = (): string => {
  const source = typeof crypto !== 'undefined' ? crypto : undefined;
  if (!source || typeof source.getRandomValues !== 'function') return '';
  const bytes = new Uint8Array(16);
  source.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const bridgeNonce = createBridgeNonce();

/** 页面这条消息带的是不是本桥的 nonce（桥拿不到 nonce 时一律不认）。 */
const carriesBridgeNonce = (data: Record<string, any>): boolean => (
  Boolean(bridgeNonce) && data.nonce === bridgeNonce
);

// 上游某个节点挂住（比如酷狗某个 CDN 不回包）时不让页面一直等到 OkHttp 自己的 45 秒读超时，
// 那已经长到像是卡死了。AI 与图片请求直接调插件，各自有自己的预算。
const BRIDGED_REQUEST_TIMEOUT_MS = 15000;
// Cookie 调用本身是毫秒级的事，但 Capacitor 有可能丢回包（插件抛异常、WebView 重载），
// 而页面侧那条桥请求并没有自己的定时器。登录就卡在这些调用上：手机端明明已经确认了，
// 二维码弹窗却因为没等到回包一直停在「等待扫码」。所以每个 cookie 调用都必须在预算内结束。
const COOKIE_CALL_TIMEOUT_MS = 4000;

/**
 * cookie 调用没拿到答案（超时 / 桥抛错）时抛的错误。
 *
 * 为什么不能像以前那样在这时回空值：`[]` / `null` 在上层和「确实没有这条 cookie」是同一个样子，
 * 于是桥抖一下（登录时原生线程争用、插件异常、WebView 重载）就被读成「用户没登录」，
 * 界面引导重新登录，`accountRead` 那一路还会把登录状态判成失效、连带清掉本地凭据 ——
 * 一次临时故障变成持久的登出（H4，见 nativeAndroidBridge 的 cookie 前缀说明）。
 *
 * 上层的用法是 `withCookieFallback`：只有确实读不到时才回空，这里抛出来的一律当作
 * 「暂时读不到」往上带，由 `cookies.js` 的 `CookieReadError` 说清是哪一种。
 */
export class NativeCookieCallError extends Error {
  readonly reason: 'timeout' | 'native-error';
  /** 超时是这么久没回包；其余是桥上抛的原始错误。 */
  readonly cause?: unknown;

  constructor(reason: 'timeout' | 'native-error', label: string, cause?: unknown) {
    super(`[FoliaNativeBridge] ${label} ${reason === 'timeout' ? `timed out after ${COOKIE_CALL_TIMEOUT_MS}ms` : 'failed'}`);
    this.name = 'NativeCookieCallError';
    this.reason = reason;
    this.cause = cause;
  }
}

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
  // 洛雪音源脚本会去各家自己的主机取播放地址（QQ 音乐的 u6/isure、咪咕、网易云图床），
  // 这些请求同样只能靠原生代理绕开 CORS，漏一个就是「音源取不到地址」。
  'y.qq.com',
  'qqmusic.qq.com',
  'migu.cn',
  '126.net',
  'api.qrserver.com',
  // 封面：这几个 CDN 不下发 CORS 头，coverCache 用 fetch 取字节存缓存时在浏览器里必然失败。
  // 走原生桥取回字节就没有同源问题了。
  'y.gtimg.cn',
  'kgimg.com',
  // B 站的图床：封面按热点封来源，WebView 的 <img> 直连隔三差五 403（探索页、歌单、
  // 番剧季的封面都在这主机上）。进桥接名单后 fetch 走原生 OkHttp（能带 B 站 Referer），
  // coverCache 先把字节存进缓存，之后展示走本地 object URL，403 就见不到了。
  'hdslb.com',
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
    /** 文本类响应（#262）：原生已按 UTF-8 解好，优先用它。 */
    bodyText?: string;
    bodyBase64?: string;
    byteLength?: number;
  }>;
};

type ApiHandler = (input: Record<string, unknown>) => Promise<unknown>;

let apiHandler: ApiHandler | null = null;
const queuedRequests = new Map<string, Record<string, unknown>>();

const getPlugin = (): NativePlugin | null => {
  const capacitor = (window as any).Capacitor;
  return capacitor?.Plugins?.FoliaNative ?? null;
};

/** postMessage 的目标 origin 收窄到本页自己的 origin（M2）；取不到时退回 '*'，隔离靠 nonce。 */
const pageOrigin = (): string => {
  try {
    const value = String(window.location?.origin || '');
    return value && value !== 'null' ? value : '*';
  } catch {
    return '*';
  }
};

const postToPage = (payload: Record<string, unknown>) => {
  // 每条应答都带上本桥的 nonce（M2）：页面只认带回同一个 nonce 的那一条。
  window.postMessage({ source: BRIDGE_SOURCE, nonce: bridgeNonce, ...payload }, pageOrigin());
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
/**
 * 把 chrome.cookies / chrome.storage.local 的兼容层装到 `globalThis.chrome` 上。
 *
 * 导出是为了让单测能直接驱动这一层（尤其是 4 秒预算与三态）：正常路径只由
 * `installNativeAndroidBridge` 调。
 */
export const installCookieShim = (plugin: NativePlugin) => {
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
  /**
   * 每个 cookie 调用都在预算内收敛：丢包时抛 NativeCookieCallError，不能把登录永远挂在等待里。
   *
   * 以前这里超时和异常都 `resolve(fallback)`，把「读不到」压成了「没有」。现在只负责在预算内结束，
   * 成功与失败的区分交给返回的 `{ ok }`，由 `cookies.js` 的 `withCookieFallback` 决定哪种能回空。
   */
  const callPlugin = <T,>(label: string, run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: NativeCookieCallError }> => {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const work = (async (): Promise<{ ok: true; value: T } | { ok: false; error: NativeCookieCallError }> => {
      try {
        return { ok: true, value: await run() };
      } catch (error) {
        console.warn(`[FoliaNativeBridge] ${label} failed`, error);
        return { ok: false, error: new NativeCookieCallError('native-error', label, error) };
      }
    })();
    const deadline = new Promise<{ ok: false; error: NativeCookieCallError }>((resolve) => {
      timeoutHandle = setTimeout(() => {
        console.warn(`[FoliaNativeBridge] ${label} timed out after ${COOKIE_CALL_TIMEOUT_MS}ms`);
        resolve({ ok: false, error: new NativeCookieCallError('timeout', label) });
      }, COOKIE_CALL_TIMEOUT_MS);
    });
    return Promise.race([work, deadline]).finally(() => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    });
  };
  /** 读：拿不到答案一律抛出，绝不回空值 —— 空值只能表示「确实没有这条 cookie」。 */
  const readOrThrow = async <T,>(label: string, read: () => Promise<T>): Promise<T> => {
    const result = await callPlugin(label, read);
    if (!result.ok) throw result.error;
    return result.value;
  };
  /** 写 / 删：失败照旧只记一行、照旧半路返回，调用方本来就不靠它的返回值判断成败。 */
  const writeTolerantly = async (label: string, write: () => Promise<unknown>): Promise<boolean> => {
    const result = await callPlugin(label, write);
    return result.ok;
  };
  chromeObject.cookies = {
    getAll: async (details: Record<string, unknown> = {}) => readOrThrow(
      'cookies.getAll',
      async () => (await plugin.cookiesGetAll(details)).cookies || [],
    ),
    get: async (details: Record<string, unknown>) => readOrThrow(
      'cookies.get',
      async () => (await plugin.cookiesGet(details)).cookie || null,
    ),
    set: async (details: Record<string, unknown>) => {
      await writeTolerantly('cookies.set', () => plugin.cookiesSet(details));
      return details;
    },
    remove: async (details: Record<string, unknown>) => {
      const ok = await writeTolerantly('cookies.remove', () => plugin.cookiesRemove(details));
      return ok ? details : null;
    },
    // 非标准扩展：一次删一批 cookie。切换登录通道要清几十条，逐条过桥会拖过调用方的
    // 截止时间、结果只清掉一半。失败或超时返回 null，调用方会退回逐条删除。
    removeBatch: async (entries: Array<{ url: string; name: string }>) => {
      const ok = await writeTolerantly('cookies.removeBatch', () => plugin.cookiesRemoveBatch({ entries }));
      return ok ? entries : null;
    },
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

/** 能不能把请求交给原生 OkHttp（安卓且插件已注册）。 */
export const hasNativeHttp = (): boolean => isCapacitorAndroid() && getPlugin() != null;

export type NativeHttpOptions = {
  method?: string;
  headers?: Record<string, string>;
  bodyText?: string;
  bodyBase64?: string;
  redirect?: string;
  /** 读超时。音频地址那类链路常要等 CDN 首包，可以放宽。 */
  timeoutMs?: number;
};

/**
 * 原始 Set-Cookie 在桥接响应上挂哪（M1）。
 *
 * 与 src/nativeBridge/api/setCookieHeaders.js 的 NATIVE_RAW_SET_COOKIES 是同一个键：
 * `Symbol.for` 的注册表在两个模块里给出同一个 symbol，于是内置接口代码直接读这个属性即可，
 * 不需要响应头上任何「看得见」的东西 —— 页面上别的脚本拿到的 Response 里没有它，
 * `Set-Cookie` 也仍然是禁止暴露给 JS 的响应头。
 */
const NATIVE_RAW_SET_COOKIES = Symbol.for('folia.native.rawSetCookies');

type RawCookieCarrier = { [NATIVE_RAW_SET_COOKIES]?: string[] };

/**
 * 这条响应里的原始 Set-Cookie（只对内置接口代码显式索取过的那几次非空）。
 *
 * 页面上任何别的脚本拿到的 `Response` 头上没有 Set-Cookie，也没有 M1 之前的镜像头；
 * 拿到的只有桥自己的代码能认的那个符号属性 —— 而且只有 `keepRawSetCookies` 时才有。
 */
export const nativeRawSetCookies = (response: Response): string[] => (
  (response as unknown as RawCookieCarrier)[NATIVE_RAW_SET_COOKIES] || []
);

/** 忘掉这条响应上的原始 Set-Cookie（记忆只在内存里，丢掉之后回空数组）。 */
export const nativeDropRawSetCookies = (response: Response): void => {
  delete (response as unknown as RawCookieCarrier)[NATIVE_RAW_SET_COOKIES];
};

/**
 * 直接走原生 OkHttp 发一个请求，**不设主机白名单**。
 *
 * 为什么需要它：洛雪音源脚本会去它自己的服务器（域名千奇百怪）取地址，那些主机
 * 不可能进 API_HOSTS；而 `resolveProxiedUrl` 在安卓上没有配置 API 基地址时是
 * 直接抛异常的 —— 于是每个音源的第一步请求就死了，表现就是「导入了一堆音源，
 * 大部分都取不到地址」。安卓上根本没有可用的转发服务端，能绕开 CORS 的只有原生桥。
 *
 * 安全边界和别处一致：请求由页面里已经跑着的代码发起，跟 WebView 自己发 fetch 等价。
 */
export const nativeHttpRequest = async (
  url: string,
  options: NativeHttpOptions = {},
  internal: { keepRawSetCookies?: boolean } = {},
): Promise<Response> => {
  const plugin = getPlugin();
  if (!plugin) throw new Error('FoliaNative plugin is not available');
  const method = (options.method || 'GET').toUpperCase();
  const timeoutMs = options.timeoutMs ?? BRIDGED_REQUEST_TIMEOUT_MS;

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const result = await Promise.race([
    plugin.httpRequest({
      url,
      method,
      headers: options.headers || {},
      bodyText: options.bodyText || '',
      bodyBase64: options.bodyBase64 || '',
      redirect: options.redirect || 'follow',
    }),
    new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`Bridged request timed out after ${timeoutMs}ms: ${method} ${url}`)),
        timeoutMs,
      );
    }),
  ]).finally(() => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  });

  // 文本响应原生给 bodyText（#262），二进位才是 base64 —— 两种都在这里收口。
  const responseBytes = typeof result.bodyText === 'string'
    ? new TextEncoder().encode(result.bodyText)
    : base64ToBytes(result.bodyBase64);
  const responseBuffer = responseBytes.buffer.slice(
    responseBytes.byteOffset,
    responseBytes.byteOffset + responseBytes.byteLength,
  ) as ArrayBuffer;
  const responseHeaders = new Headers();
  const rawSetCookies: string[] = [];
  if (Array.isArray(result.headers)) {
    result.headers.forEach((entry) => {
      if (!entry?.name || entry.value == null) return;
      // Headers.set() 会把重复项折叠成一个，所以重复出现的头要逐个 append，
      // 否则服务端下发的多个 cookie 只剩最后一个 —— 登录态就是这么丢的。
      if (entry.name.toLowerCase() === 'set-cookie') {
        rawSetCookies.push(String(entry.value));
      } else {
        responseHeaders.append(entry.name, String(entry.value));
      }
    });
  } else if (result.headers) {
    Object.entries(result.headers).forEach(([name, value]) => {
      if (value != null) responseHeaders.set(name, String(value));
    });
  }
  /*
   * Set-Cookie 的交付方式（M1）。
   *
   * 以前这里把同一批值再镜像进一个 JS 能读的自定义头（x-folia-set-cookie）。镜像头对**所有**
   * 调用方一视同仁，于是页面上任意一段脚本只要发一次登录相关的请求，就能读到 qrsig / p_skey /
   * NMTID 这些本该只躺在 Cookie 罐里的原始值 —— 浏览器刻意维持的 HttpOnly 语义被绕开了。
   *
   * 现在不再有镜像头，连 Set-Cookie 都不往 Response 的头上写：
   *   · 内置的接口代码要这几个值，读 nativeRawSetCookies（桥这一侧本来就能读 CookieManager），
   *     而且只有它自己显式要的那几次请求（`internal.keepRawSetCookies`）才会在内存里留一份；
   *   · 页面上任何别的脚本拿到的 Response 与浏览器里一模一样 —— 既没有镜像头，也没有 Set-Cookie。
   */
  const bridged = new Response(responseBuffer, {
    status: result.status,
    headers: responseHeaders,
  });
  // 头上那份在 WebView 里会被静默丢掉（`Set-Cookie` 是禁止暴露的响应头）；桥自己的代码读这里的。
  if (internal.keepRawSetCookies && rawSetCookies.length) {
    Object.defineProperty(bridged, NATIVE_RAW_SET_COOKIES, {
      value: rawSetCookies,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
  return bridged;
};

const installFetchShim = (plugin: NativePlugin) => {
  const originalFetch = window.fetch.bind(window);
  /**
   * 白名单主机上有没有人在等「响应里的 Set-Cookie」。
   *
   * 只有内置的接口代码会打开它（`bypass: 'bridge'`，见 nativeBridge/api 里的 fetchWithCookies）：
   * 那几次请求的原始 Set-Cookie 要留在内存里交给它们读（M1）。页面脚本随时可以伪造同一个
   * 字段，所以它只决定「桥这一侧要不要把值留在内存」，**不会**让任何人从 Response 上读到它们。
   */
  let awaitingBridgeCookies = 0;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const rawUrl = request?.url ?? String(input);
    if (!isBridgedApiUrl(rawUrl)) {
      return originalFetch(input, init);
    }

    // 白名单主机的请求统一从这里出：原生 OkHttp 不受 CORS 约束。
    // 回包的 Set-Cookie 只进 Cookie 罐与内置 API 模块，页面脚本读不到（见 nativeHttpRequest）。
    const method = (init?.method || request?.method || 'GET').toUpperCase();
    const headers = new Headers(request?.headers || init?.headers || {});
    const serialized = await serializeBody(init?.body ?? null);
    if (serialized.contentType && !headers.has('content-type')) {
      headers.set('content-type', serialized.contentType);
    }
    const wantsRawCookies = (init as { bypass?: unknown } | undefined)?.bypass === 'bridge';
    if (wantsRawCookies) awaitingBridgeCookies += 1;
    try {
      const response = await nativeHttpRequest(rawUrl, {
        method,
        headers: Object.fromEntries(headers.entries()),
        bodyText: serialized.bodyText,
        bodyBase64: serialized.bodyBase64,
        redirect: init?.redirect || request?.redirect || 'follow',
      }, { keepRawSetCookies: wantsRawCookies });
      /*
       * 值本来就不在 Response 的头上（`Set-Cookie` 是 JS 读不到的头），这里再收一次口子：
       * 这期间没有内置接口代码在等着读，就把内存里那份也丢掉 —— 一次无关的请求不该让
       * 平台凭据在桥的内存里多躺一份。
       */
      if (!wantsRawCookies || awaitingBridgeCookies > 1) nativeDropRawSetCookies(response);
      return response;
    } finally {
      if (wantsRawCookies) awaitingBridgeCookies -= 1;
    }
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
      // 请求也必须带本桥的 nonce（M2）：别的脚本照着格式发，也拿不到应答。
      if (!carriesBridgeNonce(data)) {
        console.warn('[FoliaNativeBridge] dropped an api request without this session\'s nonce');
        return;
      }
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
