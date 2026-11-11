// src/components/modal/settings/useOverlayTouchRelease.ts
//
// 设置窗口开着的时候，让模组悬浮窗把触摸让出来。
//
// 为什么要有这个：悬浮窗是 `TYPE_APPLICATION_OVERLAY`，天生盖在 Activity 之上。
// 它只要不穿透，落在它那一块区域的点击就被它吃掉 —— 用户看到的是
// 「设置页怎么点都没反应」，而把模组关掉就正常（实测就是这样）。
//
// 单独一个 hook 而不是写在 SettingsModal 里：那个文件已经贴着 800 行的基线，
// 每个功能往里塞几行很快就会超。

import { useEffect } from 'react';
import { setModOverlaysInteractive } from '../../../mods/android/androidModsBridge';

/**
 * 挂载期间让悬浮窗不接收触摸，卸载时恢复。
 *
 * 只切原生窗口的 `FLAG_NOT_TOUCHABLE`，不销毁窗口 —— 关掉设置后模组页面状态还在。
 */
export const useOverlayTouchRelease = (): void => {
    useEffect(() => {
        void setModOverlaysInteractive(false);
        return () => {
            void setModOverlaysInteractive(true);
        };
    }, []);
};
