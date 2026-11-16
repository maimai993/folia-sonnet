// src/stores/useVideoSettingsStore.ts
// 影视源的配置：一份 TVBox 配置地址（例如饭太硬）。影视入口、首页推荐与搜索都从这份配置取片源。
//
// 与音乐侧的 provider 注册表完全分开：音乐按服务商分账号，影视只有一份配置地址。

import { create } from 'zustand';
import { getStoredString, removeStoredKey, setStoredString } from './storagePrimitives';

const VIDEO_SOURCE_KEY = 'video_source_url';

interface VideoSettingsState {
    videoSourceUrl: string;
    setVideoSourceUrl: (url: string) => void;
    clearVideoSourceUrl: () => void;
}

export const useVideoSettingsStore = create<VideoSettingsState>((set) => ({
    videoSourceUrl: getStoredString(VIDEO_SOURCE_KEY, '').trim(),
    setVideoSourceUrl: (url) => {
        const next = url.trim();
        setStoredString(VIDEO_SOURCE_KEY, next);
        set({ videoSourceUrl: next });
    },
    clearVideoSourceUrl: () => {
        removeStoredKey(VIDEO_SOURCE_KEY);
        set({ videoSourceUrl: '' });
    },
}));
