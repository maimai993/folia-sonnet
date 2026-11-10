// src/services/automix/nativeBeats.ts
//
// 原生节拍分析（beat_this）的 JS 入口。
//
// 分工刻意划在这里：
//   · JS 负责「拿到 22050Hz 单声道 PCM」—— WebView 里已经有 decodeAudioData，
//     重采样是一次 OfflineAudioContext 的事，用原生重写没有好处；
//   · 原生负责 mel 频谱 + ONNX 推理 + 取峰 —— 那一段是纯计算，放在主线程会冻住界面。
//
// 这个模块不依赖 window.electron，与上游 Electron 版的差别就在这一层。

import { registerPlugin } from '@capacitor/core';
import { isCapacitorAndroid } from '../../platform/runtime';

/** 与 Kotlin 侧 BeatThisRunner.SAMPLE_RATE 一致。 */
export const BEAT_THIS_SAMPLE_RATE = 22050;

/** 一个拍点。 */
export type NativeBeat = {
    /** 秒。 */
    time: number;
    /** 是否小节头。 */
    downbeat: boolean;
    /** 0..1，模型对这一拍的把握。 */
    confidence: number;
};

export type NativeBeatGrid = {
    beats: NativeBeat[];
    /** 每帧多少秒（1/50）。 */
    fps: number;
    /** 总帧数。 */
    frames: number;
};

type NativeBeatsPlugin = {
    analyzeBeats(options: { samples: string }): Promise<NativeBeatGrid>;
};

const NativeBeats = registerPlugin<NativeBeatsPlugin>('FoliaAutomixModels');

export const isNativeBeatAnalysisAvailable = (): boolean => isCapacitorAndroid();

/**
 * 把任意采样率的 PCM 降到 22050Hz 单声道。
 *
 * 用 OfflineAudioContext 而不是自己写线性插值：浏览器/WebView 里那条路是经过重采样的
 * 高质量实现（带抗混叠滤波），而线性插值在 44100→22050 这种简单比例上虽然不错，
 * 48k→22050 这类非整数比就会明显失真 —— 而失真的高频会直接让节拍检测变差。
 *
 * 已经就是 22050 时原样返回，省一次无谓的变换。
 */
export const resampleToBeatThisRate = async (audio: AudioBuffer): Promise<Float32Array> => {
    const mono = (() => {
        if (audio.numberOfChannels === 1) return audio.getChannelData(0);
        // 多声道取平均：节拍分析只关心整体的打击感，取平均比取任意一个声道都稳。
        const left = audio.getChannelData(0);
        const right = audio.getChannelData(Math.min(1, audio.numberOfChannels - 1));
        const mixed = new Float32Array(audio.length);
        for (let index = 0; index < audio.length; index += 1) {
            mixed[index] = (left[index] + right[index]) / 2;
        }
        return mixed;
    })();

    if (audio.sampleRate === BEAT_THIS_SAMPLE_RATE) return mono;

    const targetLength = Math.max(1, Math.ceil(audio.length * BEAT_THIS_SAMPLE_RATE / audio.sampleRate));
    const Offline = window.OfflineAudioContext ?? (window as unknown as {
        webkitOfflineAudioContext?: typeof OfflineAudioContext;
    }).webkitOfflineAudioContext;
    if (!Offline) {
        /*
         * 没有 OfflineAudioContext 时的退路：线性插值。
         *
         * 会失真一点，但总比直接放弃分析好 —— 而且这条分支在现代 WebView 里走不到。
         */
        const out = new Float32Array(targetLength);
        const ratio = audio.sampleRate / BEAT_THIS_SAMPLE_RATE;
        for (let index = 0; index < targetLength; index += 1) {
            const at = index * ratio;
            const low = Math.floor(at);
            const high = Math.min(mono.length - 1, low + 1);
            const frac = at - low;
            out[index] = mono[low] * (1 - frac) + mono[high] * frac;
        }
        return out;
    }

    const context = new Offline(1, targetLength, BEAT_THIS_SAMPLE_RATE);
    const buffer = context.createBuffer(1, mono.length, audio.sampleRate);
    buffer.copyToChannel(mono, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start();
    const rendered = await context.startRendering();
    return rendered.getChannelData(0);
};

/** Float32Array → base64。分块处理，避免大数组一次性展开把栈打爆。 */
const toBase64 = (samples: Float32Array): string => {
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    let binary = '';
    const chunk = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunk) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
    }
    return btoa(binary);
};

/**
 * 分析一段音频的节拍。
 *
 * 失败时抛错而不是返回空网格：一个空的节拍网格会让上层静默回落到估算器，
 * 而「分析过了但结果为空」和「根本没分析」对排查是两件完全不同的事。
 */
export const analyzeBeatsNative = async (samples: Float32Array): Promise<NativeBeatGrid> => {
    if (!isNativeBeatAnalysisAvailable()) {
        throw new Error('原生节拍分析只支持安卓 App');
    }
    if (samples.length < BEAT_THIS_SAMPLE_RATE) {
        // 不到一秒的音频没有节拍可言，直接给空结果，省一次模型冷启动。
        return { beats: [], fps: BEAT_THIS_SAMPLE_RATE / 441, frames: 0 };
    }
    return NativeBeats.analyzeBeats({ samples: toBase64(samples) });
};
