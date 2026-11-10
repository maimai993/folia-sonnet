import { Capacitor, registerPlugin } from '@capacitor/core';

// src/services/playbackEngine/nativePlayerPlugin.ts
//
// 原生播放内核的 JS 侧声明（P1）。与 android/.../player/FoliaNativePlayerPlugin.java 一一对应：
// 方法名、事件名（`foliaNativePlayer`）、字段名改一处两边都要改。

export type NativePlaybackEventType =
    | 'ready'
    | 'playing'
    | 'paused'
    | 'ended'
    | 'position'
    /** 位置跳变（seek / 单曲循环回到开头）：允许时钟往回走。 */
    | 'seeked'
    | 'buffering'
    | 'error'
    | 'idle';

export type NativePlaybackEvent = {
    type: NativePlaybackEventType;
    positionMs?: number;
    durationMs?: number;
    message?: string;
    songKey?: string;
    /** 原生实际出声/缓冲状态，seeked 不再凭位置跳变推断已恢复播放。 */
    playing?: boolean;
    buffering?: boolean;
};

export type NativePlaybackSnapshot = {
    positionMs: number;
    durationMs: number;
    playing: boolean;
    buffering?: boolean;
    speed?: number;
    /**
     * 引擎此刻**装的那一首**（装源时写进 MediaItem 的 mediaId），没装东西时为空串。
     *
     * 判「点歌有没有真的换过去」只能看这个：服务里的 `cachedSongKey` 会随 Web 推的
     * metadata 变，拿它当判据等于自己给自己盖章。
     */
    songKey?: string;
};

/**
 * 原生调音台的设置载荷。
 *
 * 与 Web 的 `AudioEqualizerSettings` + `AudioConsoleSettings` 合起来对齐原生真正会执行的
 * 那几项。饱和 / 比特降质 / 抖晃 / 黑胶噪声 / 宽度在原生链上没有对应的站，**不再发**：
 * 发了原生也只是忽略，而界面若还留着滑杆，用户会以为拖了有用。饱和在「染色」页，
 * 宽度在「混响 · 声场」，两者各有自己的字段（`saturation` / `stereo`）。
 * 同理 punch 与 space 这两个 v1 遗留字段也不再发 —— 压缩与混响各有一整页，
 * 预设若偷偷带上它们，等于在用户看不见的地方开第二台压缩器、或让「混响关着」也响。
 *
 * `gains` 必须正好 10 项；原生会再夹一次 ±12 dB，不依赖这边传得干净。
 * 协议 `version` 2 起才有 `eq` / `reverb` / `compressor` / `postEq` 四块；
 * 原生对缺席的块按中性处理，所以少传不会让播放失败。
 */
export type NativeEqualizerSettings = {
    version: number;
    enabled: boolean;
    gains: number[];
    /** 前置 EQ 的形状：GEQ 定 Q，PEQ 用下面的 q。 */
    eq: {
        mode: 'geq' | 'peq';
        q: number;
        globalGainDb: number;
    };
    /** 只剩两颗滤波器：高频截止与低频截止。 */
    effects: {
        highpass: number;
        lowpass: number;
    };
    reverb: {
        enabled: boolean;
        /** 0 出厂 / 1 音乐厅 / 2 空灵大教堂 / 3 板式。只决定房间大小。 */
        preset: number;
        rt60: number;
        roomLevelDb: number;
        /** 高频阻尼 0.02 ~ 0.9。 */
        damping: number;
        /** 预延迟 0 ~ 120 ms。 */
        preDelayMs: number;
        /** 干湿比 0 ~ 1（等功率）。 */
        mix: number;
        tailOnPause: boolean;
    };
    compressor: {
        enabled: boolean;
        bandCount: number;
        /** 0 温和 / 1 平直。 */
        profile: number;
        /** 三级分频点（Hz），升序：Low|Mid、Mid|High、High|Air。2 段模式只用第一级。 */
        crossovers: number[];
        bands: Array<{
            enabled: boolean;
            thresholdDb: number;
            ratio: number;
            attackMs: number;
            releaseMs: number;
            makeupDb: number;
            /** 软拐点 2 ~ 18 dB。 */
            kneeDb: number;
            /** 平行压缩混合比 0 ~ 1。 */
            mix: number;
        }>;
    };
    postEq: {
        enabled: boolean;
        gains: number[];
        mode: 'geq' | 'peq';
        q: number;
        globalGainDb: number;
    };
    /** 声场宽度：M/S 加权，挂在混响之前。 */
    stereo: {
        enabled: boolean;
        /** 0 单声道 ~ 2 加倍；1 是原样。 */
        width: number;
        /** 低频单声道：该频率以下的侧向归零；0 表示关。 */
        bassMonoHz: number;
    };
    /** 饱和 / 染色：给信号加谐波，挂在后置 EQ 之后、立体声之前。 */
    saturation: {
        enabled: boolean;
        /** tape / tube / diode。 */
        mode: 'tape' | 'tube' | 'diode';
        /** 进曲线的增益 0 ~ 24 dB。 */
        driveDb: number;
        /** 干湿比 0 ~ 1（等功率）。 */
        mix: number;
        /** 出口电平 -24 ~ +6 dB。 */
        outputDb: number;
    };
    /** 链末限幅器。 */
    limiter: {
        /** 输出上限 -6 ~ 0 dBFS。 */
        ceilingDb: number;
        /** 回落时间 40 ~ 500 ms。 */
        releaseMs: number;
    };
    /** 增益滑入时间（毫秒）：用户改动 15，mod 曲线 250（对齐 Web 的 setTargetAtTime 常数）。 */
    glideMs: number;
};

