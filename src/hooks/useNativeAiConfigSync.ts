import { useEffect } from 'react';
import {
    AI_SETTINGS_CHANGED_EVENT,
} from '../services/aiSettings';
import { pushAiConfigToNative } from '../services/aiNativeCompletion';
import { isCapacitorAndroid } from '../platform/runtime';

// src/hooks/useNativeAiConfigSync.ts
// AI 连接配置的启动同步 + 变化跟随：凭据**只存原生**（FoliaSettingsStore），
// 真正发 AI 请求的是原生 —— Web 的 localStorage 那份只给设置界面。
//
// 启动推一次（原生冷启动后没有配置，凭据只在 Web 这边）；用户改设置（事件）再推。
// 推送失败静默：原生会按「未配置」处理，Web 侧那条回落路（aiNativeFetch）照样能用。

export const useNativeAiConfigSync = (): void => {
    useEffect(() => {
        if (!isCapacitorAndroid()) return;
        void pushAiConfigToNative();

        const onSettingsChanged = (): void => {
            void pushAiConfigToNative();
        };
        window.addEventListener(AI_SETTINGS_CHANGED_EVENT, onSettingsChanged);
        return () => {
            window.removeEventListener(AI_SETTINGS_CHANGED_EVENT, onSettingsChanged);
        };
    }, []);
};
