// src/services/playbackEngine/nativeSpectrumBridge.ts
//
// 把**原生播放**的频谱接进 `audioBands`。
//
// 为什么需要这一层：原生播放（mpv / ExoPlayer）的声音根本不经过 Web Audio，
// 所以 `AnalyserNode` 永远拿不到数据 —— 这也是 `usePlaybackVisualizerBridge`
// 里那句注释说的「原生那一路同理：声音不走 Web Audio，频谱没有数据」。
// 结果就是：用原生播放时，所有靠频谱驱动的背景都只剩一条正弦「呼吸」，
// 看得见但跟音乐完全无关。
//
// 但原生那边其实**早就算好了**：`EqAudioProcessor` 在 DSP 链路里拿得到 PCM，
// 它内部的 `SpectrumAnalyzer` 会做 2048 点 FFT、压成 32 段、
// 换算成 -90dB~0dB 的 0..1 取值，通过 `FoliaNativePlayer.setSpectrumEnabled`
// 与 `getSpectrum` 暴露出来。只是 JS 这一侧从来没有人来取。
//
// 这一层做的事就是「有人来取」：播放时按帧轮询原生频谱、写进 audioBands。
//
// ⚠️ 为什么是轮询而不是事件：原生音频线程按 128 帧一块回调，一秒要推几百次；
// 每次都跨桥会给 WebView 主线程压上几百次唤醒。取频谱的消费者是 rAF（≤120Hz），
// 按帧取一次正好，多的都是浪费。所以这里用 rAF 驱动，而不是让原生往回推。

import type { MotionValue } from 'framer-motion';
import type { AudioBands } from '../../types';
import { isNativePlayerAvailable, nativePlayer } from './nativePlayerPlugin';

/** 原生频谱的分段数。与 `SpectrumAnalyzer.SPECTRUM_BAND_COUNT` 必须一致。 */
export const NATIVE_SPECTRUM_BANDS = 32;

/**
 * 原生那 32 段对应的频率边界。
 *
 * `SpectrumAnalyzer` 是按对数分布的：从 ~40Hz 到 ~16kHz。
 * 这里按同样的对数刻度还原出每段覆盖的范围，用来把 32 段合成
 * Web Audio 那五个频带（bass/lowMid/mid/vocal/treble）——
 * 两边口径一致，切换播放路线时背景的观感才不会突然变一套。
 */
const BAND_EDGES = (() => {
    const minHz = 40;
    const maxHz = 16000;
    const edges: number[] = [];
    for (let i = 0; i <= NATIVE_SPECTRUM_BANDS; i += 1) {
        edges.push(minHz * Math.pow(maxHz / minHz, i / NATIVE_SPECTRUM_BANDS));
    }
    return edges;
})();

/** 把 32 段频谱里落在 [minHz, maxHz] 的部分求平均。 */
const energyIn = (bands: number[], minHz: number, maxHz: number): number => {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < NATIVE_SPECTRUM_BANDS; i += 1) {
        const lo = BAND_EDGES[i];
        const hi = BAND_EDGES[i + 1];
        // 段中心落在窗口里就算进来，避免边界处两段都被算一半、能量被稀释。
        const center = Math.sqrt(lo * hi);
        if (center >= minHz && center < maxHz) {
            sum += bands[i] ?? 0;
            count += 1;
        }
    }
    return count > 0 ? sum / count : 0;
};

/**
 * 原生频谱的 32 段是 0..1 的线性幅度。
 * Web Audio 那条路写进 audioBands 的是 0..255，消费者（含着色器）按 255 归一化，
 * 所以这里乘回去，保持两路口径一致。
 */
const TO_255 = 255;

type NativeSpectrumTarget = {
    /** 原生频谱总开关是否已打开（只开一次，不是每帧）。 */
    enabled: boolean;
    /** 上一次打开失败的时间，用于退避，避免每帧都跨桥重试。 */
    lastEnableAttempt: number;
    /** 有没有原生频谱可用；false 时调用方该退回自己的兜底。 */
    available: boolean;
    /** 是否已经有一发取样的请求在跨桥途中（防止每帧都发、把桥堆满）。 */
    inFlight: boolean;
    /** 手上是否有一份有效样本。 */
    haveData: boolean;
    /** 上一份有效样本到手的时间，用来判断数据是不是冻住了。 */
    lastSampleAt: number;
};

const state: NativeSpectrumTarget = {
    enabled: false,
    lastEnableAttempt: 0,
    available: true,
    inFlight: false,
    haveData: false,
    lastSampleAt: 0,
};

/** 打开/关闭原生频谱采集。播放页挂载时开、卸载时关。 */
export const setNativeSpectrumEnabled = async (enabled: boolean): Promise<void> => {
    if (!isNativePlayerAvailable()) {
        state.available = false;
        return;
    }
    try {
        await nativePlayer.setSpectrumEnabled(enabled);
        state.enabled = enabled;
        state.available = true;
    } catch (error) {
        // 老版本原生没有这个方法：标记不可用，调用方安静地走兜底。
        state.available = false;
        state.enabled = false;
        console.warn('[NativeSpectrum] 打开失败，退回呼吸兜底：', error);
    }
};

