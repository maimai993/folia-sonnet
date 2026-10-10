// src/services/localLibraryAvailability.ts
// Centralizes the secure-context requirement for browser local-library access.

import { isAndroidNativeRuntime } from './nativeLocalMusic';

export interface LocalLibraryAvailability {
  supported: boolean;
  reason: 'insecure-http' | 'file-system-api-unavailable' | null;
}

export const getLocalLibraryAvailability = (): LocalLibraryAvailability => {
  if (typeof window === 'undefined') return { supported: false, reason: 'file-system-api-unavailable' };
  if (window.electron) return { supported: true, reason: null };
  /*
   * 安卓走原生：WebView 没有 File System Access API（`showDirectoryPicker`），
   * 但原生那边能扫描设备音乐库、也能用系统文件管理器挑文件/文件夹，
   * 音频再由 LocalAudioServer 以回环地址喂给 <audio>。入口在这条路径上是可用的，
   * 不能因为网页那套 API 缺席就把整个本地曲库判死 —— 那正是「本地打不开」的来源。
   */
  if (isAndroidNativeRuntime()) return { supported: true, reason: null };
  const currentLocation = window.location;
  if (!currentLocation) return { supported: false, reason: 'file-system-api-unavailable' };
  const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(currentLocation.hostname);
  if (!(currentLocation.protocol === 'https:' || isLocalhost) || !window.isSecureContext) {
    return { supported: false, reason: 'insecure-http' };
  }
  if (!('showDirectoryPicker' in window) || typeof navigator.storage?.getDirectory !== 'function') {
    return { supported: false, reason: 'file-system-api-unavailable' };
  }
  return { supported: true, reason: null };
};
