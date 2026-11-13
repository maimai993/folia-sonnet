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
import { cancelNativeSeparation } from './nativeModels';

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
    /** 原生实际分析了多长（秒）。超长的现场版会被解码器截断，截断之后后半首没有拍点。 */
    seconds?: number;
    /** 被中途取消：`beats` 只覆盖前一段，不能当整曲结果用。 */
    cancelled?: boolean;
};

type NativeBeatsPlugin = {
    analyzeBeats(options: { samples: string }): Promise<NativeBeatGrid>;
    /**
     * 同一套推理，音频由原生按地址自己取（Kotlin 侧的 analyzeBeatsFromUrl）。
     *
     * 整首歌的 PCM 走桥是过不去的：一首四分钟的歌 22050Hz 单声道是 21MB，
     * base64 之后 28MB，比 FoliaNativePlugin 的响应上限大一个数量级（#261/#262）。
     * 能给出路径或地址时一律走这条，`analyzeBeats` 只留给「PCM 已经在手里」的短片段。
     */
    analyzeBeatsFromUrl?(options: { url: string }): Promise<NativeBeatGrid>;
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

/**
 * 分析一首歌的节拍，**音频由原生按地址自己解码**（本地绝对路径或 http(s) 地址）。
 *
 * 与 `analyzeBeats` 的区别只在音频怎么过去：那条路把整首歌的 PCM 编成 base64 塞进
 * 调用参数，四分钟的歌就是 28MB，桥和堆都撑不住 —— 真机上表现是分析永远失败、
 * 智能动感一直没有拍点。这条路只传一个字符串，原生用 MediaExtractor 直接解码。
 */
export const analyzeBeatsNativeFromUrl = async (url: string, timeoutMs = 3 * 60 * 1000): Promise<NativeBeatGrid> => {
    if (!isNativeBeatAnalysisAvailable()) {
        throw new Error('原生节拍分析只支持安卓 App');
    }
    if (!url) throw new Error('缺少音频地址');
    const plugin = NativeBeats as NativeBeatsPlugin;
    if (typeof plugin.analyzeBeatsFromUrl !== 'function') {
        // 旧 APK 的插件没有这个方法：报错而不是退回 base64，后者在这里只会把进程拖死。
        throw new Error('当前安装包的原生插件不支持按地址分析节拍，请更新 APK');
    }
    /*
     * 等太久就放弃。
     *
     * 原生那边是单线程队列，一次卡住的分析会把后面的鼓点分离全堵在队列里；
     * 界面上看起来只是「智能动感一直没反应」。超时后请求取消，让队列能往前走。
     */
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
        const grid = await Promise.race([
            plugin.analyzeBeatsFromUrl({ url }),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    void cancelNativeSeparation();
                    reject(new Error(`原生节拍分析超过 ${Math.round(timeoutMs / 1000)} 秒没有结果`));
                }, timeoutMs);
            }),
        ]);
        if (grid.cancelled) {
            throw new Error('原生节拍分析被取消，结果不完整');
        }
        return grid;
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
};
