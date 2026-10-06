import { useEffect } from 'react';
import { Style, StatusBar } from '@capacitor/status-bar';
import { isCapacitorAndroid } from '../platform/runtime';

// 当前文件：标记 Capacitor Android 运行时，并让系统栏图标跟随 Folia 明暗主题。

/**
 * Capacitor Android 下的系统栏处理。
 *
 * 这里**刻意不调用** StatusBar.setOverlaysWebView：插件内部走的是已废弃的
 * decorView.setSystemUiVisibility(SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN)，
 * 它只覆盖状态栏、不覆盖底部导航栏，而且是在 JS 加载后才执行的，
 * 会把 MainActivity 已经压好的全沉浸状态冲掉 —— 表现就是顶部/底部留出一条空白带。
 *
 * 全沉浸与内容铺满现在统一由原生侧负责（MainActivity.applyImmersiveMode，
 * 里面同时做了 setDecorFitsSystemWindows(false) 与双栏透明）。
 *
 * setStyle 保留：它只调 setAppearanceLightStatusBars，改的是图标明暗，
 * 不碰 systemUiVisibility，不会破坏沉浸态。
 */
export const useCapacitorSystemBars = (isDaylight: boolean): void => {
  useEffect(() => {
    if (!isCapacitorAndroid()) return;

    document.documentElement.dataset.runtime = 'capacitor-android';
    void StatusBar.setStyle({ style: isDaylight ? Style.Dark : Style.Light });

    return () => {
      delete document.documentElement.dataset.runtime;
    };
  }, [isDaylight]);
};
