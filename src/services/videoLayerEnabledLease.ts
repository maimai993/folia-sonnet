// src/services/videoLayerEnabledLease.ts
//
// 「视频层这一段是通过临时注入露出来的」这件事的计数。
//
// 谁要把画面注入视频层，就借一次（acquire）；不需要了就还（release）。租约从 0 变成 1 时
// 才真的去开那一层的开关，从 1 变回 0 时才真的去关 —— 中间来回切换画质、切歌、切换注入方，
// 都不会开开关关一遍。
//
// 只有这里清楚「这一层的开关原本是关的」：开的那一次记下原值，还完最后一份时**只回滚自己
// 开的那一次**。用户自己开着视频层的话，借的时候它就是开的，于是原值记成 false，还的时候
// 什么都不做 —— 来回切背景都关不掉用户自己开的层。
//
// 这条修的是 issue #432：以前注入一处就直接把开关写死成 true 并落盘，预览里看一眼「MV」
// 背景，这一层就被永久打开了。

import { useVideoLayerSettingsStore } from '../stores/useVideoLayerSettingsStore';

let leases = 0;
/** 开关是这一次借的时候被我们打开的 —— 也就是「等会儿该由我们关回去」。 */
let openedByLease = false;

/** 开关此刻是不是被租约打开着（不是用户自己开的）。 */
export const isVideoLayerEnabledByLease = (): boolean => leases > 0 && openedByLease;

/** 借一份「视频层要露出来」。返回的还回去的函数重复调用没有副作用。 */
export const acquireVideoLayerEnabled = (): (() => void) => {
    if (leases === 0) {
        const store = useVideoLayerSettingsStore.getState();
        openedByLease = !store.videoLayerEnabled;
        // 本来就是开的就不要再写一遍：那条路会落盘，等于替用户记了一次无关的写入。
        if (openedByLease) store.setVideoLayerEnabled(true);
    }
    leases += 1;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        leases -= 1;
        if (leases > 0) return;
        const rollBack = openedByLease;
        openedByLease = false;
        // 只关自己开的那一次：用户本来就开着的话，openedByLease 是 false，这里不碰。
        if (rollBack) useVideoLayerSettingsStore.getState().setVideoLayerEnabled(false);
    };
};
