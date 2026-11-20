// 与「Folia Bridge」扩展（Android 上由原生桥冒充）之间的页面侧协议客户端。
//
// 页面与桥之间只走 window.postMessage：页面发 FOLIA_API_REQUEST，桥回 FOLIA_API_RESPONSE。
// 网页版里对面是浏览器扩展；Android 里是 nativeAndroidBridge 冒充的那个「扩展」，
// 它把请求转给内置在 App 里的 src/nativeBridge/api/folia.js，由 OkHttp 直接访问各家接口。
// 这样登录与取数据都不再依赖外部自建服务器 —— 这就是「本地登录」的入口。

const PAGE_SOURCE = 'folia-web-page';
const BRIDGE_SOURCE = 'folia-extension-bridge';
const BRIDGE_PING_TIMEOUT_MS = 800;
const BRIDGE_REQUEST_TIMEOUT_MS = 45_000;

export const FOLIA_EXTENSION_API_BASE = 'extension';

export type FoliaBridgeProvider = 'netease' | 'qq' | 'kugou' | 'bodian' | 'qq_raw';

export interface FoliaBridgeRequest {
  provider: FoliaBridgeProvider;
  operation: string;
  method?: string;
  path?: string;
  query?: Record<string, string | number | boolean | undefined>;
  params?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: number;
}

const pendingRequests = new Map<string, PendingRequest>();
let bridgeReadyPromise: Promise<boolean> | null = null;
let bridgeVersion = '';
let bridgeExtensionId = '';

/**
 * 这一会话与桥共用的随机 nonce（M2）。
 *
 * 以前页面与桥只靠 `source` 这个公开字符串区分身份，响应也只凭 `id` 关联回待办请求 ——
 * 同页任何脚本都能注册一个 `message` 监听器拿到 id 与 payload，再抢先发一条伪响应
 * （`{source: 'folia-extension-bridge', type: 'FOLIA_API_RESPONSE', id, ok: true, data}`），
 * 页面就会拿攻击者的数据完成登录 / 歌单请求，或者用 `ok: false` 让取数稳定失败。
 *
 * 现在握手指向反过来的方向：桥本来就是**先**就绪的那一侧（页面脚本很可能晚于它装好），
 * 所以桥在启动时就把 nonce 放进 READY 交出来，页面记下它；之后每一次握手（PING）与每一条
 * 请求 / 响应都必须带上这个 nonce，任一侧对不上一律丢掉。
 *
 * 页面自己的监听器在模块加载时就装好，且不等任何 await —— 于是桥在页面脚本之后才发出来的
 * READY 一定落到这里，nonce 不会错过。
 *
 * 缺 `crypto.getRandomValues` 时直接判桥不可用：早先 `createRequestId` 会退回
 * `Date.now()` + `Math.random()`，那时 id 本身就是可预测的，加 nonce 也是白加。
 */
const createNonce = (): string | null => {
  const source = typeof crypto !== 'undefined' ? crypto : undefined;
  if (!source || typeof source.getRandomValues !== 'function') return null;
  const bytes = new Uint8Array(16);
  source.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** 本页自己生成的 nonce（扩展宿主用它去握手；用不上时退回桥在 READY 里给的那个）。 */
const localNonce = createNonce();

/** 这一会话的 nonce：优先用桥交出来的，其次是本页生成的。 */
let bridgeNonce: string | null = null;

/** 应答方回显的 nonce 是不是这一会话的那一个。 */
const echoesNonce = (data: Record<string, any>): boolean => (
  Boolean(bridgeNonce) && data.nonce === bridgeNonce
);

const canUseWindowMessaging = () => (
  typeof window !== 'undefined'
  && typeof window.postMessage === 'function'
  && typeof window.addEventListener === 'function'
);

const createRequestId = () => (
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `folia-${Date.now()}-${Math.random().toString(36).slice(2)}`
);

/** postMessage 的目标 origin 收窄到本页自己的 origin（M2）。 */
const pageOrigin = () => {
  try {
    const value = String(window.location?.origin || '');
    // 页面在 file:// / 沙箱 iframe 里时 origin 可能是字符串 "null"：退回 '*'，
    // 但真正的隔离靠 nonce 与 event.source，不靠 targetOrigin。
    return value && value !== 'null' ? value : '*';
  } catch {
    return '*';
  }
};

const postToBridge = (payload: Record<string, unknown>) => {
  // nonce 用「桥上给的那一个」优先，其次才是本页生成的那个（扩展宿主两边一致，任一个都认）。
  window.postMessage({ source: PAGE_SOURCE, nonce: bridgeNonce || localNonce, ...payload }, pageOrigin());
};

const resolvePending = (id: string, result: { ok: boolean; data?: unknown; error?: string }) => {
  const pending = pendingRequests.get(id);
  if (!pending) return;
  pendingRequests.delete(id);
  window.clearTimeout(pending.timer);
  if (result.ok) {
    pending.resolve(result.data);
  } else {
    pending.reject(new Error(result.error || 'Folia Bridge request failed'));
  }
};

if (canUseWindowMessaging()) {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data as Record<string, any> | null;
    if (!data || data.source !== BRIDGE_SOURCE) return;

    if (data.type === 'FOLIA_BRIDGE_READY' || data.type === 'FOLIA_BRIDGE_PONG') {
      // 只有带 nonce 的答话才被当成桥的：READY 里的 nonce 就是这一会话共用的那一个。
      if (!data.nonce || (bridgeNonce && data.nonce !== bridgeNonce)) return;
      if (!bridgeNonce) bridgeNonce = String(data.nonce);
      bridgeVersion = String(data.version || '');
      bridgeExtensionId = String(data.extId || '');
      return;
    }

    if (data.type === 'FOLIA_API_RESPONSE' && typeof data.id === 'string') {
      // nonce 对不上的响应一律不认（M2）：这就是「同页脚本照着监听到的 id 伪造响应」那条路。
      if (!echoesNonce(data)) {
        console.warn('[FoliaExtensionBridge] dropped a bridge response without this session\'s nonce');
        return;
      }
      resolvePending(data.id, {
        ok: Boolean(data.ok),
        data: data.data,
        error: typeof data.error === 'string' ? data.error : undefined,
      });
    }
  });
};

