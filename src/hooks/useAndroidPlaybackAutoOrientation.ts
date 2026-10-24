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
// 三条都成立才动手，缺一条就把覆盖撤掉：
//   · 开关开着 —— 转屏是件大事，默认不替用户决定；
//   · 落盘的方向是竖屏 —— 已经选了「强制横屏」的人整屏本来就是横的，不需要这套；
//   · 播放后进入的视图是可视化 —— 选了 Lattice 或「留在原处」的人点播放不会去播放页。
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
    storedOrientation,
    playbackEntryView,
    view,
}: {
    autoEnabled: boolean;
    storedOrientation: AndroidPhoneFitOrientation;
    playbackEntryView: PlaybackEntryView;
    view: AppView;
}): AndroidOrientationOverride => {
    if (!autoEnabled || storedOrientation !== 'portrait' || playbackEntryView !== 'player') return null;
    return view === 'player' ? 'landscape' : 'portrait';
};

export const useAndroidPlaybackAutoOrientation = (): void => {
    const view = useAppViewStore(state => state.view);
    const playbackEntryView = usePlaybackEntryViewStore(state => state.playbackEntryView);
    const autoEnabled = useAndroidLayoutSettingsStore(state => state.autoLandscapeForVisualizer);
    const storedOrientation = useAndroidLayoutSettingsStore(state => state.phoneFitOrientation);
    const setOverride = useAndroidLayoutSettingsStore(state => state.setPhoneFitOrientationOverride);

    useEffect(() => {
        if (!isAndroidAppShell()) return;
        setOverride(resolvePlaybackAutoOrientationOverride({
            autoEnabled,
            storedOrientation,
            playbackEntryView,
            view,
        }));
    }, [autoEnabled, playbackEntryView, setOverride, storedOrientation, view]);
};
