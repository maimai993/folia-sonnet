import { create } from 'zustand';

// src/stores/usePendingResumeStore.ts
// 会话恢复出的「上次听到哪儿」。恢复是异步的，位置可能比原生装源 effect 更晚落地；只放
// ref 里不会触发重渲染，装源 effect 读不到就不会重跑。这里用 store 状态，让装源 effect 在
// 位置就绪后再跑一次（已经装过源时只 seek、不重装）。
//
// 连同 songKey 一起存：只认「恢复出的那一首」，换歌之后旧位置不能被错用。会话恢复那条路
// 同时写 ref（给 <audio> 路），其余路径仍只写 ref，store 里没有或对不上当前这首歌就退回 ref。

type PendingResume = {
    songKey: string;
    seconds: number;
};

type PendingResumeState = {
    pendingResume: PendingResume | null;
    setPendingResume: (resume: PendingResume | null) => void;
};

export const usePendingResumeStore = create<PendingResumeState>(set => ({
    pendingResume: null,
    setPendingResume: resume => set({ pendingResume: resume }),
}));
