// src/services/videoLayerEnabledLease.ts
//
// 「视频层这一段是通过临时注入露出来的」这件事的计数。
//
// 谁要把画面注入视频层，就借一次（acquire）；不需要了就还（release）。租约从 0 变成 1 时
// 才真的去开那一层的开关，从 1 变回 0 时才真的去关 —— 中间来回切换画质、切歌、切换注入方，
// 都不会开开关关一遍。
//
// 回滚资格看的是 store 记下的**写入来源**（`lastSetBy`），不是借的那一刻采到的原值：
// 开关原本关着时，借的那一次写成来源 `'lease'`；归还最后一份时，只有当来源仍然是 `'lease'`
// 才关回去。用户经 `setVideoLayerEnabled` 写一次（不带来源就是用户写的），来源就变成
// `'user'`，租约当场失去回滚资格，这一整段里都不再关它的开关。
//
// 为什么不能靠「借时采一次原值」：那种写法只在 leases 0→1 时看一眼，之后用户对开关的改动
// 它不再观察。用户把它关掉再打开（他认为是自己开的），原值仍然记着 true，还回去时就被
// 无条件关掉并落盘 —— 用户自己开的层，收个面板就没了。
//
// 这条修的是 issue #432：以前注入一处就直接把开关写死成 true 并落盘，预览里看一眼「MV」
// 背景，这一层就被永久打开了。

import { useVideoLayerSettingsStore } from '../stores/useVideoLayerSettingsStore';

let leases = 0;

/**
 * 还完最后一份时，开关是不是该由租约关回去。
 *
 * 只有「来源仍是 lease」才该关：用户中途动过（开或关都算），那一次写入就是用户的意思，
 * 租约不再欠任何回滚。lease 段 0→1 时来源是上一段留下的，不可能是本段的。
 */
const shouldRollBack = () => useVideoLayerSettingsStore.getState().lastSetBy === 'lease';

/** 借一份「视频层要露出来」。返回的还回去的函数重复调用没有副作用。 */
export const acquireVideoLayerEnabled = (): (() => void) => {
    if (leases === 0) {
        const store = useVideoLayerSettingsStore.getState();
        // 本来就是开的就不要再写一遍：那条路会落盘，等于替用户记了一次无关的写入。
        // 来源因此仍是用户（或上一段租约留下的）的，还回去时也不会碰它。
        if (!store.videoLayerEnabled) store.setVideoLayerEnabled(true, 'lease');
    }
    leases += 1;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        leases -= 1;
        if (leases > 0) return;
        // 只关自己开的那一次：用户中途动过（来源已变成 user）的话这里不碰。
        if (shouldRollBack()) useVideoLayerSettingsStore.getState().setVideoLayerEnabled(false, 'lease');
    };
};
