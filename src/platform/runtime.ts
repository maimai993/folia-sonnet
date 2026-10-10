import { Capacitor } from '@capacitor/core';

// 当前文件：统一描述 Web、Electron 与 Capacitor Android 的运行时能力。

export type RuntimeEnvironment = 'web' | 'electron' | 'capacitor-android';

export const hasElectronBridge = (): boolean => (
  typeof window !== 'undefined'
  && Boolean((window as typeof window & { electron?: unknown }).electron)
);

export const isCapacitorAndroid = (): boolean => (
  typeof window !== 'undefined'
  && Capacitor.isNativePlatform()
  && Capacitor.getPlatform() === 'android'
);

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
