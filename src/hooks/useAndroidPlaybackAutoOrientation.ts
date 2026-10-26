import { useEffect } from 'react';
import { isAndroidAppShell } from '../platform/runtime';
import type { AndroidOrientationOverride, AndroidPhoneFitOrientation } from '../services/androidPhoneLayout';
import { useAndroidLayoutSettingsStore } from '../stores/useAndroidLayoutSettingsStore';
import { useAppViewStore, type AppView } from '../stores/useAppViewStore';
import { usePlaybackEntryViewStore, type PlaybackEntryView } from '../stores/usePlaybackEntryViewStore';

// src/hooks/useAndroidPlaybackAutoOrientation.ts
// 「进入可视化自动横屏」（安卓，默认关）：播放后进入的视图是可视化时，进播放页锁横屏、
// 离开播放页锁回竖屏。
//
// 两条都成立才动手，缺一条就把覆盖撤掉：
//   · 开关开着 —— 转屏是件大事，默认不替用户决定；
//   · 播放后进入的视图是可视化 —— 选了 Lattice 或「留在原处」的人点播放不会去播放页。
//
// ⚠️ 曾经还有第三条「落盘方向必须是竖屏」，理由是「已经选了强制横屏的人整屏本来就是
// 横的，不需要这套」。这条是错的：强制横屏是**全程**横屏，自动横屏是**只在播放页**横屏，
// 两者不冲突；而它让改过一次方向的人打开这个开关毫无反应（用户报「没有用」），且不给
// 任何提示。现在覆盖无条件压着落盘那份，退出播放页改为回到用户自己选的方向。
//
// 只看当前在哪一页（`useAppViewStore.view`），不看是走哪条路进来的：可视化横着看更好，
// 从胶囊、搜索结果、启动恢复进来都一样。退出那一下同理 —— 离开播放页就转回去，
// 不管是返回、回首页还是去了 Lattice。
//
// 覆盖写进 store 而不是直接调原生，是为了让「设置里看到的方向」与「屏幕实际的方向」
// 永远由同一处（effectivePhoneFitOrientation）决定。

/** 「要不要覆盖」这件事本身，与 React 无关，单独拿出来的好处是能被直接测。 */
export const resolvePlaybackAutoOrientationOverride = ({
    autoEnabled,
    playbackEntryView,
    view,
}: {
    autoEnabled: boolean;
    /** 落盘那份选择。**不再参与判定**（见文件头），保留在签名里是为了调用点读得懂上下文。 */
    storedOrientation?: AndroidPhoneFitOrientation;
    playbackEntryView: PlaybackEntryView;
    view: AppView;
}): AndroidOrientationOverride => {
    if (!autoEnabled || playbackEntryView !== 'player') return null;
    // 在播放页锁横屏；离开播放页回到**用户自己选的那个方向**（而不是一律竖屏），
    // 这样同时开了强制横屏的人退出后仍然是横的。
    return view === 'player' ? 'landscape' : null;
};

export const useAndroidPlaybackAutoOrientation = (): void => {
    const view = useAppViewStore(state => state.view);
    const playbackEntryView = usePlaybackEntryViewStore(state => state.playbackEntryView);
    const autoEnabled = useAndroidLayoutSettingsStore(state => state.autoLandscapeForVisualizer);
    const setOverride = useAndroidLayoutSettingsStore(state => state.setPhoneFitOrientationOverride);

    useEffect(() => {
        if (!isAndroidAppShell()) return;
        setOverride(resolvePlaybackAutoOrientationOverride({
            autoEnabled,
            playbackEntryView,
            view,
        }));
    }, [autoEnabled, playbackEntryView, setOverride, view]);
};
