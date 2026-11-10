// src/services/automix/nativeModels.ts
//
// Automix 两个分析模型在 Android 上的接入层。
//
// 与上游（RemnantCloudGodofWar/folia-android）的差别：那边的权重是可下载资源，
// 状态全部来自 Electron 主进程（window.electron.getAutomixModelsPresent）。
// 这个分支把它们**内置进 APK**（assets/models/，约 182MB），所以：
//   · 没有网络下载、没有镜像、没有网盘、没有「扫描本机已有文件」；
//   · 「安装」= 把 assets 里那份拷到应用私有目录（ONNX Runtime 要真实文件路径）；
//   · 状态只有两种：就绪 / 未就绪，未就绪时点一下几秒内就好。
//
// 对外仍然是「每个模型能不能跑」这一个布尔值，形状与上游的
// modelAvailability 一致，所以调用点不需要区分平台。

import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { isCapacitorAndroid } from '../../platform/runtime';

/** 两个模型的标识，与 Kotlin 侧的常量一致。 */
export type AutomixModelName = 'beat_this' | 'htdemucs';

export type AutomixModelInfo = {
    name: AutomixModelName;
    supported: boolean;
    /** 权重字节数。 */
    bytes: number;
    /** 是否已经就绪（可直接推理）。 */
    ready: boolean;
    /** 就绪时的绝对路径。 */
    path: string | null;
};

export type AutomixModelsStatus = {
    models: AutomixModelInfo[];
    /** 私有目录，模型落地的地方。 */
    dir: string | null;
    /** 权重是否随包内置。这个构建恒为 true。 */
    bundled: boolean;
};

export type AutomixModelProgress = {
    name: AutomixModelName;
    status: 'downloading' | 'done' | 'failed';
    received?: number;
    total?: number;
    host?: string;
};

type NativeStemResult = {
    samples: number;
    sampleRate: number;
    stems: Record<string, { left: string; right: string }>;
};

type NativeAutomixPlugin = {
    getStatus(): Promise<AutomixModelsStatus>;
    download(options: { name: string }): Promise<{ ok: boolean; path?: string }>;
    remove(options: { name: string }): Promise<{ ok: boolean }>;
    verify(options: { name: string }): Promise<{ ok: boolean; expected: string; actual: string }>;
    separateStems(options: { left: string; right: string }): Promise<NativeStemResult>;
    addListener(
        eventName: 'modelProgress',
        listener: (event: AutomixModelProgress) => void,
    ): Promise<PluginListenerHandle>;
};

const NativeAutomix = registerPlugin<NativeAutomixPlugin>('FoliaAutomixModels');

/** 这个运行环境有没有原生模型能力（目前只有安卓 App 有）。 */
export const isNativeModelsAvailable = (): boolean => isCapacitorAndroid();

/*
 * 一个同步可读的「哪些模型能跑」快照。
 *
 * 与上游同样的理由：引擎徽标、表现模式开关、以及各个能力判断都要在渲染时同步问一句
 * 「这个模型现在能不能用」。做成 async 的话每处调用点都要变成状态，非常啰嗦。
 * 所以这里维持一份缓存，任何可能改变它的事情（安装完成、删除、App 启动）之后刷新。
 */
let present: Record<AutomixModelName, boolean> = { beat_this: false, htdemucs: false };
let readyDir: string | null = null;

const listeners = new Set<() => void>();

/** useSyncExternalStore 形状的订阅。 */
export const subscribeModelAvailability = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

/** 当前快照。只在值真的变了时换对象，才能直接给 useSyncExternalStore 用。 */
export const modelsPresent = (): Record<AutomixModelName, boolean> => present;

/** 这个模型现在能不能跑 —— 权重在不在私有目录就是全部的问题。 */
export const modelCanRun = (name: AutomixModelName): boolean => present[name];

/** 模型落地的目录（给设置页显示）。 */
export const modelsDirectory = (): string | null => readyDir;

