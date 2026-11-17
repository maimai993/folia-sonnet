// src/components/modal/settings/desktopSettingsBridge.ts
// 设置窗启动时「能不能向主进程读桌面设置」的判断。
//
// 只问 `window.electron` 在不在是不够的：安卓为了让模组能用，会在同一个对象上装一份
// 只有 `mods` / `appleMusicRequest` 的 shim（src/mods/android/androidModsBridge.ts），
// 没有 `platform`，也没有 `getSettings` / `getCacheDirectory`。按对象存在与否判的话，
// 安卓上一打开设置就 `electron.getSettings is not a function` 崩掉（界面表现为设置页
// 突然变成一块报错回退）。所以这里按方法逐个判，缺一个就当「读不到」。

/** 桌面 preload 上设置窗启动时要用的那两个读接口。 */
const REQUIRED_READERS = ['getSettings', 'getCacheDirectory'] as const;

/** 设置窗现在能不能向主进程读桌面设置。非浏览器环境与任何缺少读接口的桥都返回 false。 */
export const canReadDesktopSettings = (): boolean => {
    if (typeof window === 'undefined') {
        return false;
    }
    const bridge = (window as typeof window & { electron?: Record<string, unknown> }).electron;
    if (!bridge) {
        return false;
    }
    return REQUIRED_READERS.every(name => typeof bridge[name] === 'function');
};
