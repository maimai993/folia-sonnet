import {
  clearSecureValue,
  isSecureStoreAvailable,
  readSecureValue,
  writeSecureValue,
} from './secureStore.js';

// src/nativeBridge/api/cookies.js
// chrome.cookies 兼容层的收口：各平台的 cookie 读写、平台会话的落盘（加密存储，见 secureStore.js），
// 以及「读失败」与「确实没有」的三态（CookieReadError，见 withCookieFallback）。

export const NETEASE_DOMAINS = [
  'music.163.com',
  '.music.163.com',
  'www.music.163.com',
  '.163.com',
  '163.com',
  'interface.music.163.com',
  'interface3.music.163.com',
  '.126.net',
];
const NETEASE_URLS = [
  'https://music.163.com/',
  'https://music.163.com',
  'https://www.music.163.com/',
  'https://interface.music.163.com/',
  'https://interface3.music.163.com/',
];
const QQ_DOMAINS = [
  'y.qq.com', '.y.qq.com', '.qq.com', 'qq.com', 'i.y.qq.com',
  'graph.qq.com', '.graph.qq.com', 'u.y.qq.com', '.tencent.com',
];
const QQ_URLS = [
  'https://y.qq.com/',
  'https://y.qq.com',
  'https://i.y.qq.com/',
  'https://u.y.qq.com/',
  'https://graph.qq.com/',
  'https://qq.com/',
];
const QQ_COOKIE_KEYS = [
  'uin', 'p_uin', 'wxuin', 'qqmusic_uin', 'qm_keyst', 'qqmusic_key', 'music_key',
  'p_skey', 'skey', 'wxskey', 'login_type', 'vipType', 'vip_type', 'green_vip_level',
  'luxury_vip_level', 'music_vip_level', 'psrf_qqaccess_token', 'psrf_qqrefresh_token',
  'wxuin', 'wxopenid', 'tmeLoginType',
];
export const KG_DOMAINS = ['kugou.com', '.kugou.com', 'www.kugou.com', 'm.kugou.com', '.kugou.net'];
const KG_URLS = ['https://www.kugou.com/', 'https://kugou.com/', 'https://m.kugou.com/'];
export const KG_COOKIE_KEYS = [
  'userid', 'token', 'KugooID', 'KuGoo', 'Kugoo', 'NickName', 'nickname', 'kg_mid', 'kugouid',
  'pic', 'user_pic', 'avatar', 'headpic', 'userpic', 'dfid', 'DFID', 'KToken', 't', 't1', 'KugooPwd',
  'vip_type', 'vip_token', 'VIPType', 'VipType', 'musicvip', 'MusicPack', 'musicpack', 'is_vip',
  'IsVIP', 'isVIP', 'su_vip', 'm_type', 'y_type', 'music_vip', 'VipLevel', 'vip_level',
  'vip_endtime', 'vip_end_time', 'su_vip_end_time', 'm_end_time',
  'KUGOU_API_PLATFORM', 'KUGOU_API_GUID', 'KUGOU_API_MID', 'KUGOU_API_DEV', 'KUGOU_API_MAC', 'KUGOU_API_WEBGL',
];
export const NETEASE_KEY_NAMES = ['MUSIC_U', 'MUSIC_A', '__csrf', 'NMTID', 'WNMCID', 'WEVNSM', '_ntes_nuid', '_ntes_nnid', 'MUSIC_R_U'];

const COOKIE_CACHE_TTL_MS = 2500;
const PERSISTENT_COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 400;
const cookieCache = new Map();
export const BRIDGE_COOKIE_STORAGE_KEYS = {
  netease: 'foliaBridgeNeteaseCookie',
  qq: 'foliaBridgeQqCookie',
  kg: 'foliaBridgeKgCookie',
};

function persistentCookieExpirationDate() {
  return Math.floor(Date.now() / 1000) + PERSISTENT_COOKIE_MAX_AGE_SEC;
}

function cookieDomainForUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === 'kugou.com' || host.endsWith('.kugou.com')) return '.kugou.com';
    if (host === 'kugou.net' || host.endsWith('.kugou.net')) return '.kugou.net';
    if (host.endsWith('.qq.com')) return '.qq.com';
    if (host.endsWith('.163.com')) return '.163.com';
  } catch (_) {}
  return undefined;
}