const publish = (next: Record<AutomixModelName, boolean>): void => {
    if (next.beat_this === present.beat_this && next.htdemucs === present.htdemucs) return;
    present = next;
    for (const listener of listeners) listener();
};

/**
 * 重新问一次原生侧。
 *
 * 任何时刻调用都安全；失败时保留上一次的答案，而不是把一个能用的构建降级
 * （上游 modelAvailability 里解释过同样的取舍：一次坏掉的往返不该让功能消失）。
 */
export const refreshModelAvailability = async (): Promise<Record<AutomixModelName, boolean>> => {
    if (!isNativeModelsAvailable()) return present;
    try {
        const status = await NativeAutomix.getStatus();
        readyDir = status.dir ?? null;
        const next: Record<AutomixModelName, boolean> = { beat_this: false, htdemucs: false };
        for (const model of status.models ?? []) {
            if (model.name === 'beat_this') next.beat_this = model.ready === true;
            if (model.name === 'htdemucs') next.htdemucs = model.ready === true;
        }
        publish(next);
    } catch (error) {
        console.warn('[Automix] 读取模型状态失败', error);
    }
    return present;
};

/** 完整状态（设置页用，含字节数与路径）。 */
export const fetchModelsStatus = async (): Promise<AutomixModelsStatus | null> => {
    if (!isNativeModelsAvailable()) return null;
    try {
        return await NativeAutomix.getStatus();
    } catch (error) {
        console.warn('[Automix] 读取模型详情失败', error);
        return null;
    }
};

/**
 * 让某个模型可用。内置的权重，这里是「从 assets 拷到私有目录」。
 *
 * 返回 false 表示失败（空间不足、assets 缺失等），调用方应当把错误显示出来
 * 而不是假装安装成功 —— 一个永远停在「安装中」的界面比报错更难查。
 */
export const installModel = async (name: AutomixModelName): Promise<boolean> => {
    if (!isNativeModelsAvailable()) return false;
    try {
        const result = await NativeAutomix.download({ name });
        await refreshModelAvailability();
        return result.ok === true;
    } catch (error) {
        console.warn(`[Automix] 安装 ${name} 失败`, error);
        return false;
    }
};

/** 删掉私有目录里的副本，腾出空间。下次用到会重新落盘。 */
export const removeModel = async (name: AutomixModelName): Promise<boolean> => {
    if (!isNativeModelsAvailable()) return false;
    try {
        const result = await NativeAutomix.remove({ name });
        await refreshModelAvailability();
        return result.ok === true;
    } catch (error) {
        console.warn(`[Automix] 删除 ${name} 失败`, error);
        return false;
    }
};

/** 订阅安装进度。返回取消订阅的函数。 */
export const onModelProgress = (
    listener: (event: AutomixModelProgress) => void,
): (() => void) => {
    if (!isNativeModelsAvailable()) return () => {};
    let handle: PluginListenerHandle | null = null;
    let cancelled = false;
    void NativeAutomix.addListener('modelProgress', listener).then((added) => {
        if (cancelled) void added.remove();
        else handle = added;
    });
    return () => {
        cancelled = true;
        void handle?.remove();
    };
};

/** 一个 0..100 的百分比，给进度条用。 */
export const progressPercent = (event: AutomixModelProgress | null): number => {
    if (!event || !event.total || event.total <= 0) return 0;
    return Math.max(0, Math.min(100, ((event.received ?? 0) / event.total) * 100));
};

/*
 * 原生 htdemucs 分离：把我们这边的立体声片段交给 Kotlin，拿回四条轨。
 *
 * 为什么走 base64 而不是别的：Capacitor 的桥接通道只认 JSON。
 * 一段 172032 采样 × 2 声道 × 4 字节 ≈ 1.4 MB，编码成 base64 约 1.9 MB 字符串，
 * 这个量级过桥没问题（整首歌一次性传会炸，所以调用方必须**按段**喂，见 stemRange.ts）。
 */

