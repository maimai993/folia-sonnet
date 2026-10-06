import { useEffect } from 'react';
import { Style, StatusBar } from '@capacitor/status-bar';
import { isCapacitorAndroid } from '../platform/runtime';

// 当前文件：让 Android 系统栏跟随 Folia 明暗主题，并标记原生安全区环境。

export const useCapacitorSystemBars = (isDaylight: boolean): void => {
  useEffect(() => {
    if (!isCapacitorAndroid()) return;

    document.documentElement.dataset.runtime = 'capacitor-android';
    void StatusBar.setOverlaysWebView({ overlay: true });
    void StatusBar.setBackgroundColor({ color: '#00000000' });
    void StatusBar.setStyle({ style: isDaylight ? Style.Dark : Style.Light });

    return () => {
      delete document.documentElement.dataset.runtime;
    };
  }, [isDaylight]);
};