export type NativeEqualizerState = NativeEqualizerSettings & {
    /** 进程内变更序号：诊断时用来确认「推的这条原生到底收没收到」。 */
    seq: number;
};

/** 一帧频谱：32 段，0..1 对应 -90 dB ~ 0 dB。 */
export type NativeSpectrumFrame = {
    bands: number[];
};

/**
 * 原生音频链路的诊断快照（P0 标尺）。
 *
 * 三段格式分开报，因为「音质变差」发生在这条链的不同位置时，听感几乎一样：
 *
 * - `input*` —— 解码器交出来的 PCM，也就是**进 DSP 之前**的格式。高解析度源被降位就发生在这里；
 * - `track*` —— AudioTrack 实际配置，也就是**交给声卡**的格式。设备不支持源采样率时这里会看到别的值；
 * - `dsp*` —— 处理器链在不在、跑过多少帧、被静默摘链几次。
 *
 * 字段名与原生 `AudioPipelineTelemetry.Snapshot` 一一对应，改一处两边都要改。
 */
export type NativeAudioPipelineDiagnostics = {
    /** 活着的播放器数（主播放器 + 交叉淡化那一台）。 */
    players: number;
    inputSampleRate: number;
    inputChannels: number;
    /** `16-bit` / `24-bit` / `32-bit float` … */
    inputPcm: string;
    /** 容器里的编码，如 `audio/flac`。 */
    inputMime: string;
    inputBitrateKbps: number;
    inputCodecs: string;
    trackSampleRate: number;
    trackChannels: number;
    trackPcm: string;
    /** AudioTrack 缓冲折算成的时间长度。 */
    trackBufferMs: number;
    trackTunneling: boolean;
    trackOffload: boolean;
    underrunCount: number;
    underrunBytes: number;
    sinkErrorCount: number;
    lastSinkError: string;
    dspActive: boolean;
    dspFrames: number;
    dspPassthroughFrames: number;
    /** `onConfigure` 因为输入不是 16bit 而摘掉整条链的次数。>0 = 「有些歌没有 EQ」。 */
    dspBypassCount: number;
    /** 累计处理块数。 */
    dspBlockCount?: number;
    /** 每个块的处理耗时（微秒），近 256 块的中位数。旧版原生没有这三个字段。 */
    dspCostP50Us?: number;
    /** 同上，99 分位 —— 高但中位数正常，说明卡顿来自长尾。 */
    dspCostP99Us?: number;
    /** 处理器占用单核的百分比：100 = 刚好跑得及，再高必然欠载。 */
    dspLoadPercent?: number;
    /** 250ms 位置轮询累计拍数，用来估息屏/后台还在空转多少。 */
    positionTicks: number;
    /** 进程累计 CPU 时间（ms）。对比两次快照的差值就是这段时间真正吃掉的 CPU。 */
    cpuMs: number;
    cpuCores: number;
    batteryPercent: number;
    batteryCurrentMa: number;
    interactive: boolean;
    /** 一句话结论：降位 / 重采样 / 摘链 / 欠载发生在哪一段。 */
    verdict: string;
};