/** API base 写成 `extension`（或 folia-extension://xxx）即表示走本地桥而不是远程后端。 */
export const isFoliaExtensionBridgeConfigured = (value?: string | null): boolean => {
  const normalized = String(value || '').trim().toLowerCase().replace(/\/+$/, '');
  return normalized === FOLIA_EXTENSION_API_BASE
    || normalized === 'folia-extension'
    || normalized === 'folia-extension://netease'
    || normalized === 'folia-extension://qq'
    || normalized === 'folia-extension://kugou'
    || normalized === 'folia-extension://bodian';
};

export const getFoliaExtensionBridgeInfo = () => ({
  version: bridgeVersion,
  extensionId: bridgeExtensionId,
});

export const isFoliaExtensionBridgeAvailable = (): Promise<boolean> => {
  if (!canUseWindowMessaging()) return Promise.resolve(false);
  // 没有 crypto.getRandomValues 就没有会话 nonce（M2）：那时 id 也可预测，
  // 响应任何人都能伪造，宁可直接判「桥不可用」，也不退回一个可以被冒充的通道。
  if (!bridgeNonce && !localNonce) return Promise.resolve(false);
  if (bridgeReadyPromise) return bridgeReadyPromise;

  bridgeReadyPromise = new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener('message', onPong);
      if (!ready) bridgeReadyPromise = null;
      resolve(ready);
    };

    const onPong = (event: MessageEvent) => {
      const data = event.data as Record<string, any> | null;
      if (event.source !== window || !data || data.source !== BRIDGE_SOURCE) return;
      if (data.type !== 'FOLIA_BRIDGE_PONG' && data.type !== 'FOLIA_BRIDGE_READY') return;
      // 桥必须回显我们在 PING 里带过去的 nonce，否则答话的不是这一会话的桥（M2）。
      if (!echoesNonce(data)) return;
      bridgeVersion = String(data.version || bridgeVersion);
      bridgeExtensionId = String(data.extId || bridgeExtensionId);
      finish(true);
    };

    // 桥没装（网页版没扩展）时不能让每次请求都卡 45 秒，探测只等这么久。
    const timer = window.setTimeout(() => finish(false), BRIDGE_PING_TIMEOUT_MS);
    window.addEventListener('message', onPong);
    postToBridge({ type: 'FOLIA_BRIDGE_PING' });
  });

  return bridgeReadyPromise;
};

export const requestFoliaExtension = async <T = unknown>(
  request: FoliaBridgeRequest,
): Promise<T> => {
  if (!(await isFoliaExtensionBridgeAvailable())) {
    throw new Error('FOLIA_EXTENSION_BRIDGE_UNAVAILABLE');
  }

  const id = createRequestId();
  return await new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('FOLIA_EXTENSION_BRIDGE_TIMEOUT'));
    }, BRIDGE_REQUEST_TIMEOUT_MS);

    pendingRequests.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timer,
    });
    postToBridge({ type: 'FOLIA_API_REQUEST', id, payload: request });
  });
};
