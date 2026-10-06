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

export const supportsLocalMusicImport = (): boolean => !isCapacitorAndroid();
