// src/services/beatFx/beatProgress.ts
//
// 拍点分析走到哪一步了。原生侧报上来，设置页那一行照着说。
//
// 为什么需要：这条路（取音频 → 解码 → 算频谱 → 推理）在手机上可能要几十秒，
// 而界面原来只有一句「正在分析这首歌的节拍…」——从头到尾一个字不变。
// 那和卡死在用户眼里没有区别，也没法判断该等还是该退。
// 现在至少能说清「在解码」还是「推理 62%」，卡住时也知道卡在哪一段。
//
// 只读快照 + 订阅，不进 React 状态之外的东西；原生每秒报几次，不构成负担。

export type BeatAnalysisStage = 'prepare' | 'decode' | 'mel' | 'infer';

export interface BeatAnalysisProgress {
    stage: BeatAnalysisStage;
    /** 这一段自己的进度，0..1。 */
    percent: number;
    /** 这一轮开始的时刻（Date.now()），界面自己算已经等了多久。 */
    startedAt: number;
}

let current: BeatAnalysisProgress | null = null;
const listeners = new Set<() => void>();

const emit = () => {
    for (const listener of listeners) listener();
};

export const subscribeBeatAnalysisProgress = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

export const getBeatAnalysisProgress = (): BeatAnalysisProgress | null => current;

/** 一次查找开始。重复调用只重置阶段，不重置计时 —— 重试仍算同一轮等待。 */
export const beginBeatAnalysisProgress = () => {
    current = { stage: 'prepare', percent: 0, startedAt: current?.startedAt ?? Date.now() };
    emit();
};

export const reportBeatAnalysisProgress = (stage: BeatAnalysisStage, percent: number) => {
    current = {
        stage,
        percent: Number.isFinite(percent) ? Math.max(0, Math.min(1, percent)) : 0,
        startedAt: current?.startedAt ?? Date.now(),
    };
    emit();
};

export const endBeatAnalysisProgress = () => {
    if (!current) return;
    current = null;
    emit();
};
