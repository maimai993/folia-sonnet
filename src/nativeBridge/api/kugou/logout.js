import {
    BRIDGE_COOKIE_STORAGE_KEYS,
    KG_DOMAINS,
    KG_COOKIE_KEYS,
    clearCookieCache,
    removeBrowserCookiesForHosts,
} from '../cookies.js';

// 酷狗登出只删除账号会话，保留设备身份；登录备份也必须删除，否则下一次请求会重新种回 cookie。
const STORAGE_KEYS = [BRIDGE_COOKIE_STORAGE_KEYS.kg, 'kgLoginPersist', 'kgVipSession'];
const DEVICE_COOKIE_KEYS = new Set(['dfid', 'DFID', 'kg_mid', 'KUGOU_API_PLATFORM', 'KUGOU_API_GUID', 'KUGOU_API_MID', 'KUGOU_API_DEV', 'KUGOU_API_MAC', 'KUGOU_API_WEBGL']);
const SESSION_COOKIE_KEYS = [...new Set([
    ...KG_COOKIE_KEYS.filter(name => !DEVICE_COOKIE_KEYS.has(name)),
    'KGLogin', 'kguser', 'kg_token', 'kugoo_pwd', 'pwd',
    'vipToken', 'VipToken', 'VIPToken', 'viptoken', 'vip_key', 'vipType',
    'username', 'uname', 'UserName', 'Pic',
])];
// Cookie API 要完整 URL；读罐用的域列表还包含前导点，不能原样当作删除地址。
const COOKIE_URLS = [...new Set([
    ...KG_DOMAINS.map(domain => `https://${domain.replace(/^\./, '')}/`),
    'https://gateway.kugou.com/', 'https://login-user.kugou.com/', 'https://login.user.kugou.com/',
])];
const CLEANUP_TIMEOUT_MS = 2500;

export async function clearSessionOnLogout() {
    clearCookieCache();
    let timer;
    // 两项独立启动：cookie 宿主拒绝或不回包，都不能挡住本地恢复备份的删除。
    const storage = Promise.resolve().then(() => globalThis.chrome?.storage?.local?.remove?.(STORAGE_KEYS));
    const cookies = Promise.resolve().then(() => removeBrowserCookiesForHosts(COOKIE_URLS, SESSION_COOKIE_KEYS));
    const cleanup = Promise.allSettled([storage, cookies]);
    try {
        await Promise.race([cleanup, new Promise(resolve => { timer = setTimeout(resolve, CLEANUP_TIMEOUT_MS); })]);
    } finally {
        clearTimeout(timer);
        clearCookieCache();
    }
}