/**
 * cookie 的值只能是可见 ASCII（0x20–0x7E）。
 *
 * 之前昵称是原样写进去的：中文昵称会进到 `NickName` 与那个用 `&` 拼起来的整包值里，
 * 而它落在整站共用的域上，于是这个域下**每一个**请求都带着它。原生侧把 cookie 库里的值
 * 拼成 Cookie 头时逐个检查字符，遇到范围外的当场抛
 * `Unexpected char 0x4e1c at 414 in Cookie value` —— 请求连发出去的机会都没有，
 * 页面侧看到的就是登录第一步立刻失败、错误码还标成 `network`。
 *
 * 只把范围外的字符按 UTF-8 百分号编码：token、签名、`;` `=` `&` 这些分隔符一个字节都不动，
 * 读回来的方向由 decodeKGCookieValue 那一路负责（它本来就在解码）。
 */
function encodeCookieValue(value) {
  const text = String(value == null ? '' : value);
  if (!/[^\x20-\x7E]/.test(text)) return text;
  return text.replace(/[^\x20-\x7E]/g, (char) => encodeURIComponent(char));
}

function buildPersistentCookieSetOptions(baseUrl, name, value) {
  const domain = cookieDomainForUrl(baseUrl);
  return {
    url: baseUrl,
    name,
    value: encodeCookieValue(value),
    path: '/',
    secure: true,
    expirationDate: persistentCookieExpirationDate(),
    ...(domain ? { domain } : {}),
  };
}

export function clearCookieCache() {
  cookieCache.clear();
}

/** 一份平台会话在原生加密存储里的槽位名（见 secureStore.js）。 */
const SECURE_SLOT_FOR_PROVIDER = {
  netease: 'provider-netease-cookie',
  qq: 'provider-qq-cookie',
  kg: 'provider-kg-cookie',
};

/**
 * 平台 cookie 原来明文存在 `chrome.storage.local` —— 在安卓上那就是页面 localStorage，
 * 在控制台里读一下 `foliaBridgeQqCookie` 这个键就能取走长期凭据（H5）。
 *
 * 现在分两层：
 *  1. **原生加密存储**（secureStore.js → FoliaSecureStore，Android Keystore 的 AES-GCM）是唯一的落盘处；
 *  2. localStorage 里的那份只在**没有原生存储**的环境里用（网页版扩展 / 桌面 / 单测），
 *     安卓上不再写它 —— 这是这次改动的核心。
 *
 * 槽位名与 localStorage 键名（BRIDGE_COOKIE_STORAGE_KEYS）都**不改名**：前者是新的，
 * 后者是已经发布的键（AGENTS.md「已经发布的存储键不改名」），还得读出来做一次性迁移。
 */

const secureSlotOf = (provider) => SECURE_SLOT_FOR_PROVIDER[provider] || '';

/** 这份 cookie 头里有没有账号凭据（不是只有设备号那几条）。迁移时据此判断值不值得搬。 */
function hasAccountCredentialCookie(provider, header) {
  const parsed = parseCookieString(header);
  if (provider === 'netease') return Boolean(parsed.MUSIC_U || parsed.MUSIC_A);
  if (provider === 'qq') return Boolean(parsed.uin || parsed.p_uin || parsed.wxuin || parsed.qm_keyst || parsed.qqmusic_key);
  if (provider === 'kg') return Boolean(kgCookieUserId(header) && kgCookieToken(header));
  return Object.keys(parsed).length > 0;
}

/**
 * 把 localStorage 里残留的明文 cookie 搬进原生加密存储，然后**删掉明文**。
 *
 * 什么时候跑：第一次读 / 写某个平台的 cookie 时（读那条路要先知道有没有存过）。
 * 迁移只做一次，靠"加密槽位存在"这件事判断 —— 不另起一个"已迁移"标记，
 * 因为标记本身也可能落在半路的崩溃里，而槽位本身就是结论。
 *
 * 旧数据会不会丢：搬的顺序是「先加密写成功，再删明文」；写失败（Keystore 不可用）时明文
 * 原样留着，下一次再试，绝不在写不进去的时候先删。只有一种情况读不到旧登录 —— 就是
 * 明文本身已经损坏（JSON 解析不出）或用户在这中间清过应用数据，那本来也救不回来。
 */
export async function migrateLegacyCookieStorage(provider) {
  const slot = secureSlotOf(provider);
  const storageKey = BRIDGE_COOKIE_STORAGE_KEYS[provider];
  if (!slot || !storageKey || !isSecureStoreAvailable()) return;
  let legacy = '';
  try {
    const stored = await chrome.storage?.local?.get?.([storageKey]);
    legacy = String(stored?.[storageKey] || '');
  } catch (_) {
    return; // 读不到 localStorage 就下次再说，什么都不删
  }
  if (!hasAccountCredentialCookie(provider, legacy)) {
    // 没有账号凭据的残留（只有设备 cookie 之类）直接清掉：它不是登录态，留着也没有用。
    if (legacy) await dropLegacyCookieStorage(provider);
    return;
  }
  let existing = null;
  try {
    existing = await readSecureValue(slot);
  } catch (error) {
    // 解不开就别再拿明文去覆盖它（覆盖等于把一份可能还能救的数据埋掉），也不删明文。
    console.warn('[FoliaCookieStore] legacy cookie migration deferred', error);
    return;
  }
  if (existing.found) {
    // 加密那份是新的真相，明文只是残留。
    await dropLegacyCookieStorage(provider);
    return;
  }
  const written = await writeSecureValue(slot, legacy);
  if (!written) {
    console.warn('[FoliaCookieStore] legacy cookie could not be encrypted yet; the plaintext copy is kept for a later attempt');
    return;
  }
  await dropLegacyCookieStorage(provider);
}