/** 把一段 Float32 立体声编成 base64（分块，避免 apply 的参数上限）。 */
const encodeChunk = (samples: Float32Array): string => {
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    let binary = '';
    const step = 0x8000;
    for (let at = 0; at < bytes.length; at += step) {
        binary += String.fromCharCode(...bytes.subarray(at, at + step));
    }
    return btoa(binary);
};

/** base64 解回 Float32。 */
const decodeChunk = (encoded: string): Float32Array => {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Float32Array(bytes.buffer, 0, bytes.length / 4);
};

export type NativeStems = {
    drums: { left: Float32Array; right: Float32Array };
    bass: { left: Float32Array; right: Float32Array };
    other: { left: Float32Array; right: Float32Array };
    vocals: { left: Float32Array; right: Float32Array };
};

/**
 * 原生分离一首歌，**音频由原生按地址自己取**。
 *
 * ★ 这是安卓上唯一可行的整曲分离路径。
 *
 * 上面那个 separateStemsNative 要把整首歌的 PCM 以 base64 过桥。一首 4 分钟
 * 44.1kHz 立体声的歌约 42M 样本，base64 之后近 60MB —— 桥的响应上限是 8MiB
 * （见 FoliaNativePlugin.DEFAULT_MAX_RESPONSE_BYTES），直接拒；就算放宽，
 * byte[] → base64 → 整份 JSON 的序列化会把内存放大到撞穿堆。
 *
 * 所以整曲一律走这条：给一个路径或地址，原生自己拉流、解码、推理，
 * 只把结果（四轨，仍然是 base64）交回来。结果比输入小得多，能过桥。
 *
 * @param url 本地绝对路径，或 http(s) 地址。
 */
export const separateStemsNativeFromUrl = async (url: string): Promise<NativeStems | null> => {
    if (!isNativeModelsAvailable() || !present.htdemucs) return null;
    if (!url) return null;
    try {
        const plugin = NativeAutomix as unknown as {
            separateStemsFromUrl(options: { url: string }): Promise<{
                stems?: Record<string, { left: string; right: string }>;
            }>;
        };
        if (typeof plugin.separateStemsFromUrl !== 'function') return null;
        const result = await plugin.separateStemsFromUrl({ url });
        const pick = (name: string) => {
            const stem = result.stems?.[name];
            if (!stem) return { left: new Float32Array(0), right: new Float32Array(0) };
            return { left: decodeChunk(stem.left), right: decodeChunk(stem.right) };
        };
        return {
            drums: pick('drums'),
            bass: pick('bass'),
            other: pick('other'),
            vocals: pick('vocals'),
        };
    } catch (error) {
        console.warn('[AutomixModels] native separation from URL failed', error);
        return null;
    }
};

/**
 * 原生分离一段立体声。
 *
 * `left`/`right` 长度必须一致；返回的四轨与输入等长。
 * 原生不可用时返回 null（调用方应回退到它原本的路径）。
 */
export const separateStemsNative = async (
    left: Float32Array,
    right: Float32Array,
): Promise<NativeStems | null> => {
    if (!isNativeModelsAvailable() || !present.htdemucs) return null;
    if (left.length !== right.length || left.length === 0) return null;
    try {
        const result = await NativeAutomix.separateStems({
            left: encodeChunk(left),
            right: encodeChunk(right),
        });
        const pick = (name: string) => {
            const stem = result.stems?.[name];
            if (!stem) return { left: new Float32Array(0), right: new Float32Array(0) };
            return { left: decodeChunk(stem.left), right: decodeChunk(stem.right) };
        };
        return {
            drums: pick('drums'),
            bass: pick('bass'),
            other: pick('other'),
            vocals: pick('vocals'),
        };
    } catch (error) {
        console.warn('[AutomixModels] native separation failed', error);
        return null;
    }
};
