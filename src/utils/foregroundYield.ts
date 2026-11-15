// src/utils/foregroundYield.ts
// 「后台就别算了」的一个小工具，给 Web 侧那些按块推进的长任务用。
//
// 为什么不靠浏览器自己的节流：安卓的 WebView 退后台会冻结 JS，确实不跑了；
// 但桌面端（Electron）为了后台播放把 backgroundThrottling 关掉了，定时器照跑，
// 于是一首四分钟歌的分块分析会在没人看的时候继续吃 CPU。
// 原生侧的分块让路在 automix 里（AutomixLoad.kt），这里管的是 Web 侧这一半。
//
// 语义是「等到前台」而不是「放弃」：回前台后接着算，结果与一直算完全相同，
// 只是把 CPU 空出来给后台播放。

import { isBackgroundRenderSuspended, subscribeBackgroundRenderSuspended } from './backgroundRenderGate';

/** 现在是不是没人看着画面（安卓的 appBackground 事件或页面的 visibility）。 */
export const isAppInBackground = (): boolean => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return true;
    return isBackgroundRenderSuspended();
};

/**
 * 后台就等着，回到前台再返回。
 *
 * @param keepWaiting 每轮问一次「还要不要这份结果」（比如这首歌还是不是当前歌）。
 *                    false 立刻返回 false，调用方按「被放弃」处理 —— 否则后台切歌后
 *                    这个等待会一直挂到回前台。
 * @returns 真：已在前台且仍然需要；假：不需要了，调用方该收尾。
 */
export const waitForForeground = async (keepWaiting?: () => boolean): Promise<boolean> => {
    while (isAppInBackground()) {
        if (keepWaiting && !keepWaiting()) return false;
        await new Promise<void>((resolve) => {
            let settled = false;
            let unsubscribe: (() => void) | null = null;
            let timer: ReturnType<typeof setTimeout> | null = null;
            const finish = () => {
                if (settled) return;
                settled = true;
                unsubscribe?.();
                if (timer !== null) clearTimeout(timer);
                resolve();
            };
            unsubscribe = subscribeBackgroundRenderSuspended((suspended) => {
                if (!suspended) finish();
            });
            // 事件是主路径；定时器只是兜底（例如页面可见性直接变了却没走闸门）。
            timer = setTimeout(finish, 1000);
        });
    }
    return keepWaiting ? keepWaiting() : true;
};

export default waitForForeground;
