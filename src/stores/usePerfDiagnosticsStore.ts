import { create } from 'zustand';

export const PERF_DIAGNOSTICS_STORAGE_KEY = 'folia.perfDiagnosticsEnabled';

// src/stores/usePerfDiagnosticsStore.ts
// 「性能采样」开关（开发者选项）。
//
// 帧耗时采样要常驻一条 rAF 循环、媒体诊断要在每个音频事件上记数 —— 这些都是为了
// 排查「用户说卡」而存在的，不是运行时的必要开销。**默认关闭**：只有真的在查问题时
// 由用户打开，采样才启动；关掉时 utils/frameTimingDiagnostics 那条 rAF 循环根本不会挂上。

const readStoredPerfDiagnostics = (): boolean => {
    if (typeof window === 'undefined') return false;
    try {
        return localStorage.getItem(PERF_DIAGNOSTICS_STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
};

type PerfDiagnosticsState = {
    perfDiagnosticsEnabled: boolean;
    setPerfDiagnosticsEnabled: (enabled: boolean) => void;
};

export const usePerfDiagnosticsStore = create<PerfDiagnosticsState>((set) => ({
    perfDiagnosticsEnabled: readStoredPerfDiagnostics(),
    setPerfDiagnosticsEnabled: (enabled) => {
        try {
            localStorage.setItem(PERF_DIAGNOSTICS_STORAGE_KEY, enabled ? 'true' : 'false');
        } catch {
            // 存储写不进去也不能让开关用不了：本轮会话照常生效。
        }
        set({ perfDiagnosticsEnabled: enabled });
    },
}));
