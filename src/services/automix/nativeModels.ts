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
import { isAndroidAppShell } from '../../platform/runtime';

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
    status: 'downloading' | 'done' | 'failed' | 'analyzing';
    received?: number;
    total?: number;
    host?: string;
    /** 分离进行到多少（status 为 analyzing 时）。 */
    percent?: number;
};

type NativeStemResult = {
    samples: number;
    sampleRate: number;
    stems: Record<string, { left: string; right: string }>;
    /** 这一段在整首歌里的起点（样本）；取消时 `samples` 只是算完的那一截。 */
    fromSample?: number;
    cancelled?: boolean;
};

type NativeAutomixPlugin = {
    getStatus(): Promise<AutomixModelsStatus>;
    download(options: { name: string }): Promise<{ ok: boolean; path?: string }>;
    remove(options: { name: string }): Promise<{ ok: boolean }>;
    verify(options: { name: string }): Promise<{ ok: boolean; expected: string; actual: string }>;
    separateStems(options: { left: string; right: string; stems?: string }): Promise<NativeStemResult>;
    separateStemsFromUrl(options: {
        url: string;
        stems?: string;
        startSeconds?: number;
        seconds?: number;
    }): Promise<NativeStemResult>;
    cancelAutomix(): Promise<{ ok: boolean }>;
    addListener(
        eventName: 'modelProgress',
        listener: (event: AutomixModelProgress) => void,
    ): Promise<PluginListenerHandle>;
};

const NativeAutomix = registerPlugin<NativeAutomixPlugin>('FoliaAutomixModels');

/**
 * 这个运行环境有没有原生模型能力（目前只有安卓 App 有）。
 *
 * 用 isAndroidAppShell 而不是 isCapacitorAndroid：后者要等 Capacitor 的桥起来
 * 才有值，而首帧那一刻的「有没有模型」会被界面读到（智能动感的特效行、
 * 分轨开关都要在渲染时同步问一句）。用后者答错的方向是「整个功能消失」。
 */
export const isNativeModelsAvailable = (): boolean => isAndroidAppShell();

/*
 * 一个同步可读的「哪些模型能跑」快照。
 *
 * 与上游同样的理由：引擎徽标、表现模式开关、以及各个能力判断都要在渲染时同步问一句
 * 「这个模型现在能不能用」。做成 async 的话每处调用点都要变成状态，非常啰嗦。
 * 所以这里维持一份缓存，任何可能改变它的事情（安装完成、删除、App 启动）之后刷新。
 */
let present: Record<AutomixModelName, boolean> = { beat_this: false, htdemucs: false };
let readyDir: string | null = null;
/*
 * 权重是否随包内置（原生 getStatus 的 `bundled`）。
 *
 * 「还没落盘」和「这个包里根本没有」是两件事：前者第一次用到时拷过来就好，
 * 后者怎么点都没用。界面上的「缺少模型」只在后者出现，所以要把这个值记下来。
 */
let bundled = isNativeModelsAvailable();

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

/**
 * 这个模型最终能不能跑：已经落盘，或者权重就在包里、第一次用到时拷得出来。
 *
 * 与 `modelCanRun` 分开：那个是同步的「此刻」，这个给界面判断要不要显示
 * 「本次安装缺少模型」—— 安卓内置权重的构建里，首次启动时它仍然是 true。
 */
export const modelWillBeAvailable = (name: AutomixModelName): boolean => (
    present[name] || (bundled && isNativeModelsAvailable())
);

/** 模型落地的目录（给设置页显示）。 */
export const modelsDirectory = (): string | null => readyDir;

