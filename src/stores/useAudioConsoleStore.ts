// src/stores/useAudioConsoleStore.ts
// 调音台的状态：混响、压缩器、前置/后置 EQ 的形状。
//
// 为什么单开一个 store 而不是塞进 useAudioSettingsStore：那个 store 已经背着整首歌的
// 播放状态与均衡器预设，再挂三块 DSP 会让它的每次更新都牵动一大片订阅。这里的更新
// 频率很高（拖 RT60 滑杆时每秒几十次），单独一条订阅线只通知真正在听的人。

import { create } from 'zustand';
import {
    areAudioConsoleSettingsEqual,
    normalizeAudioConsoleSettings,
    readStoredAudioConsoleSettings,
    writeStoredAudioConsoleSettings,
    type AudioConsoleCompressor,
    type AudioConsoleCompressorBand,
    type AudioConsoleCompressorBandId,
    type AudioConsoleFrontEq,
    type AudioConsolePostEq,
    type AudioConsoleReverb,
    type AudioConsoleSaturation,
    type AudioConsoleSettings,
    type AudioConsoleStereo,
    type AudioConsoleLimiter,
} from '../utils/audioConsole';

type AudioConsoleStore = {
    settings: AudioConsoleSettings;
    setReverb: (patch: Partial<AudioConsoleReverb>) => void;
    setCompressor: (patch: Partial<Pick<AudioConsoleCompressor, 'enabled' | 'bandCount' | 'profile' | 'crossovers'>>) => void;
    setCompressorBand: (id: AudioConsoleCompressorBandId, patch: Partial<AudioConsoleCompressorBand>) => void;
    setFrontEq: (patch: Partial<AudioConsoleFrontEq>) => void;
    setPostEq: (patch: Partial<AudioConsolePostEq>) => void;
    setStereo: (patch: Partial<AudioConsoleStereo>) => void;
    setSaturation: (patch: Partial<AudioConsoleSaturation>) => void;
    setLimiter: (patch: Partial<AudioConsoleLimiter>) => void;
    /** 后置十段全部归零（不动开关与曲线）。 */
    resetPostEqGains: () => void;
    /**
     * 整份换掉（切换耳机方案时用）。
     *
     * 与逐个 setter 的区别有两点：立即写盘，并且把排队中的那一次撤掉 —— 否则 250 ms 后
     * 队列里的旧设置会把刚换上的方案覆盖回去。
     */
    replaceSettings: (settings: AudioConsoleSettings) => void;
    reset: () => void;
};

const initial = readStoredAudioConsoleSettings();

/**
 * 写盘节流。
 *
 * 拖一根滑杆每秒会产生几十次设置更新，而 localStorage 是**同步**写：每帧写一次在手机上
 * 能拖出可感知的顿挫。这里合并到停手 250 ms 之后写一次 —— 掉电丢的也只是最后 250 ms 的微调。
 */
let writeTimer: ReturnType<typeof setTimeout> | null = null;

const scheduleWrite = (settings: AudioConsoleSettings): void => {
    if (writeTimer !== null) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
        writeTimer = null;
        writeStoredAudioConsoleSettings(settings);
    }, 250);
};

/**
 * 采纳一份新设置：一样就原样返回旧对象（zustand 不会通知订阅者），
 * 不一样就排一次写盘。
 */
const commit = (next: AudioConsoleSettings, previous: AudioConsoleSettings): AudioConsoleSettings => {
    if (areAudioConsoleSettingsEqual(next, previous)) return previous;
    scheduleWrite(next);
    return next;
};

export const useAudioConsoleStore = create<AudioConsoleStore>((set) => ({
    settings: initial,

    setReverb: (patch) => set(state => ({
        settings: commit(
            { ...state.settings, reverb: { ...state.settings.reverb, ...patch } },
            state.settings,
        ),
    })),

    setCompressor: (patch) => set(state => ({
        settings: commit(
            { ...state.settings, compressor: { ...state.settings.compressor, ...patch } },
            state.settings,
        ),
    })),

    setCompressorBand: (id, patch) => set(state => ({
        settings: commit(
            {
                ...state.settings,
                compressor: {
                    ...state.settings.compressor,
                    bands: {
                        ...state.settings.compressor.bands,
                        [id]: { ...state.settings.compressor.bands[id], ...patch },
                    },
                },
            },
            state.settings,
        ),
    })),

    setFrontEq: (patch) => set(state => ({
        settings: commit(
            { ...state.settings, frontEq: { ...state.settings.frontEq, ...patch } },
            state.settings,
        ),
    })),

    setPostEq: (patch) => set(state => ({
        settings: commit(
            { ...state.settings, postEq: { ...state.settings.postEq, ...patch } },
            state.settings,
        ),
    })),

    setStereo: (patch) => set(state => ({
        settings: commit(
            { ...state.settings, stereo: { ...state.settings.stereo, ...patch } },
            state.settings,
        ),
    })),

    setSaturation: (patch) => set(state => ({
        settings: commit(
            { ...state.settings, saturation: { ...state.settings.saturation, ...patch } },
            state.settings,
        ),
    })),

    setLimiter: (patch) => set(state => ({
        settings: commit(
            { ...state.settings, limiter: { ...state.settings.limiter, ...patch } },
            state.settings,
        ),
    })),

    resetPostEqGains: () => set(state => ({
        settings: commit(
            { ...state.settings, postEq: { ...state.settings.postEq, gains: new Array(10).fill(0) } },
            state.settings,
        ),
    })),

    replaceSettings: (settings) => {
        const next = normalizeAudioConsoleSettings(settings);
        if (writeTimer !== null) {
            clearTimeout(writeTimer);
            writeTimer = null;
        }
        writeStoredAudioConsoleSettings(next);
        set({ settings: next });
    },

    reset: () => {
        const next = normalizeAudioConsoleSettings(null);
        // 立刻写，并且把排队中的那一次撤掉：否则 250 ms 后它会把出厂值覆盖回旧设置。
        if (writeTimer !== null) {
            clearTimeout(writeTimer);
            writeTimer = null;
        }
        writeStoredAudioConsoleSettings(next);
        set({ settings: next });
    },
}));

/** 给非 React 的调用方（推送原生那条线）取当前值。 */
export const readAudioConsoleSettings = (): AudioConsoleSettings => useAudioConsoleStore.getState().settings;
