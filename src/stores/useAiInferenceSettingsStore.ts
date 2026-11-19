// src/stores/useAiInferenceSettingsStore.ts
// 「禁用 AI 推理」总闸（issue #401）。
//
// 默认**打开**：发出去的包默认不在这台手机上启任何推理 —— 在线补全（AI 主题 / 歌词动画导演 /
// 云缓存）与本地模型（beat_this 拍点、SCNet/htdemucs 分轨）全部不发起。想要这些功能的人自己
// 去「设置 → 动画与性能」把它关掉。
//
// 为什么默认关掉推理：一次整曲分析要在手机上跑几十秒到几分钟的模型，峰值内存是整机的大头；
// 用户报的 OOM 与被系统杀进程基本都出自这条路。默认保守，能力留给主动要的人。

import { create } from 'zustand';
import { getStoredBoolean, setStoredBoolean } from './storagePrimitives';

const AI_INFERENCE_DISABLED_KEY = 'folia_ai_inference_disabled';

type AiInferenceSettingsState = {
    /** true = 不许启动任何 AI 推理（默认）。 */
    aiInferenceDisabled: boolean;
    setAiInferenceDisabled: (disabled: boolean) => void;
};

export const useAiInferenceSettingsStore = create<AiInferenceSettingsState>((set) => ({
    aiInferenceDisabled: getStoredBoolean(AI_INFERENCE_DISABLED_KEY, true),
    setAiInferenceDisabled: (disabled) => {
        setStoredBoolean(AI_INFERENCE_DISABLED_KEY, disabled);
        set({ aiInferenceDisabled: disabled });
    },
}));

/** 不订阅的读法（闸门在非 React 代码里用）。 */
export const readAiInferenceDisabled = (): boolean => useAiInferenceSettingsStore.getState().aiInferenceDisabled;

export const AI_INFERENCE_DISABLED_STORAGE_KEY = AI_INFERENCE_DISABLED_KEY;