/** 删掉 localStorage 里那份明文。删不掉不致命，下次迁移会再试一次。 */
async function dropLegacyCookieStorage(provider) {
  const storageKey = BRIDGE_COOKIE_STORAGE_KEYS[provider];
  if (!storageKey) return;
  try {
    await chrome.storage?.local?.remove?.([storageKey]);
  } catch (_) {}
}

/**
 * 读一份平台会话。三态：
 *   - 有：原样返回；
 *   - 确实没有：`''`；
 *   - 读不到（原生存储解不开 / 桥没答）：抛 [CookieReadError]，上层不许当成"没登录"。
 *
 * 没有原生存储的环境照旧读 localStorage（那里本来就没有 Keystore 可用，行为不变）。
 */
async function readStoredProviderCookie(provider) {
  const slot = secureSlotOf(provider);
  const storageKey = BRIDGE_COOKIE_STORAGE_KEYS[provider];
  if (!slot) return '';
  if (!isSecureStoreAvailable()) {
    if (!storageKey || !chrome.storage?.local) return '';
    try {
      const stored = await chrome.storage.local.get([storageKey]);
      return String(stored?.[storageKey] || '');
    } catch (_) {
      return '';
    }
  }
  await migrateLegacyCookieStorage(provider);
  let stored;
  try {
    stored = await readSecureValue(slot);
  } catch (error) {
    // 统一成 CookieReadError：调用方只认「读失败」这一种，不该再分它是加密层还是桥层报的。
    throw toCookieReadError(error, `stored ${provider} cookie`);
  }
  return stored.found ? String(stored.text || '') : '';
}

/** 把一份平台会话写下去。返回 false = 没写进去（调用方要知道这次登录没能持久化）。 */
async function writeStoredProviderCookie(provider, cookie) {
  const slot = secureSlotOf(provider);
  if (!slot || !cookie) return false;
  if (!isSecureStoreAvailable()) {
    const storageKey = BRIDGE_COOKIE_STORAGE_KEYS[provider];
    if (!storageKey || !chrome.storage?.local) return false;
    try {
      await chrome.storage.local.set({ [storageKey]: cookie });
      return true;
    } catch (_) {
      return false;
    }
  }
  const written = await writeSecureValue(slot, cookie);
  // 写成功之后顺手把明文旧键删掉：升级后第一次登录也可能先经过这里（没走过迁移那条路）。
  if (written) await dropLegacyCookieStorage(provider);
  return written;
}

/**
 * 保存平台会话（合并进已有那份）。只有确认的登录才调它。
 *
 * 写失败（Keystore 不可用、IO 错）只记一行、不抛：这次登录在本次运行里照样有效，
 * 只是重启之后要重新登录。**绝不回退成明文写 localStorage** —— 那正是 H5 要修的东西。
 */
export async function saveProviderCookie(provider, cookieHeader) {
  const cookie = typeof cookieHeader === 'string'
    ? cookieHeader.trim()
    : Array.isArray(cookieHeader)
      ? cookieHeader
          .map((item) => {
            const name = item?.name;
            const value = normalizeCookieValue(item);
            return name && value ? `${name}=${value}` : '';
          })
          .filter(Boolean)
          .join('; ')
      : cookieHeader && typeof cookieHeader === 'object'
        ? Object.entries(cookieHeader)
            .map(([name, value]) => {
              const normalized = normalizeCookieValue(value);
              return name && normalized ? `${name}=${normalized}` : '';
            })
            .filter(Boolean)
            .join('; ')
        : '';
  if (!secureSlotOf(provider) || !cookie) return;
  let merged = cookie;
  try {
    const current = await withCookieFallback(
      () => readStoredProviderCookie(provider),
      { label: 'saveProviderCookie:previous', fallback: '' },
    );
    merged = mergeCookieHeaders(current || '', cookie);
  } catch (error) {
    // 读不回旧的那份：那就整份覆盖。宁可少存几条 cookie，也好过这次登录一条都没存下来。
    console.warn('[FoliaCookieStore] the stored cookie could not be merged; it is replaced instead', error);
  }
  const written = await writeStoredProviderCookie(provider, merged);
  if (!written) {
    console.warn(`[FoliaCookieStore] the ${provider} cookie could not be stored; this session lasts until the app restarts`);
  }
  clearCookieCache();
}

