import { create } from 'zustand';
import { getStoredBoolean } from './storagePrimitives';

// src/stores/useRhineOverlayStore.ts
//
// 莱茵生命首页的「卡片变歌词可视化」开关。
//
// 开了之后有两件事同时发生：
//   1. 首页那张展开的透明卡片整块让给 Folia 的歌词可视化（两个圆环藏掉）。
//   2. 播放**不再**默认跳进全屏播放页 —— 可视化就在卡片上了，再跳走反而打断。
//
// 第二点是这个开关存在的主要理由：用户不想为了看可视化被从档案首页拽走。
// 所以它不是纯视觉开关，`RhineHome` 与播放跳转都要读它。

const STORAGE_KEY = 'rhine_card_visualizer';

type RhineOverlayState = {
    /** 卡片是否整块变成歌词可视化。 */
    cardVisualizer: boolean;
    setCardVisualizer: (enabled: boolean) => void;
    handleToggleCardVisualizer: (enabled: boolean) => void;
};

export const useRhineOverlayStore = create<RhineOverlayState>((set) => ({
    // 默认关闭：开着的话圆环就看不见了，那是这块卡片的原貌，得让用户自己选。
    cardVisualizer: getStoredBoolean(STORAGE_KEY, false),
    setCardVisualizer: (enabled) => set({ cardVisualizer: enabled }),
    handleToggleCardVisualizer: (enabled) => {
        try {
            localStorage.setItem(STORAGE_KEY, String(enabled));
        } catch (error) {
            console.warn('[rhine] 无法保存卡片可视化开关', error);
        }
        set({ cardVisualizer: enabled });
    },
}));
