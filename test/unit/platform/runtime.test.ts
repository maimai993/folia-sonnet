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
    vi.stubGlobal('window', { electron: {} });
    expect(getRuntimeEnvironment()).toBe('electron');
  });

  it('recognizes Capacitor Android and disables local music import', () => {
    capacitorState.native = true;
    capacitorState.platform = 'android';
    expect(isCapacitorAndroid()).toBe(true);
    expect(getRuntimeEnvironment()).toBe('capacitor-android');
    expect(supportsLocalMusicImport()).toBe(false);
  });

  it('does not treat a native non-Android host as Android', () => {
    capacitorState.native = true;
    capacitorState.platform = 'ios';
    expect(isCapacitorAndroid()).toBe(false);
    expect(getRuntimeEnvironment()).toBe('web');
  });
});
