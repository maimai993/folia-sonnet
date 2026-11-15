import { beforeEach, describe, expect, it, vi } from 'vitest';

const capacitorState = vi.hoisted(() => ({
  native: false,
  platform: 'web',
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => capacitorState.native,
    getPlatform: () => capacitorState.platform,
  },
}));

import {
  getRuntimeEnvironment,
  isCapacitorAndroid,
  supportsLocalMusicImport,
} from '@/platform/runtime';

// 当前文件：验证宿主识别与 Android 首版能力开关。

describe('platform runtime', () => {
  beforeEach(() => {
    capacitorState.native = false;
    capacitorState.platform = 'web';
    vi.stubGlobal('window', {});
  });

  it('recognizes a regular Web host', () => {
    expect(getRuntimeEnvironment()).toBe('web');
    expect(supportsLocalMusicImport()).toBe(true);
  });

  it('gives Electron precedence when its bridge exists', () => {
    vi.stubGlobal('window', { electron: { platform: 'win32' } });
    expect(getRuntimeEnvironment()).toBe('electron');
  });

  // 回归：判据是 `platform`，不是 `electron` 对象本身。安卓端的模组 shim 只装
  // `window.electron.mods`（没有 platform），若按对象存在判成 electron，桌面专属的
  // 设置页/窗口控件会在安卓上出现并在调用主进程方法时抛。
  it('does not mistake an electron shim without a platform for Electron', () => {
    vi.stubGlobal('window', { electron: { mods: { listMods: () => Promise.resolve({ mods: [] }) } } });
    expect(getRuntimeEnvironment()).not.toBe('electron');
  });

  // 安卓的本地曲库走原生（MediaStore 扫描 / 系统文件管理器 / 本地音频服务），
  // 不再是 File System Access API，所以这里必须支持 —— 返回 false 的话首页会把
  // 「本地」页签硬掰回「歌单」，点本地就像没反应。
  it('recognizes Capacitor Android and keeps local music import available', () => {
    capacitorState.native = true;
    capacitorState.platform = 'android';
    expect(isCapacitorAndroid()).toBe(true);
    expect(getRuntimeEnvironment()).toBe('capacitor-android');
    expect(supportsLocalMusicImport()).toBe(true);
  });

  it('does not treat a native non-Android host as Android', () => {
    capacitorState.native = true;
    capacitorState.platform = 'ios';
    expect(isCapacitorAndroid()).toBe(false);
    expect(getRuntimeEnvironment()).toBe('web');
  });
});