interface FoliaNativePlayerPlugin {
    prepare(options: {
        url: string;
        startPositionMs?: number | null;
        /** Player.REPEAT_MODE_OFF(0) / ONE(1) / ALL(2)，与 androidx.media3.common.Player 一致。 */
        repeatMode?: number | null;
        /** 这首歌的身份，装进去之后 getSnapshot().songKey 会回它。 */
        songKey?: string | null;
    }): Promise<{ ok: boolean }>;
    play(): Promise<void>;
    pause(): Promise<void>;
    stop(): Promise<void>;
    seek(options: { positionMs: number }): Promise<void>;
    setVolume(options: { volume: number }): Promise<void>;
    setSpeed(options: { speed: number }): Promise<void>;
    setRepeatMode(options: { repeatMode: number }): Promise<void>;
    setEqualizer(options: { settings: NativeEqualizerSettings }): Promise<{ applied: boolean; active: boolean; seq: number }>;
    getEqualizerState(): Promise<NativeEqualizerState>;
    /** 频谱取样开关：只有后置均衡器那一页打开时才开，没人看就不该在音频线程上跑 FFT。 */
    setSpectrumEnabled(options: { enabled: boolean }): Promise<void>;
    /**
     * 关闭人声（中置相消）开关。
     *
     * 只改一个原生侧的布尔值，音频线程下一帧就照它处理：不重建音频链、
     * 不重新加载音频，拨开关即时生效。算法见原生 VocalCancelProcessor.kt。
     */
    setVocalCancelEnabled(options: { enabled: boolean }): Promise<void>;
    getSpectrum(): Promise<NativeSpectrumFrame>;
    getSnapshot(): Promise<NativePlaybackSnapshot>;
    /**
     * 音频链路诊断快照。**与播放状态无关**：没在播也能读，返回的是「上一次播放的格式」
     * 与本次会话的累计计数 —— 诊断最需要的恰恰是「播过之后」。
     */
    getAudioPipelineDiagnostics(): Promise<NativeAudioPipelineDiagnostics>;
    release(): Promise<void>;
    addListener(
        eventName: 'foliaNativePlayer',
        listener: (event: NativePlaybackEvent) => void,
    ): Promise<() => void>;
}

const FoliaNativePlayer = registerPlugin<FoliaNativePlayerPlugin>('FoliaNativePlayer');

/**
 * 这个插件是不是真的在。
 *
 * ⚠️ 不能用 `typeof FoliaNativePlayer?.play === 'function'` 判：registerPlugin() 给回来的是
 * 代理，方法名问过去永远是 function，原生侧一行没写也会返回 true。必须查原生上报的
 * pluginHeaders（同步），否则会出现「开关开着、播放器其实不存在」的静默降级。
 */
export const isNativePlayerAvailable = (): boolean => {
    if (typeof Capacitor === 'undefined') return false;
    if (!Capacitor.isNativePlatform()) return false;
    return Capacitor.isPluginAvailable('FoliaNativePlayer');
};

export const nativePlayer = {
    prepare: (options: Parameters<FoliaNativePlayerPlugin['prepare']>[0]) => FoliaNativePlayer.prepare(options),
    play: () => FoliaNativePlayer.play(),
    pause: () => FoliaNativePlayer.pause(),
    stop: () => FoliaNativePlayer.stop(),
    seek: (positionMs: number) => FoliaNativePlayer.seek({ positionMs }),
    setVolume: (volume: number) => FoliaNativePlayer.setVolume({ volume }),
    setSpeed: (speed: number) => FoliaNativePlayer.setSpeed({ speed }),
    setRepeatMode: (repeatMode: number) => FoliaNativePlayer.setRepeatMode({ repeatMode }),
    setEqualizer: (settings: NativeEqualizerSettings) => FoliaNativePlayer.setEqualizer({ settings }),
    getEqualizerState: () => FoliaNativePlayer.getEqualizerState(),
    setSpectrumEnabled: (enabled: boolean) => FoliaNativePlayer.setSpectrumEnabled({ enabled }),
    setVocalCancelEnabled: (enabled: boolean) => FoliaNativePlayer.setVocalCancelEnabled({ enabled }),
    getSpectrum: () => FoliaNativePlayer.getSpectrum(),
    getSnapshot: () => FoliaNativePlayer.getSnapshot(),
    getAudioPipelineDiagnostics: () => FoliaNativePlayer.getAudioPipelineDiagnostics(),
    release: () => FoliaNativePlayer.release(),
    addListener: (listener: (event: NativePlaybackEvent) => void) =>
        FoliaNativePlayer.addListener('foliaNativePlayer', listener),
};
