import { registerPlugin } from '@capacitor/core';

// src/platform/foliaNative.ts
// 通用原生插件（FoliaNative）的 Web 侧入口。
//
// 这里只放那些不属于某个具体功能（壁纸 / 状态栏歌词）的小动作：退出、屏幕常亮。
// 它们共同点是「只有原生能做，且不需要知道播放器里发生了什么」。

interface FoliaNativePlugin {
    exitApp(): Promise<void>;
    /**
     * 屏幕常亮开关。
     *
     * 传进来的值必须是**已经算好的结论**（开关 && 正在播放）：原生那边的 FLAG 只有
     * 开和关，它不该、也不知道「什么算在播」。
     */
    setScreenAwake(options: { awake: boolean }): Promise<void>;
}

const FoliaNative = registerPlugin<FoliaNativePlugin>('FoliaNative');

/**
 * 让屏幕保持常亮（或交还给系统）。
 *
 * 用窗口的 FLAG_KEEP_SCREEN_ON 而不是 WakeLock（见原生那边的说明）：
 * 这个标记只在**我们的窗口在前台**时有效，应用退到后台后系统照常熄屏 ——
 * 所以根本不存在「忘了关就一直耗电」这回事，也不需要在生命周期里到处补释放。
 */
export const setScreenAwake = async (awake: boolean): Promise<void> => {
    try {
        await FoliaNative.setScreenAwake({ awake });
    } catch {
        // 桌面端 / 插件不可用：静默，屏幕常亮不该影响播放本身。
    }
};