/** 抹掉一份平台会话的**所有**落盘副本：加密槽位 + 明文旧键。登出时调。 */
export async function forgetProviderCookie(provider) {
  const slot = secureSlotOf(provider);
  if (slot) await clearSecureValue(slot);
  await dropLegacyCookieStorage(provider);
  clearCookieCache();
}

function mergeCookieHeaders(...headers) {
  const merged = new Map();
  headers.forEach((header) => {
    Object.entries(parseCookieString(header)).forEach(([name, value]) => {
      if (name && value !== '') merged.set(name, value);
    });
  });
  return Array.from(merged, ([name, value]) => `${name}=${value}`).join('; ');
}

// 平台账号凭据。刚登录落下的那串会话就是「本次登录的账号」，必须压过 cookie 罐里同名的残留：
// 罐里可能还留着上一条通道（微信）或上一个账号的 uin / wxuin / qm_keyst，
// 让它们赢就会出现「扫的是 A 账号、听的是 B 账号（歌单和头像都是空的）」。
const QQ_SESSION_AUTHORITY_COOKIE_NAMES = new Set([
  'uin',
  'p_uin',
  'qqmusic_uin',
  'qm_keyst',
  'qqmusic_key',
  'music_key',
  'p_skey',
  'skey',
  'wxuin',
  'wxopenid',
  'wxskey',
  'wxrefresh_token',
  'str_musicid',
  'login_type',
  'tmeLoginType',
]);

/**
 * QQ 的会话头：cookie 罐提供传输类 cookie，账号凭据以本次登录落下的会话为准。
 * 没存过会话时（例如还没登录）行为与整罐合并一致。
 */
function mergeQQSessionCookieHeader(stored, collected) {
  const sessionCookies = parseCookieString(stored);
  const merged = new Map();
  Object.entries(parseCookieString(collected)).forEach(([name, value]) => {
    if (name && value !== '') merged.set(name, value);
  });
  Object.entries(sessionCookies).forEach(([name, value]) => {
    if (!name || value === '') return;
    // 凭据以会话为准；其余（ptcz / RK 这类搬运 cookie）罐里有就用罐里的更新值。
    if (QQ_SESSION_AUTHORITY_COOKIE_NAMES.has(name)) merged.set(name, value);
    else if (!merged.has(name)) merged.set(name, value);
  });
  return Array.from(merged, ([name, value]) => `${name}=${value}`).join('; ');
}

async function withStoredCookie(provider, build) {
  const [collected, stored] = await Promise.all([
    build(),
    readStoredProviderCookie(provider),
  ]);
  return mergeCookieHeaders(stored, collected);
}

async function withCookieCache(key, build) {
  const hit = cookieCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < COOKIE_CACHE_TTL_MS) return hit.value;
  const value = await build();
  cookieCache.set(key, { value, at: now });
  return value;
}

/**
 * 读 cookie 没有拿到答案。**不是**「这个人没有 cookie」。
 *
 * 三态在这里分开（H4）：
 *   - `ok` / `empty`：桥答了。答出空 cookie 头就是 `empty` —— 确实没人登录、或者确实没有那几条。
 *   - `error`：桥没答（超时 4 秒、插件抛异常、WebView 重载）。这时任何「未登录」的结论都不成立：
 *     登录态可能就是好的，只是这一次读不到。
 *
 * 以前超时被压成空值，与「没登录」长得一模一样，于是桥抖一下就被读成用户没登录，
 * 界面引导重新登录，账号读取那一路还会判成登录失效、连带把本地凭据清掉 —— 临时故障变成真登出。
 * `withCookieFallback` 是唯一的收口点：只有明确的无 cookie 能回空值，读失败一律抛出去。
 */
export class CookieReadError extends Error {
  /** 'timeout'：桥在预算内没有回包；'native-error'：桥上抛了异常；'unsupported'：这里没法读 cookie。 */
  constructor(reason, message) {
    super(message || `Cookie read failed (${reason})`);
    this.name = 'CookieReadError';
    this.reason = reason;
  }
}

/** 是不是「读失败」，而不是「读到了，只是空的」。上层用它决定能不能说未登录。 */
export function isCookieReadError(error) {
  return Boolean(error) && error.name === 'CookieReadError';
}

