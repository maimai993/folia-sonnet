import { create } from 'zustand';
import { getStoredBoolean, setStoredBoolean } from './storagePrimitives';

// src/stores/useScreenAwakeSettingsStore.ts
// 界面设置里的「保持屏幕常亮」：开着的时候只要 App 在前台屏幕就不熄，与是否在播放无关。
//
// 播放设置里还有一个「播放时保持屏幕常亮」，只在播放中生效。两个开关共用原生那**一个**
// 窗口 FLAG_KEEP_SCREEN_ON，所以这里只存开关本身，取或的活交给 useScreenAwake ——
// 原生只有一个 FLAG，不该让它知道界面上有两个开关、以及「什么算正在播」。

const KEEP_SCREEN_AWAKE_KEY = 'folia_keep_screen_awake';

type ScreenAwakeSettingsState = {
    keepScreenAwake: boolean;
    setKeepScreenAwake: (enabled: boolean) => void;
};

export const useScreenAwakeSettingsStore = create<ScreenAwakeSettingsState>((set) => ({
    // 默认关：常亮是最费电的那类开关，不能替用户默认打开。
    keepScreenAwake: getStoredBoolean(KEEP_SCREEN_AWAKE_KEY, false),
    setKeepScreenAwake: (enabled) => {
        setStoredBoolean(KEEP_SCREEN_AWAKE_KEY, enabled);
        set({ keepScreenAwake: enabled });
    },
}));
