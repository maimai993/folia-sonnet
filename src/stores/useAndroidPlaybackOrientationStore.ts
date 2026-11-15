import { create } from 'zustand';
import { readNativeSettings, writeNativeSettings } from '../services/nativeSettingsBridge';

// src/stores/useAndroidPlaybackOrientationStore.ts
// 「进入可视化自动横屏」的开关状态。**真相在原生设置里**，这里只是一份供界面读的镜像。
//
// 为什么不放 localStorage：转不转屏由原生判断（PhoneLayoutOrientation.resolve），
// 它读的是原生设置（FoliaSettingsStore）。如果开关只写 localStorage，原生那份永远是
// 默认的 false —— 打开开关毫无反应。之前那版正是两边各存一份、各判一次。

type AndroidPlaybackOrientationState = {
    autoLandscapeForVisualizer: boolean;
    /**
     * 从原生读一次。读到返回 true，没读到时保持原状（不知道 ≠ 关掉）并把 false 交回去，
     * 调用方据此重试 —— 冷启动头几秒桥还没起来，一次读不到就再也不读会让界面永远显示
     * 默认值，用户以为「设置没保存」。
     */
    hydrate: () => Promise<boolean>;
    setAutoLandscapeForVisualizer: (enabled: boolean) => Promise<void>;
};

export const useAndroidPlaybackOrientationStore = create<AndroidPlaybackOrientationState>((set) => ({
    autoLandscapeForVisualizer: false,
    hydrate: async () => {
        const settings = await readNativeSettings();
        if (!settings) return false;
        set({ autoLandscapeForVisualizer: settings.autoLandscapeForVisualizer === true });
        return true;
    },
    setAutoLandscapeForVisualizer: async (enabled) => {
        // 先按用户点的样子显示（这是人手点的，不该有延迟感），再以原生返回的为准。
        set({ autoLandscapeForVisualizer: enabled });
        const merged = await writeNativeSettings({ autoLandscapeForVisualizer: enabled });
        if (!merged) {
            // 写失败就退回原状 —— 停在「看起来开了」是最坏的结果。
            set({ autoLandscapeForVisualizer: !enabled });
            return;
        }
        set({ autoLandscapeForVisualizer: merged.autoLandscapeForVisualizer === true });
        /*
         * 这里**不**去重算方向：那要知道「此刻在哪一页」，而这个 store 不该认得视图。
         * 让 hook 盯着这一项的变化去报（见 useAndroidPlaybackOrientation）。
         *
         * 顺带修掉一处语义错：以前这里调 refreshNativeOrientation(get().开关值)，
         * 把**设置值**当成「我在播放页」传给原生 —— 用户在设置页里打开开关，
         * 原生会以为他正在可视化页，当场就想转屏。
         */
    },
}));

/**
 * 插件还没挂上时的重试间隔（毫秒，逐次叠加）。冷启动头几秒 `Capacitor.Plugins` 里
 * 可能还没有 FoliaNative，一次没拿到就放弃，那一次「我在播放页」就永久丢了 ——
 * Activity 会一直停在旧方向上（典型表现：从播放页切走后回来，主界面也是横的）。
 */
const PLUGIN_RETRY_DELAYS_MS = [0, 300, 800, 1500, 2500];

/**
 * 让原生按当前设置重算方向。**只报「在不在播放页」，不报「该不该转」**：
 * 判定全部留在原生，Web 说多了就会与它分歧。
 */
export const refreshNativeOrientation = async (playerVisible: boolean): Promise<void> => {
    if (typeof window === 'undefined') return;
    const g = window as unknown as {
        Capacitor?: { getPlatform?: () => string; Plugins?: Record<string, unknown> };
    };
    for (const delay of PLUGIN_RETRY_DELAYS_MS) {
        if (delay > 0) {
            await new Promise<void>((resolve) => {
                setTimeout(resolve, delay);
            });
        }
        const plugin = g.Capacitor?.Plugins?.FoliaNative as
            | { setPlayerVisible?: (o: { visible: boolean }) => Promise<unknown> }
            | undefined;
        if (!plugin?.setPlayerVisible) continue;
        try {
            await plugin.setPlayerVisible({ visible: playerVisible });
            return;
        } catch (error) {
            console.warn('[nativeOrientation] 上报播放页可见性失败', error);
            return;
        }
    }
    console.warn('[nativeOrientation] 桥一直没就绪，这次上报没送到', playerVisible);
};
