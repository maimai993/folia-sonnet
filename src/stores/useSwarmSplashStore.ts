// src/stores/useSwarmSplashStore.ts
// 「群体光标启动动画」的开关。默认打开：想要安静启动的人自己去关掉。
//
// 关掉之后启动就是原来的「首屏加载遮罩 → 直接进界面」，不再播放建造动画。

import { create } from 'zustand';
import { getStoredBoolean, setStoredBoolean } from './storagePrimitives';

const SWARM_SPLASH_KEY = 'folia_swarm_splash_enabled';

type SwarmSplashState = {
    /** true = 启动时播放群体光标建造动画（默认）。 */
    swarmSplashEnabled: boolean;
    setSwarmSplashEnabled: (enabled: boolean) => void;
};

export const useSwarmSplashStore = create<SwarmSplashState>((set) => ({
    swarmSplashEnabled: getStoredBoolean(SWARM_SPLASH_KEY, true),
    setSwarmSplashEnabled: (enabled) => {
        setStoredBoolean(SWARM_SPLASH_KEY, enabled);
        set({ swarmSplashEnabled: enabled });
    },
}));

/** 不订阅的读法（启动链路在 React 之外用）。 */
export const readSwarmSplashEnabled = (): boolean => useSwarmSplashStore.getState().swarmSplashEnabled;

export const SWARM_SPLASH_STORAGE_KEY = SWARM_SPLASH_KEY;