/**
 * 把一次 cookie 读取收敛成三态里的一个值。
 *
 * `read` 抛出的错误分两种：cookie 宿主不可用（`isUnsupported` 判为真，比如桌面主进程里的
 * `chrome.cookies` 本身不存在）当作 `empty`，与改动之前一致；其余（`CookieReadError` 或别的
 * 异常）是「读失败」，抛出 CookieReadError 让上层带上去。
 *
 * `fallback` 的默认值就是调用方原来的空值（`[]` / `null` / `''`），
 * 所以上层照旧 `await`，只是现在能分清空的是哪一半。
 *
 * @template T
 * @param {() => Promise<T>} read
 * @param {{ label: string, fallback: T, isUnsupported?: (error) => boolean }} options
 * @returns {Promise<T>}
 */
export async function withCookieFallback(read, { label, fallback, isUnsupported }) {
  try {
    return await read();
  } catch (error) {
    if (isUnsupported && isUnsupported(error)) return fallback;
    throw toCookieReadError(error, label);
  }
}

/** 把一个底层错误包成 CookieReadError：已经是原样传，加密层与桥上来的都带走原因。 */
export function toCookieReadError(error, label) {
  if (isCookieReadError(error)) return error;
  const native = error && error.name === 'NativeCookieCallError';
  const secure = error && error.name === 'SecureStoreError';
  const reason = native || secure ? error.reason : 'native-error';
  const detail = error && error.message ? `: ${error.message}` : '';
  return new CookieReadError(reason, `Cookie read failed at ${label} (${reason})${detail}`);
}

/**
 * chrome.cookies 在这里根本没有可用的宿主 —— 与「读失败」不同。
 *
 * 安卓 WebView 里 `contributorGlobal` 由 nativeAndroidBridge 装好；桌面主进程 / 单测里
 * 可能压根没有 chrome.cookies。后者以前静默回空，改动前后行为要一样，所以仍然当作空。
 */
export function isCookieHostUnavailable(error) {
  if (typeof chrome === 'undefined' || !chrome || !chrome.cookies) return true;
  const message = String(error && error.message || '');
  return /chrome\.cookies|Cannot read propert|cookies\.(get|getAll) is not a function|undefined \(reading '(get|getAll)'\)/i.test(message)
    && typeof chrome.cookies.getAll !== 'function';
}

