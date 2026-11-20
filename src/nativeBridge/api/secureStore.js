// src/nativeBridge/api/secureStore.js
//
// 凭据的加密落盘：平台 cookie 与账号 token 不再明文进 `chrome.storage.local`（安卓上就是页面
// localStorage），改由原生侧 [FoliaSecureStore] 用 Android Keystore 里的应用专属密钥加密后存文件
// （H5 / H30）。
//
// 三态，与 [cookies.js] 的 CookieReadError 同一个理由 —— **"读不到"不能长得像"没有"**：
//   - `found = false`：确实没存过；
//   - `found && decrypted`：原样读出；
//   - `found && !decrypted` / 桥没答 / 这里没有原生存储：`SecureStoreError`，
//     上层必须当成"暂时读不到"往上带，不许据此判未登录、也不许回退成明文。
//
// 桌面主进程与浏览器里没有 `window.Capacitor`：那边本来就不走这个模块（凭据在主进程里加密保管，
// 或者在扩展的 chrome.storage 里），所以 `isSecureStoreAvailable()` 为假时调用方保持原行为。

const PLUGIN_NAME = 'FoliaNative';
/** 槽位名只能是小写标识符：它同时是文件名的来源，不要放用户输入。 */
const SLOT_PATTERN = /^[a-z0-9_.-]{1,64}$/;

/**
 * 一条凭据读不出来。`reason`：
 *   - 'unavailable'：这台机器上没有原生存储（网页 / 桌面 / 单测）；
 *   - 'undecryptable'：存过，但解不开（换机、Keystore 被重置、密文坏了）；
 *   - 'bridge-error'：原生桥没答（超时、插件异常、WebView 重载）。
 */
export class SecureStoreError extends Error {
  constructor(reason, message) {
    super(message || `Secure store read failed (${reason})`);
    this.name = 'SecureStoreError';
    this.reason = reason;
  }
}

export function isSecureStoreError(error) {
  return Boolean(error) && error.name === 'SecureStoreError';
}

const getPlugin = () => {
  if (typeof window === 'undefined') return null;
  const capacitor = window.Capacitor;
  return capacitor?.Plugins?.[PLUGIN_NAME] ?? null;
};

/** 这台机器上有没有原生加密存储。没有就保持原来的存储路径，不硬失败。 */
export function isSecureStoreAvailable() {
  const plugin = getPlugin();
  return Boolean(plugin && typeof plugin.readSecureValue === 'function');
}

const assertSlot = (slot) => {
  if (!SLOT_PATTERN.test(String(slot || ''))) {
    throw new SecureStoreError('unavailable', `Invalid secure slot: ${String(slot).slice(0, 32)}`);
  }
};

/**
 * 读一条。
 *
 * 返回 `{ found, text }`：`found = false` 是"确实没有"，那是可以据以判断未登录的；
 * 其余读不成的情况一律抛 [SecureStoreError]。没装原生存储时也抛（reason = 'unavailable'），
 * 由调用方自己决定"这里没有存储"意味着什么。
 */
export async function readSecureValue(slot) {
  assertSlot(slot);
  const plugin = getPlugin();
  if (!plugin || typeof plugin.readSecureValue !== 'function') {
    throw new SecureStoreError('unavailable', 'Secure store is not available here');
  }
  let answer;
  try {
    answer = await plugin.readSecureValue({ slot });
  } catch (error) {
    throw new SecureStoreError('bridge-error', `Secure store bridge failed: ${error && error.message ? error.message : error}`);
  }
  if (!answer || answer.ok !== true) {
    throw new SecureStoreError('bridge-error', 'Secure store returned no answer');
  }
  if (answer.found !== true) return { found: false, text: null };
  if (answer.decrypted !== true || typeof answer.text !== 'string') {
    throw new SecureStoreError('undecryptable', `Secure slot ${slot} exists but could not be decrypted`);
  }
  return { found: true, text: answer.text };
}

/**
 * 写一条。返回 true = 真的落盘了；false = 没写进去（调用方要把这份数据留在内存里、
 * 并如实说"这次没存上"，**不要**回退成明文）。
 */
export async function writeSecureValue(slot, text) {
  assertSlot(slot);
  const plugin = getPlugin();
  if (!plugin || typeof plugin.writeSecureValue !== 'function') return false;
  if (typeof text !== 'string' || text.length === 0) return false;
  try {
    const answer = await plugin.writeSecureValue({ slot, text });
    return Boolean(answer && answer.ok === true);
  } catch (_) {
    return false;
  }
}

/** 抹掉一条。本来就没有也算抹掉了。 */
export async function clearSecureValue(slot) {
  assertSlot(slot);
  const plugin = getPlugin();
  if (!plugin || typeof plugin.clearSecureValue !== 'function') return false;
  try {
    const answer = await plugin.clearSecureValue({ slot });
    return Boolean(answer && answer.ok === true);
  } catch (_) {
    return false;
  }
}

/** 这条在不在（不解密）。没有原生存储时答 false —— 那种环境本来就不在这个模块里存。 */
export async function hasSecureValue(slot) {
  assertSlot(slot);
  const plugin = getPlugin();
  if (!plugin || typeof plugin.hasSecureValue !== 'function') return false;
  try {
    const answer = await plugin.hasSecureValue({ slot });
    return Boolean(answer && answer.ok === true && answer.exists === true);
  } catch (_) {
    return false;
  }
}
