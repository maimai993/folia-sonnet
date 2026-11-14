import { useEffect } from 'react';
import { useAppViewStore } from '../stores/useAppViewStore';
import {
    refreshNativeOrientation,
    useAndroidPlaybackOrientationStore,
} from '../stores/useAndroidPlaybackOrientationStore';
import { isAndroidAppShell } from '../platform/runtime';

// src/hooks/useAndroidPlaybackOrientation.ts
// 把「现在在不在播放页」告诉原生，让原生按设置决定要不要转屏。
//
// **Web 只说事实，不替原生做判断**：转不转由 PhoneLayoutOrientation.resolve 按
// 「进入可视化自动横屏」这个设置与实际所在页面算。之前那版是 Web 自己判（还要
// 落盘方向必须是竖屏），真机上开了开关毫无反应 —— 两处各判一次就是这样分歧的。
//
// 用 isAndroidAppShell 而不是 isCapacitorAndroid 当门：后者要等桥初始化完才有值，
// 冷启动头几秒一律 false。以前拿它当门，启动那一拍的上报就被跳过；而 effect 只在
// view 变化时重跑 —— 如果启动后一直停在同一页，这次上报就永远不补，Activity 停在
// 上一次请求的方向上（典型表现：先在播放页横屏，切走再回来，主界面也是横的）。

export const useAndroidPlaybackOrientation = (): void => {
    const view = useAppViewStore((state) => state.view);
    const hydrate = useAndroidPlaybackOrientationStore((state) => state.hydrate);
    const autoLandscapeForVisualizer = useAndroidPlaybackOrientationStore(
        (state) => state.autoLandscapeForVisualizer,
    );
    const androidShell = isAndroidAppShell();

    // 启动时读一次开关状态，界面才不会显示成关着。读不到就隔一会儿重试，
    // 别把「桥还没起来」当成「原生说没有这一项」。
    useEffect(() => {
        if (!androidShell) return;
        let cancelled = false;
        let attempts = 0;
        const tick = async () => {
            if (cancelled) return;
            const done = await hydrate();
            if (done || cancelled || attempts >= 20) return;
            attempts += 1;
            setTimeout(() => {
                void tick();
            }, 500);
        };
        void tick();
        return () => {
            cancelled = true;
        };
    }, [androidShell, hydrate]);

    useEffect(() => {
        if (!androidShell) return;
        // 只有播放页要横屏；其它页面一律「不在播放页」，让它把方向还回去。
        const report = () => {
            // 直接读 store 而不是闭包里的 view：回调可能比这次渲染晚一拍。
            const current = useAppViewStore.getState().view;
            void refreshNativeOrientation(current === 'player');
        };
        report();
        /*
         * 回到前台再报一次：在后台期间 Activity 一直维持着上一次请求的方向，
         * 而这段时间页面可能已经换过（从播放页切走、回来时页还在播放页但桥重建过）。
         * 不复报的话，横屏会一直留在不该横的那一页上。
         */
        const onVisibilityChange = () => {
            if (document.visibilityState === 'visible') report();
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };
        // 设置变了也要报一次：开关刚打开时用户就在设置页上，原生按新设置重算 ——
        // 那会儿不在播放页，于是什么都不会转；等真进播放页时由 view 那一项再报。
    }, [androidShell, view, autoLandscapeForVisualizer]);
};
