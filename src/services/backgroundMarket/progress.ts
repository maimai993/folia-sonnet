// src/services/backgroundMarket/progress.ts
//
// 背景下载进度的订阅口。
//
// 视频几十上百 MB，没有进度用户只会以为卡死了。
// 原生那边已经会发 `videoDownloadProgress`，这里把它收成一个简单的订阅。
//
// 一个进程里只挂一个原生监听，多个组件订阅时共享 ——
// 每个组件各挂一个的话，切几次标签页就积一堆监听器。

import { subscribeVideoDownloadProgress } from '../../platform/foliaWallpaper';
import { isCapacitorAndroid } from '../../platform/runtime';

type Listener = (progress: number) => void;

const listeners = new Set<Listener>();
let attached = false;

const emit = (progress: number) => {
    for (const listener of listeners) {
        try {
            listener(progress);
        } catch {
            // 单个订阅者出错不该影响别人。
        }
    }
};

/** 挂一次原生监听，之后复用。 */
const attach = () => {
    if (attached || !isCapacitorAndroid()) return;
    attached = true;
    void subscribeVideoDownloadProgress((progress) => {
        // 留 5% 给「落盘 + 切换模式」那一步，别让进度条停在 100% 却还没好。
        emit(Math.min(0.95, progress));
    }).catch(() => {
        attached = false;
    });
};

/** 订阅背景下载进度，返回取消订阅函数。 */
export const subscribeBackgroundProgress = (listener: Listener): (() => void) => {
    listeners.add(listener);
    attach();
    return () => {
        listeners.delete(listener);
    };
};

/**
 * 「App 内」那条路自己报进度。
 *
 * 桌面壁纸是原生下载、原生发 `videoDownloadProgress`；App 内是网页自己 fetch，
 * 原生看不见，只能由取字节的地方（apply.ts 的 fetchAsFile）直接报上来。
 * 两条路共用一个订阅口，设置页那边就不用关心下载发生在哪一侧。
 */
export const emitBackgroundProgress = (progress: number): void => {
    emit(Math.min(1, Math.max(0, progress)));
};