async function collectCookieHeader(domains, urls, keyNames, keyUrl) {
  const picked = new Map();
  // 每一条腿的失败都记下来：全部读失败时抛出，哪怕别处读到了几条也不能当成完整凭据。
  // 只有一部分失败时（比如某个域的超时）照旧往下走 —— 那几条读不到的键本来也常常不存在。
  const failures = [];
  const note = (error) => { failures.push(error); };
  await Promise.all([
    ...(domains || []).map(async (domain) => {
      try { await mergeCookieList(picked, await chrome.cookies.getAll({ domain })); } catch (error) { note(error); }
    }),
    ...(urls || []).map(async (url) => {
      try { await mergeCookieList(picked, await chrome.cookies.getAll({ url })); } catch (error) { note(error); }
    }),
    ...(keyNames || []).map(async (name) => {
      try {
        const item = await chrome.cookies.get({ url: keyUrl, name });
        if (item && item.value) picked.set(name, item.value);
      } catch (error) { note(error); }
    }),
  ]);
  const attempted = (domains || []).length + (urls || []).length + (keyNames || []).length;
  if (attempted > 0 && failures.length === attempted) {
    throw toCookieReadError(failures[0], 'collectCookieHeader');
  }
  return Array.from(picked.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

async function mergeCookieList(picked, list) {
  (list || []).forEach((item) => {
    if (item && item.name && item.value != null && item.value !== '') {
      picked.set(item.name, item.value);
    }
  });
}

export async function getCookieHeader(domains, urls) {
  const picked = new Map();
  const failures = [];
  for (const domain of domains || []) {
    try {
      await mergeCookieList(picked, await chrome.cookies.getAll({ domain }));
    } catch (error) { failures.push(error); }
  }
  for (const url of urls || []) {
    try {
      await mergeCookieList(picked, await chrome.cookies.getAll({ url }));
    } catch (error) { failures.push(error); }
  }
  const attempted = (domains || []).length + (urls || []).length;
  if (attempted > 0 && failures.length === attempted) throw toCookieReadError(failures[0], 'getCookieHeader');
  return Array.from(picked.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

export async function getNeteaseCookie() {
  return withCookieCache('netease', () => withStoredCookie('netease', () => collectCookieHeader(
    NETEASE_DOMAINS, NETEASE_URLS, NETEASE_KEY_NAMES, 'https://music.163.com/',
  )));
}

export async function getQQCookie() {
  return withCookieCache('qq', async () => {
    const [collected, stored] = await Promise.all([
      collectCookieHeader(QQ_DOMAINS, QQ_URLS, QQ_COOKIE_KEYS, 'https://y.qq.com/'),
      readStoredProviderCookie('qq'),
    ]);
    return mergeQQSessionCookieHeader(stored, collected);
  });
}

export async function getKGCookie() {
  return withCookieCache('kg', () => withStoredCookie('kg', () => collectCookieHeader(
    KG_DOMAINS, KG_URLS, KG_COOKIE_KEYS, 'https://www.kugou.com/',
  )));
}

export function parseCookieString(header) {
  const out = {};
  String(header || '')
    .split(';')
    .forEach((part) => {
      const idx = part.indexOf('=');
      if (idx <= 0) return;
      const key = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (key) out[key] = value;
    });
  return out;
}

function normalizeCookieValue(value) {
  if (value == null) return '';
  if (typeof value === 'object' && value.value != null) return String(value.value);
  return String(value);
}

export async function setBrowserCookies(baseUrl, cookieInput) {
  const tasks = [];
  if (typeof cookieInput === 'string') {
    Object.entries(parseCookieString(cookieInput)).forEach(([name, value]) => {
      tasks.push(chrome.cookies.set(buildPersistentCookieSetOptions(baseUrl, name, value)).catch(() => null));
    });
  } else if (Array.isArray(cookieInput)) {
    cookieInput.forEach((item) => {
      const name = item && item.name;
      const value = normalizeCookieValue(item);
      if (!name || !value) return;
      tasks.push(chrome.cookies.set(buildPersistentCookieSetOptions(baseUrl, name, value)).catch(() => null));
    });
  } else if (cookieInput && typeof cookieInput === 'object') {
    Object.entries(cookieInput).forEach(([name, value]) => {
      const v = normalizeCookieValue(value);
      if (!name || !v) return;
      tasks.push(chrome.cookies.set(buildPersistentCookieSetOptions(baseUrl, name, v)).catch(() => null));
    });
  }
  await Promise.all(tasks);
  clearCookieCache();
}

/**
 * 删除指定域下的若干 cookie。
 *
 * 用于登录通道之间清理残留：微信扫码会写下 login_type / wxuin / tmeLoginType，
 * 它们留在同一个 cookie jar 里，切回 QQ 登录时会被当成微信通道解析，导致 QQ 凭证被上游拒收。
 */
export async function removeBrowserCookies(baseUrl, names) {
  const list = (Array.isArray(names) ? names : [names]).filter(Boolean);
  if (!list.length || !baseUrl) return;
  // 宿主没提供 remove 时静默跳过：清理只是登录通道切换的卫生工作，不该让登录流程失败。
  if (!chrome?.cookies?.remove) return;
  await Promise.all(list.map(name => (
    chrome.cookies.remove({ url: baseUrl, name }).catch(() => null)
  )));
  clearCookieCache();
}

/**
 * 一次删掉多个 host × 多个 cookie 名。
 *
 * 逐条删除在安卓上每条都要过一次桥、并在原生侧 flush 一次，几十条下来就超过清理的截止时间，
 * 结果是「以为清了、其实还剩一半」——旧账号的 uin / 登录通道标记就是这么留下来的。
 * 宿主支持批量时改成一次调用（原生侧循环 + 一次 flush）。
 */
export async function removeBrowserCookiesForHosts(hosts, names) {
  const nameList = (Array.isArray(names) ? names : [names]).filter(Boolean);
  const hostList = (Array.isArray(hosts) ? hosts : [hosts]).filter(Boolean);
  if (!nameList.length || !hostList.length) return;
  const batch = chrome?.cookies?.removeBatch;
  if (typeof batch === 'function') {
    try {
      const removed = await batch(hostList.flatMap(url => nameList.map(name => ({ url, name }))));
      // 宿主不支持或超时（返回 null）时继续走逐条删除，不能当成已清干净。
      if (removed) {
        clearCookieCache();
        return;
      }
    } catch (_) {
      // 批量失败就退回逐条删除。
    }
  }
  for (const host of hostList) await removeBrowserCookies(host, nameList);
}

export function hasNeteaseLogin(cookieHeader) {
  const obj = parseCookieString(cookieHeader);
  return !!(obj.MUSIC_U || obj.MUSIC_A || obj.__csrf);
}

export function qqCookieObject(cookieHeader) {
  return parseCookieString(cookieHeader);
}

export function qqCookiePlaybackKey(cookieHeader) {
  const obj = parseCookieString(cookieHeader);
  return obj.qm_keyst || obj.qqmusic_key || obj.music_key || obj.wxskey || '';
}

export function qqCookieMusicKey(cookieHeader) {
  const obj = parseCookieString(cookieHeader);
  return obj.qm_keyst || obj.qqmusic_key || obj.music_key || obj.p_skey || obj.skey
    || obj.psrf_qqaccess_token || obj.psrf_qqrefresh_token || obj.wxrefresh_token || obj.wxskey || '';
}

function normalizeQQUin(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.replace(/^0+/, '') || digits;
}

function decodeQQCookieValue(value) {
  try {
    return decodeURIComponent(String(value || '').replace(/\+/g, '%20')).trim();
  } catch (_) {
    return String(value || '').trim();
  }
}

export function qqCookieUin(cookieHeader) {
  const obj = parseCookieString(cookieHeader);
  const raw = Number(obj.login_type) === 2
    ? (obj.wxuin || obj.uin || obj.p_uin)
    : (obj.uin || obj.qqmusic_uin || obj.wxuin || obj.p_uin);
  return normalizeQQUin(raw);
}

export function qqCookieNickname(cookieHeader, uin) {
  const obj = parseCookieString(cookieHeader);
  uin = normalizeQQUin(uin || qqCookieUin(cookieHeader));
  const padded = uin ? `0${uin}` : '';
  const keys = [
    uin && `ptnick_${uin}`,
    padded && `ptnick_${padded}`,
    'ptnick',
    'nick',
    'nickname',
    'qq_nickname',
  ].filter(Boolean);
  for (const key of keys) {
    if (obj[key]) {
      const nick = decodeQQCookieValue(obj[key]);
      if (nick) return nick;
    }
  }
  const nickKey = Object.keys(obj).find((k) => /^ptnick_/i.test(k) && obj[k]);
  return nickKey ? decodeQQCookieValue(obj[nickKey]) : (uin ? `QQ ${uin}` : '');
}

export function qqCookieAvatar(cookieHeader, uin) {
  const obj = parseCookieString(cookieHeader);
  const direct = obj.qqmusic_avatar || obj.avatar || obj.avatarUrl || obj.headpic || '';
  if (direct) return decodeQQCookieValue(direct);
  uin = normalizeQQUin(uin || qqCookieUin(cookieHeader));
  return uin ? `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uin)}&s=100` : '';
}

function decodeKGUnicodeEscapes(value) {
  return String(value || '').replace(/%u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeKGCookieValue(value) {
  value = String(value || '').trim();
  if (!value) return '';
  if (/%u[0-9a-fA-F]{4}/.test(value)) value = decodeKGUnicodeEscapes(value);
  try {
    return decodeURIComponent(value.replace(/\+/g, '%20')).trim();
  } catch (_) {
    return value.trim();
  }
}

function expandKGCookieObject(obj) {
  obj = Object.assign({}, obj || {});
  for (const key of ['KuGoo', 'Kugoo', 'KGLogin', 'kguser']) {
    let raw = obj[key];
    if (!raw) continue;
    try { raw = decodeURIComponent(String(raw).replace(/\+/g, '%20')); } catch (_) { raw = String(raw); }
    const kuGooFields = {};
    String(raw).split('&').forEach((pair) => {
      const idx = pair.indexOf('=');
      if (idx <= 0) return;
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      if (k) kuGooFields[k] = v;
    });
    const overrideKeys = [
      'KugooID', 'userid', 'kugouid', 't', 't1', 'token', 'KToken', 'KugooPwd', 'NickName', 'Pic', 'UserName',
      'vip_type', 'VIPType', 'VipType', 'vip_token', 'VipToken', 'VIPToken', 'viptoken',
      'MusicPack', 'musicpack', 'is_vip', 'IsVIP', 'isVIP', 'su_vip', 'm_type', 'y_type', 'music_vip',
      'VipLevel', 'vip_level', 'vip_endtime', 'vip_end_time',
    ];
    overrideKeys.forEach((k) => {
      if (kuGooFields[k]) obj[k] = kuGooFields[k];
    });
    Object.entries(kuGooFields).forEach(([k, v]) => {
      if (obj[k] == null || obj[k] === '') obj[k] = v;
    });
  }
  return obj;
}

export function parseKGCookieObject(cookieHeader) {
  return expandKGCookieObject(parseCookieString(cookieHeader));
}

export function kgCookieUserId(cookieHeader) {
  const obj = parseKGCookieObject(cookieHeader);
  return String(obj.KugooID || obj.userid || obj.kugouid || '').trim();
}

export function kgCookieToken(cookieHeader) {
  // Prefer trailing standalone token/t cookies (enrichKGCookieHeader appends appToken last).
  // Otherwise KuGoo blob fields would overwrite the android token and cause error 20017.
  const parts = String(cookieHeader || '').split(';');
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i].trim();
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if ((key === 'token' || key === 't' || key === 'KToken') && value) return value;
  }
  const obj = parseKGCookieObject(cookieHeader);
  return String(obj.t || obj.token || obj.KToken || obj.kg_token || '').trim();
}

/** Always read web session token from KuGoo blob (ignore appended android appToken). */
export function kgCookieWebToken(cookieHeader) {
  const obj = parseKGCookieObject(cookieHeader);
  return String(obj.t || obj.token || obj.KToken || obj.kg_token || '').trim();
}

export function kgCookieVipType(cookieHeader) {
  const obj = parseKGCookieObject(cookieHeader);
  const direct = Number(
    obj.vip_type || obj.VIPType || obj.VipType || obj.vipType || obj.musicvip ||
    obj.MusicPack || obj.musicpack || obj.VipLevel || obj.vip_level || 0,
  ) || 0;
  if (direct > 0) return direct;
  if (Number(obj.su_vip) > 0) return 33;
  if (Number(obj.m_type) > 0) return 3;
  if (Number(obj.y_type) > 0 || Number(obj.music_vip) > 0) return 6;
  if (String(obj.vip_token || obj.vipToken || '').trim()) return 6;
  if (Number(obj.is_vip) === 1 || Number(obj.IsVIP) === 1 || Number(obj.isVIP) === 1 || Number(obj.MusicPack) === 1) return 6;
  const vipEndRaw = obj.vip_endtime || obj.vip_end_time || '';
  if (vipEndRaw) {
    const endMs = Date.parse(String(vipEndRaw).replace(/-/g, '/'));
    if (Number.isFinite(endMs) && endMs > Date.now()) return 6;
  }
  return 0;
}

export function kgCookieHasVipSession(cookieHeader) {
  return kgCookieVipType(cookieHeader) > 0 || !!kgCookieVipToken(cookieHeader);
}

export function analyzeKGCookieSession(cookieHeader) {
  const obj = parseKGCookieObject(cookieHeader || '');
  const userId = kgCookieUserId(cookieHeader);
  const token = kgCookieToken(cookieHeader);
  const sessionKeys = ['KuGoo', 'Kugoo', 'userid', 'KugooID', 'token', 't', 'vip_token', 'vip_type', 'dfid', 'kg_mid'];
  const foundSessionKeys = sessionKeys.filter((key) => {
    const value = obj[key];
    return value != null && String(value).trim() !== '';
  });
  const hasKuGoo = !!(obj.KuGoo || obj.Kugoo);
  return {
    loggedIn: !!(userId && token),
    userId: userId || '',
    hasKuGoo,
    hasToken: !!token,
    hasVipToken: !!kgCookieVipToken(cookieHeader),
    foundSessionKeys,
    trackingOnly: foundSessionKeys.length === 0 && Object.keys(obj).length > 0,
  };
}

export function kgCookieLoginPwd(cookieHeader) {
  const obj = parseKGCookieObject(cookieHeader);
  return String(obj.KugooPwd || obj.kugoo_pwd || obj.pwd || '').trim();
}

export function kgCookieVipToken(cookieHeader) {
  const obj = parseKGCookieObject(cookieHeader);
  return String(
    obj.vip_token || obj.vipToken || obj.VipToken || obj.VIPToken || obj.viptoken || obj.vip_key || '',
  ).trim();
}

export function kgCookieDfid(cookieHeader) {
  const obj = parseKGCookieObject(cookieHeader);
  return String(obj.dfid || obj.DFID || '-').trim() || '-';
}

export function kgCookieNickname(cookieHeader) {
  const obj = parseKGCookieObject(cookieHeader);
  return decodeKGCookieValue(obj.NickName || obj.nickname || obj.username || obj.uname || obj.UserName || '');
}

export function kgCookieAvatar(cookieHeader) {
  const obj = parseKGCookieObject(cookieHeader);
  let url = decodeKGCookieValue(obj.pic || obj.Pic || obj.user_pic || obj.avatar || obj.headpic || obj.userpic || '');
  if (url && url.startsWith('//')) url = 'http:' + url;
  return url;
}

/**
 * 读 MUSIC_U。读不到就是空串（**没登录**），桥读失败则抛 CookieReadError。
 *
 * 以前这里两种都回 `''`：它只服务 `getLoginInfo` 里那句「有 MUSIC_U 才算登录」，超时于是变成
 * 「没登录」。现在 `getLoginInfo` 会把读失败带着抛出去，不会拿一次超时去判一个人的登录态。
 */
export async function getNeteaseMusicU() {
  return withCookieFallback(async () => {
    const item = await chrome.cookies.get({ url: 'https://music.163.com/', name: 'MUSIC_U' });
    return item && item.value ? item.value : '';
  }, { label: 'MUSIC_U', fallback: '', isUnsupported: isCookieHostUnavailable });
}
