import { create } from 'zustand';
import type { AutoAlignSkipReason } from '../utils/lyrics/autoAlignOffset';

// src/stores/useLyricCalibrationStore.ts
//
// 自动校准的开关与最近一次结果。
//
// 只放这几样东西：开不开、这一首跑到哪一步了、跑出了什么、以及「现在马上再跑一次」的令牌。
// 偏移本身仍然归 playback store（`lyricTimelineOffsetMs`）和 lyricOffsetMemory 管 ——
// 两个地方各存一份偏移，迟早会打架。

const STORAGE_KEY = 'lyric_auto_calibration';

export type AutoCalibrationPhase =
    /** 还没轮到（没歌词、没播、或已经跑过了）。 */
    | 'idle'
    /** 正在读音频、估偏移。 */
    | 'running'
    /** 估出来并已应用。 */
    | 'applied'
    /** 算过，但偏差太小 / 置信度不够 —— 保持原样。 */
    | 'skipped'
    /** 拿不到这首歌的音频（没下载、没缓存），自动校准无从谈起。 */
    | 'no-audio'
    /** 音频读到了，但时长超过分析上限（12 分钟），没有扫。 */
    | 'too-long'
    /** 音频读到了，但解不开（容器/编码不支持，或文件坏了）。 */
    | 'decode-failed'
    /** 这一首已经有手动偏移：自动校准不介入，手动值优先。 */
    | 'manual';

interface LyricCalibrationState {
    autoEnabled: boolean;
    phase: AutoCalibrationPhase;
    /** 最近一次自动校准给出的偏移（毫秒），仅用于显示。 */
    lastOffsetMs: number;
    /** 「没改」的那三种原因，用来把状态行写具体：偏差太小 / 各行不一致 / 行数不够。 */
    lastReason: AutoAlignSkipReason | null;
    /**
     * 手动「重新校准」的令牌：每次加一，正在跑的校准据此重新开跑。
     *
     * 用令牌而不是布尔，是因为「跑完再点一次」必须还能触发 —— 布尔值在跑完之后没有变化，
     * effect 不会重跑。
     */
    runToken: number;
    setAutoEnabled: (enabled: boolean) => void;
    setResult: (phase: AutoCalibrationPhase, offsetMs?: number, reason?: AutoAlignSkipReason | null) => void;
    requestRun: () => void;
    reset: () => void;
}

const readEnabled = (): boolean => {
    if (typeof window === 'undefined') {
        return true;
    }
    try {
        // 默认开：用户要的就是「不用管它，自己对齐」。设置里明确关过才关。
        return localStorage.getItem(STORAGE_KEY) !== '0';
    } catch {
        return true;
    }
};

export const useLyricCalibrationStore = create<LyricCalibrationState>(set => ({
    autoEnabled: readEnabled(),
    phase: 'idle',
    lastOffsetMs: 0,
    lastReason: null,
    runToken: 0,
    setAutoEnabled: (enabled) => {
        set({ autoEnabled: enabled, phase: 'idle' });
        try {
            localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
        } catch {
            // 存不下就只在本次会话生效，不影响校准本身。
        }
    },
    setResult: (phase, offsetMs = 0, reason = null) => set({
        phase,
        lastOffsetMs: phase === 'applied' ? offsetMs : 0,
        lastReason: phase === 'skipped' ? reason : null,
    }),
    // 面板上的「重新校准」：把上一次的结论换成「正在跑」，令牌一变，正在听的那一首重新估。
    requestRun: () => set(state => ({ phase: 'running', lastOffsetMs: 0, lastReason: null, runToken: state.runToken + 1 })),
    reset: () => set({ phase: 'idle', lastOffsetMs: 0, lastReason: null }),
}));