const publish = (next: Record<AutomixModelName, boolean>, nextBundled = bundled): void => {
    const sameModels = next.beat_this === present.beat_this && next.htdemucs === present.htdemucs;
    // `bundled` 也是快照的一部分（modelWillBeAvailable 读它）：只按 present 判「没变」，
    // 首次启动就会漏掉一次通知，界面停在「缺少模型」上，直到别的什么事再触发一次刷新。
    if (sameModels && nextBundled === bundled) return;
    bundled = nextBundled;
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
        const nextBundled = status.bundled === true;
        const next: Record<AutomixModelName, boolean> = { beat_this: false, htdemucs: false };
        for (const model of status.models ?? []) {
            if (model.name === 'beat_this') next.beat_this = model.ready === true;
            if (model.name === 'htdemucs') next.htdemucs = model.ready === true;
        }
        publish(next, nextBundled);
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
 * 一次安装只跑一次。
 *
 * 一条拍点分析、一个分轨段、两处界面可能在同一刻各自发现「模型还没就绪」，
 * 各自发一次 download —— 原生侧是单线程队列，后两次会把同一份 100MB 再拷一遍，
 * 用户等三倍的时间。同一个模型共用同一个 Promise。
 */
const installing = new Map<AutomixModelName, Promise<boolean>>();

/**
 * 让某个模型可用。内置的权重，这里是「从 assets 拷到私有目录」。
 *
 * 返回 false 表示失败（空间不足、assets 缺失等），调用方应当把错误显示出来
 * 而不是假装安装成功 —— 一个永远停在「安装中」的界面比报错更难查。
 */
export const installModel = async (name: AutomixModelName): Promise<boolean> => {
    if (!isNativeModelsAvailable()) return false;
    if (present[name]) return true;
    const running = installing.get(name);
    if (running) return running;
    const run = (async () => {
        try {
            const result = await NativeAutomix.download({ name });
            await refreshModelAvailability();
            return result.ok === true;
        } catch (error) {
            console.warn(`[Automix] 安装 ${name} 失败`, error);
            return false;
        } finally {
            installing.delete(name);
        }
    })();
    installing.set(name, run);
    return run;
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

/** 一块四轨包络：缺哪条给空曲线，四条全空算没有。 */
const decodeStemEnvelopes = (
    raw: { fps?: number; bass?: string; vocals?: string; other?: string; energy?: string } | undefined,
): NativeStemEnvelopes | null => {
    if (!raw) return null;
    const read = (value: string | undefined): Float32Array => (typeof value === 'string' && value ? decodeChunk(value) : new Float32Array(0));
    const bass = read(raw.bass);
    const vocals = read(raw.vocals);
    const other = read(raw.other);
    const energy = read(raw.energy);
    if (!bass.length && !vocals.length && !other.length && !energy.length) return null;
    return { fps: Number(raw.fps) || 20, bass, vocals, other, energy };
};

export type NativeStems = {
    drums: { left: Float32Array; right: Float32Array };
    bass: { left: Float32Array; right: Float32Array };
    other: { left: Float32Array; right: Float32Array };
    vocals: { left: Float32Array; right: Float32Array };
};

export type NativeStemName = keyof NativeStems;

/**
 * 一次分离请求的可选参数。
 *
 * `stems` 不是优化而是**正确性**：四轨立体声过桥时，一段 3.9 秒就是 11MB 的 float，
 * base64 之后 15MB，再拼成 JSON —— 手机上一次分配这么多，运气不好就是 OOM。
 * 只要鼓点就传 `['drums']`，数据量降到四分之一。
 */
export type NativeStemOptions = {
    /** 只要这几个轨；不给就是四个都要。 */
    stems?: NativeStemName[];
    /** 从第几秒开始（整曲路径用）。 */
    startSeconds?: number;
    /** 分离多长（秒）。 */
    seconds?: number;
    /** abort 时让原生在下一个窗口边界停下，并丢弃这次结果。 */
    signal?: AbortSignal;
    /** 超时（毫秒）。默认 5 分钟：再久基本是卡住了。 */
    timeoutMs?: number;
};

/** 默认超时：手机上四分钟的整曲分离已经很慢，再久基本是挂了。 */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** 让正在跑的推理停下；没有在跑也安全。 */
export const cancelNativeSeparation = async (): Promise<void> => {
    if (!isNativeModelsAvailable()) return;
    try {
        await NativeAutomix.cancelAutomix();
    } catch (error) {
        console.warn('[AutomixModels] cancel failed', error);
    }
};

/**
 * 等 `run` 结束，但最多 `timeoutMs`；超时或 `signal` abort 时让原生停下并返回 null。
 *
 * 原生那头是单线程队列：一次卡住的分离会把后面的节拍分析全堵在队列里，
 * 而界面上看起来只是「智能动感一直没反应」。所以调用方这一侧必须有出口。
 */
const withDeadline = async <T>(
    run: Promise<T>,
    options: NativeStemOptions,
    onAbort: () => void,
): Promise<T | null> => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onSignal: (() => void) | null = null;
    try {
        const deadline = new Promise<null>((resolve) => {
            timer = setTimeout(() => {
                console.warn('[AutomixModels] native separation timed out, asking it to stop');
                onAbort();
                resolve(null);
            }, timeoutMs);
        });
        const aborted = options.signal
            ? new Promise<null>((resolve) => {
                onSignal = () => {
                    onAbort();
                    resolve(null);
                };
                if (options.signal!.aborted) onSignal();
                else options.signal!.addEventListener('abort', onSignal, { once: true });
            })
            : null;
        const result = aborted ? await Promise.race([run, deadline, aborted]) : await Promise.race([run, deadline]);
        return result;
    } finally {
        if (timer !== null) clearTimeout(timer);
        if (onSignal) options.signal?.removeEventListener('abort', onSignal);
    }
};

/** 把原生回来的四（或更少）轨解成波形；没请求的轨给空数组。 */
const readStems = (result: NativeStemResult): NativeStems => {
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
};

/**
 * 原生分离一首歌，**音频由原生按地址自己取**。
 *
 * ★ 这是安卓上唯一可行的整曲分离路径。
 *
 * 上面那个 separateStemsNative 要把整首歌的 PCM 以 base64 过桥。一首 4 分钟
 * 44.1kHz 立体声的歌约 42M 样本，base64 之后近 60MB —— 桥扛不住，
 * byte[] → base64 → 整份 JSON 的序列化也会把内存放大到撞穿堆。
 *
 * 所以整曲一律走这条：给一个路径或地址，原生自己拉流、解码、推理，
 * 只把结果（请求的那几轨，仍是 base64）交回来。
 *
 * @param url 本地绝对路径，或 http(s) 地址。
 */
export const separateStemsNativeFromUrl = async (
    url: string,
    options: NativeStemOptions = {},
): Promise<NativeStems | null> => {
    if (!isNativeModelsAvailable()) return null;
    if (!url) return null;
    // 首次用到才把权重从 assets 拷出来：界面上的开关不等这一次拷贝。
    if (!present.htdemucs && !(await installModel('htdemucs'))) return null;
    try {
        const plugin = NativeAutomix as unknown as {
            separateStemsFromUrl?: (options: {
                url: string;
                stems?: string;
                startSeconds?: number;
                seconds?: number;
            }) => Promise<NativeStemResult>;
        };
        if (typeof plugin.separateStemsFromUrl !== 'function') return null;
        const run = plugin.separateStemsFromUrl({
            url,
            ...(options.stems?.length ? { stems: options.stems.join(',') } : {}),
            ...(options.startSeconds !== undefined ? { startSeconds: options.startSeconds } : {}),
            ...(options.seconds !== undefined ? { seconds: options.seconds } : {}),
        });
        const result = await withDeadline(run, options, () => { void cancelNativeSeparation(); });
        return result ? readStems(result) : null;
    } catch (error) {
        console.warn('[AutomixModels] native separation from URL failed', error);
        return null;
    }
};

/**
 * 原生分离一段立体声。
 *
 * `left`/`right` 长度必须一致；返回的四轨与输入等长（没请求的轨是空数组）。
 * 原生不可用时返回 null（调用方应回退到它原本的路径）。
 */
export const separateStemsNative = async (
    left: Float32Array,
    right: Float32Array,
    options: NativeStemOptions = {},
): Promise<NativeStems | null> => {
    if (!isNativeModelsAvailable()) return null;
    if (left.length !== right.length || left.length === 0) return null;
    // 首次用到才落盘（约 108MB）；已经就绪就不重复问。
    if (!present.htdemucs && !(await installModel('htdemucs'))) return null;
    try {
        const run = NativeAutomix.separateStems({
            left: encodeChunk(left),
            right: encodeChunk(right),
            ...(options.stems?.length ? { stems: options.stems.join(',') } : {}),
        });
        const result = await withDeadline(run, options, () => { void cancelNativeSeparation(); });
        return result ? readStems(result) : null;
    } catch (error) {
        console.warn('[AutomixModels] native separation failed', error);
        return null;
    }
};

/** 原生算出的三条鼓点频带（kick / snare / hats），以及它们的帧率。 */
export type NativeDrumBands = {
    bands: [Float32Array, Float32Array, Float32Array];
    frames: number;
    fps: number;
    /** 实际解码到的长度；解码器对超长的现场版会截断。 */
    seconds: number;
};

/**
 * 用原生解码 + mel 取一首歌的**混音**鼓点频带。
 *
 * 为什么要有这条路（两台上真机的结论，不是猜的）：
 *   · htdemucs 在手机上一段 3.9 秒要 4~8 秒，比播放慢，`until` 永远追不上播放头；
 *   · 退到 WebView 里 `decodeAudioData` 整曲再逐块算 mel，四分钟的歌要几秒到几十秒，
 *     这段时间仿真鼓面只能停着（界面上就是「正在从混音里读鼓点…」一动不动）。
 * 原生 MediaCodec 解码 + Kotlin 的 mel 一两秒就能出整曲，过桥的只有三条频带
 * （四分钟约 150KB，桌面那条 htdemucs 结果也是这么回来的）。挑点仍在 Web 侧
 * （`pickBandHits`），起音判据只有一份。
 *
 * @param url 本地绝对路径，或 http(s) 地址（媒体缓存的回环地址也算本地）。
 */
export const analyzeDrumBandsNativeFromUrl = async (url: string): Promise<NativeDrumBands | null> => {
    if (!isNativeModelsAvailable()) return null;
    if (!url) return null;
    const plugin = NativeAutomix as unknown as {
        analyzeDrumBandsFromUrl?: (options: { url: string }) => Promise<{
            bands?: string[];
            frames?: number;
            fps?: number;
            seconds?: number;
        }>;
    };
    // 旧 APK 的插件没有这个方法：返回 null 让调用方走 WebView 解码那条（慢但不至于不能用）。
    if (typeof plugin.analyzeDrumBandsFromUrl !== 'function') return null;
    try {
        const result = await plugin.analyzeDrumBandsFromUrl({ url });
        const encoded = result.bands ?? [];
        if (encoded.length < 3) return null;
        const bands: [Float32Array, Float32Array, Float32Array] = [
            decodeChunk(encoded[0]),
            decodeChunk(encoded[1]),
            decodeChunk(encoded[2]),
        ];
        const frames = result.frames ?? bands[0].length;
        if (frames <= 0) return null;
        return { bands, frames, fps: result.fps ?? 50, seconds: result.seconds ?? 0 };
    } catch (error) {
        console.warn('[AutomixModels] native drum bands failed', error);
        return null;
    }
};


/** 原生鼓轨分离回传的一块：三条频带，覆盖 [fromSec, untilSec) 这一段。 */
export type NativeDrumStemBlock = {
    bands: [Float32Array, Float32Array, Float32Array];
    frames: number;
    fps: number;
    fromSec: number;
    untilSec: number;
    /**
     * 同一次分离顺带给回的四轨包络（智能动感的其他效果用，见 analysis/musicEnvelope.ts）。
     *
     * 值是这一段里每 50ms 的 RMS，**未归一化** —— 整首歌的响度要等全部块到齐才知道。
     * 模型本来就一次吐四轨，所以这一份不额外花推理时间，只多几 KB 过桥。
     */
    envelopes?: NativeStemEnvelopes;
};

/** 一块音频的四条包络曲线（与 `NativeDrumStemBlock` 同段）。 */
export type NativeStemEnvelopes = {
    fps: number;
    bass: Float32Array;
    vocals: Float32Array;
    other: Float32Array;
    /** 混音整体（四条轨的和，用来调明暗与景深）。 */
    energy: Float32Array;
};

/**
 * 从 htdemucs **分离出的鼓轨**上取鼓点频带，原生分块回传（Kotlin 的 separateDrumsBandsFromUrl）。
 *
 * 与混音那条的差别只有「鼓从哪来」：这条的频带里没有贝斯和人声，鼓面不会被别的声音敲响。
 * 代价是慢 —— 手机上一块 30 秒音频要几十秒推理 —— 所以它只做后台补齐：
 * 混音那份先顶上，这一块一块替换，听得越久越准。
 *
 * 每块回传的只是三条频带（约 4.5KB），挑点仍由 Web 侧做，两条路用的是同一份起音判据。
 */
export const separateDrumBandsNativeFromUrl = async (
    url: string,
    onBlock: (block: NativeDrumStemBlock) => void,
    options: { timeoutMs?: number; startSeconds?: number; envelopes?: boolean } = {},
): Promise<{ seconds: number; cancelled: boolean } | null> => {
    if (!isNativeModelsAvailable()) return null;
    if (!url) return null;
    const plugin = NativeAutomix as unknown as {
        separateDrumsBandsFromUrl?: (options: {
            url: string;
            startSeconds?: number;
            envelopes?: boolean;
        }) => Promise<{ ok?: boolean; blocks?: number; seconds?: number; cancelled?: boolean }>;
        addListener: (
            eventName: 'drumStemBands',
            listener: (event: {
                bands?: string[];
                frames?: number;
                fps?: number;
                fromSec?: number;
                untilSec?: number;
                envelopes?: { fps?: number; bass?: string; vocals?: string; other?: string; energy?: string };
            }) => void,
        ) => Promise<PluginListenerHandle>;
    };
    // 旧 APK 的插件没有这个方法：返回 null，调用方继续用混音那份。
    if (typeof plugin.separateDrumsBandsFromUrl !== 'function') return null;
    if (!present.htdemucs && !(await installModel('htdemucs'))) return null;

    let handle: PluginListenerHandle | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
        handle = await plugin.addListener('drumStemBands', (event) => {
            const encoded = Array.isArray(event?.bands) ? event.bands : [];
            // 包络与频带各来各的：鼓静音的一段仍然有包络，没有鼓点也不该丢掉它。
            const envelopes = decodeStemEnvelopes(event?.envelopes);
            if (encoded.length < 3 && !envelopes) return;
            const bands: [Float32Array, Float32Array, Float32Array] = encoded.length >= 3
                ? [decodeChunk(encoded[0]), decodeChunk(encoded[1]), decodeChunk(encoded[2])]
                : [new Float32Array(0), new Float32Array(0), new Float32Array(0)];
            const frames = Number(event?.frames) || bands[0].length;
            if (frames <= 0 && !envelopes) return;
            onBlock({
                bands,
                frames,
                fps: Number(event?.fps) || 50,
                fromSec: Number(event?.fromSec) || 0,
                untilSec: Number(event?.untilSec) || 0,
                ...(envelopes ? { envelopes } : {}),
            });
        });
        /*
         * 十五分钟的兜底：四分钟的歌在手机上分离要几分钟，但再久基本是卡住了。
         * 原生那头是单线程队列，一次卡死会把后面的节拍分析全堵住，所以必须有出口。
         */
        const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
        const result = await Promise.race([
            plugin.separateDrumsBandsFromUrl({
                url,
                ...(options.startSeconds && options.startSeconds > 0 ? { startSeconds: options.startSeconds } : {}),
                ...(options.envelopes ? { envelopes: true } : {}),
            }),
            new Promise<null>((resolve) => {
                timer = setTimeout(() => {
                    console.warn('[AutomixModels] drum stem separation timed out, asking it to stop');
                    void cancelNativeSeparation();
                    resolve(null);
                }, timeoutMs);
            }),
        ]);
        if (!result) return null;
        return { seconds: Number(result.seconds) || 0, cancelled: Boolean(result.cancelled) };
    } catch (error) {
        console.warn('[AutomixModels] drum stem separation failed', error);
        return null;
    } finally {
        if (timer !== null) clearTimeout(timer);
        if (handle) void handle.remove().catch(() => {});
    }
};

/*
 * 启动时问一次原生：模型在不在。
 *
 * 这份快照是同步读的（modelCanRun），而它原来只在用户打开设置或分轨界面时才刷新。
 * 于是刚启动的那几分钟里，权重明明在包里，智能动感的每个特效行都在说「缺少模型」，
 * 第一次分析也要多绕一次「先失败、再安装」。
 *
 * 桥可能还没起来（Capacitor 的 deviceready 晚于首帧），失败时 refresh 保留上一次的
 * 答案，不抛错；调用方在真正要用之前还会再问一次（beatGrid 的 installModel）。
 */
if (isNativeModelsAvailable()) {
    void refreshModelAvailability();
}
