import { Capacitor } from '@capacitor/core';

// 当前文件：统一描述 Web、Electron 与 Capacitor Android 的运行时能力。

export type RuntimeEnvironment = 'web' | 'electron' | 'capacitor-android';

/**
 * 是不是桌面端（Electron）。
 *
 * 判据是 `window.electron.platform` —— 只有 Electron 的 preload 会写这个字段
 * （electron/preload.cjs）。安卓端为了让模组能用，会装一份 `window.electron.mods`
 * 的 shim，但它不带 `platform`，所以这里仍然为 false。
 *
 * 从前这里只问 `window.electron` 在不在，装了 shim 之后安卓就会被误判成 'electron'
 * （`window.electron.api` 里的 desktop-only 分支、设置页的桌面专属分区都会跟着错）。
 */
export const hasElectronBridge = (): boolean => (
  typeof window !== 'undefined'
  && typeof (window as typeof window & { electron?: { platform?: unknown } }).electron?.platform === 'string'
);

export const isCapacitorAndroid = (): boolean => (
  typeof window !== 'undefined'
  && Capacitor.isNativePlatform()
  && Capacitor.getPlatform() === 'android'
);

/**
 * 是不是跑在安卓 App 壳里 —— **不依赖 Capacitor 的桥有没有初始化完**。
 *
 * `Capacitor.isNativePlatform()` 读的是原生注入的 `window.CapacitorPlatform`，
 * 它要等桥起来才有值；在那之前一律 false（真机日志里那句
 * "deviceready has not fired after 5 seconds" 就是这段时间）。
 *
 * 凡是把「此刻是不是原生」当成「这个功能在不在」的判断，在启动头几秒都会答错，
 * 而答错的那一侧恰好是**破坏性**的那一侧：accountRead 把「不可用」当成
 * 「这个平台没有账号」，会顺手把已经存着的账号从界面上抹掉，而且不打日志
 * （见 accountRead.ts 里 readWhole 开头那句 clearAccount）。
 * 表现就是「登录成功，重启后账号没了」—— 凭据其实一直都在。
 */
export const isAndroidAppShell = (): boolean => {
  if (isCapacitorAndroid()) return true;
  if (typeof window === 'undefined') return false;
  // 页面由 Capacitor 自己发出来（server.hostname=localhost、androidScheme=https），
  // 加上安卓 WebView 的 UA：真机上这两条同时成立，手机浏览器访问真实站点不成立。
  const href = typeof window.location?.href === 'string' ? window.location.href : '';
  const ua = typeof navigator !== 'undefined' && navigator.userAgent ? navigator.userAgent : '';
  if (!/Android/i.test(ua)) return false;
  // 两条都对得上才算：UA 带 WebView 标记（`; wv)`），或页面确实是 Capacitor 自己
  // 从 https://localhost 发出来的。手机 Chrome 访问真站点两条都不成立。
  return /;\s*wv\)/i.test(ua) || /^https?:\/\/localhost(?:[:/]|$)/.test(href);
};

export const getRuntimeEnvironment = (): RuntimeEnvironment => {
  if (hasElectronBridge()) return 'electron';
  if (isCapacitorAndroid()) return 'capacitor-android';
  return 'web';
};

/**
 * 本地音乐在当前运行时能不能用。
 *
 * 早先安卓一律 false：那时本地曲库只有一条路 —— File System Access API
 * （`showDirectoryPicker` + `navigator.storage.getDirectory`），而 WebView 一个都不给。
 * 现在安卓走原生（MediaStore 扫描 / 系统文件管理器挑选 / 本地音频服务，
 * 见 services/nativeLocalMusic.ts），所以三个平台都支持。
 *
 * 这里继续返回 false 的话，首页会把「本地」页签**硬掰回「歌单」**
 * （useSearchNavigationStore.setHomeViewTab 那条回退），点本地就像没反应。
 */
export const supportsLocalMusicImport = (): boolean => true;

/**
 * 命令面板用的等价门控：命令面板在手机上基本用不到，本地音乐命令仍只注册在桌面端与浏览器端。
 * （与 supportsLocalMusicImport 不同：那个是「功能能不能用」，这个是「命令要不要出现」。）
 */
export const LOCAL_MUSIC_COMMAND_PLATFORMS = ['electron', 'web'] as const;