/**
 * 非阻塞地取一帧原生频谱，并写进 audioBands / audioPower。
 *
 * ★ 这个函数**不返回 Promise**，因为调用方是 rAF 回调（同步的）。
 * 跨桥往返要几毫秒，等它会把每帧都拖到下一次微任务上 —— 播放页抽搐就是这么来的。
 *
 * 做法是「发射后不管 + 结果写到共享值」：
 *   - 上一帧发起的取样还没回来，这一帧就跳过（原生音频线程本来就只推 ~47 次/秒，
 *     比 rAF 慢，每帧都发只会堆请求）；
 *   - 回来时把结果写进 audioBands，下一帧的消费者自然读到。
 *
 * 返回 true 表示「有原生频谱在供给」，调用方不要写兜底值；
 * 返回 false 表示这条路不通（没开、老版本原生、或还没样本），交给兜底。
 */
export const pollNativeSpectrum = (audioBands: AudioBands, audioPower: MotionValue<number>): boolean => {
    if (!state.available) return false;
    if (!isNativePlayerAvailable()) {
        state.available = false;
        return false;
    }

    const now = Date.now();

    // 总开关：打开失败就退避 5 秒再试，不要每帧跨桥。
    if (!state.enabled) {
        if (now - state.lastEnableAttempt < 5000) return false;
        state.lastEnableAttempt = now;
        void setNativeSpectrumEnabled(true);
        return false;
    }

    // 已经有一发在路上了：这一帧先用上一份结果。
    if (!state.inFlight) {
        state.inFlight = true;
        void nativePlayer
            .getSpectrum()
            .then(frame => {
                state.inFlight = false;
                const bands = frame?.bands;
                if (!Array.isArray(bands) || bands.length === 0) {
                    // 开关开着但还没有样本：DSP 还在等第一块 PCM，或者暂停了。
                    // 这时候**不要**写 0 —— 写了会把画面按灭一下。
                    state.haveData = false;
                    return;
                }
                applyBands(bands, audioBands, audioPower);
                state.haveData = true;
                state.lastSampleAt = Date.now();
            })
            .catch(error => {
                state.inFlight = false;
                state.available = false;
                state.haveData = false;
                console.warn('[NativeSpectrum] 取样失败，退回呼吸兜底：', error);
            });
    }

    /*
     * 数据新鲜度：超过 1.5 秒没更新就认为停了（暂停、切歌、DSP 掉链）。
     * 这时交回兜底，而不是让画面定格在一个冻住的频谱上。
     */
    return state.haveData && now - state.lastSampleAt < 1500;
};

/** 把原生 32 段换算成五个频带 + 原始频谱，写进 audioBands。 */
const applyBands = (bands: number[], audioBands: AudioBands, audioPower: MotionValue<number>): void => {
    /*
     * 与 Web Audio 那条路的处理保持一致（见 usePlaybackVisualizerBridge）：
     * 分频带取值 → 按各自的指数提亮 → 写进 audioBands。
     */
    const process = (value: number, boost: number) =>
        Math.pow(Math.max(0, Math.min(1, value)), boost) * TO_255;

    const bass = energyIn(bands, 20, 150);
    const lowMid = energyIn(bands, 150, 400);
    const mid = energyIn(bands, 400, 1200);
    const vocal = energyIn(bands, 1000, 3500);
    const treble = energyIn(bands, 3500, 12000);

    audioPower.set(process((bass + lowMid) / 2, 3));
    audioBands.bass.set(process(bass, 1.8));
    audioBands.lowMid.set(process(lowMid, 2));
    audioBands.mid.set(process(mid, 2));
    audioBands.vocal.set(process(vocal, 1.5));
    audioBands.treble.set(process(treble, 2));

    /*
     * 原始频谱也给出去：背景可以拿它做「整条曲线」的效果，而不只是五个频带。
     * 统一成 0..255 的 Uint8Array，和 AnalyserNode 的 getByteFrequencyData 一致，
     * 消费者不用分两路。
     */
    const spectrum = new Uint8Array(NATIVE_SPECTRUM_BANDS);
    for (let i = 0; i < NATIVE_SPECTRUM_BANDS; i += 1) {
        spectrum[i] = Math.round(Math.max(0, Math.min(1, bands[i] ?? 0)) * TO_255);
    }
    audioBands.spectrum?.set(spectrum);
};

/** 播放页卸载时调用：关掉原生采集，别让 FFT 在没人看的时候继续烧音频线程。 */
export const releaseNativeSpectrum = (): void => {
    if (!state.enabled) return;
    state.enabled = false;
    void setNativeSpectrumEnabled(false);
};
