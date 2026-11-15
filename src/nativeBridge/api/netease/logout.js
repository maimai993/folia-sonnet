// src/nativeBridge/api/netease/logout.js
// 网易云退出登录：把罐里的登录态和桥存的那份 cookie 一起清掉。
//
// 为什么要在这里做、而不是只清前端 localStorage：`getNeteaseCookie()` 会从 cookie 罐里
// 把 MUSIC_U 读回来。页面侧 `dropNeteaseSignIn()` 清掉的只是渲染进程里的
// `online_provider:netease:cookie`，罐和 `chrome.storage.local` 里的那份都还在 ——
// 于是重开应用时桥又读出会话，前端判未登录、后端仍带着登录态，自动登录就回来了。
// 同一类会话的另一家平台，登出早就走了这一套。
//
// 清理只是登出的卫生工作：读不到结果、宿主不回包都照常放行，绝不把登出卡在等待上。

import {
  BRIDGE_COOKIE_STORAGE_KEYS,
  NETEASE_DOMAINS,
  NETEASE_KEY_NAMES,
  clearCookieCache,
  removeBrowserCookiesForHosts,
} from '../cookies.js';

// 硬上限：安卓上逐条删除要几十次过桥，宿主不回包时不能让登出停在等待上。
const CLEANUP_TIMEOUT_MS = 2500;

export async function clearSessionOnLogout() {
  let timer = null;
  const cleanup = (async () => {
    await removeBrowserCookiesForHosts(NETEASE_DOMAINS, NETEASE_KEY_NAMES);
    const storageKey = BRIDGE_COOKIE_STORAGE_KEYS.netease;
    if (storageKey && chrome?.storage?.local?.remove) {
      await chrome.storage.local.remove([storageKey]);
    }
    clearCookieCache();
  })().catch((err) => {
    console.warn('[NeteaseLogout] 清理会话失败', err);
  });
  const deadline = new Promise((resolve) => {
    timer = setTimeout(resolve, CLEANUP_TIMEOUT_MS);
  });
  try {
    await Promise.race([cleanup, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
