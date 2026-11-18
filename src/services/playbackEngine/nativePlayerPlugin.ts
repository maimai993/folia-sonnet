import { Capacitor, registerPlugin } from '@capacitor/core';

// src/services/playbackEngine/nativePlayerPlugin.ts
//
// 原生播放内核的 JS 侧声明（P1）。与 android/.../player/FoliaNativePlayerPlugin.kt 一一对应：
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
    /**
     * 事件在原生侧生成的时刻（Unix 毫秒，与 JS 的 `Date.now()` 同一个钟）。
     *
     * `positionMs` 是**那一刻**的位置，而事件要过桥才到 WebView。少了这个字段，Web 侧只能
     * 把「收到的时刻」当作那一刻，于是时钟永远落后一段过桥耗时（起播时最明显：正好在铺
     * 歌词、换封面、切视觉器），歌词整首歌都比声音晚 —— 安卓原生播放独有。
     */
    wallMs?: number;
    message?: string;
    songKey?: string;
    /**
     * 事件发出那一刻原生装载着的 source 令牌。Web 发起的装源令牌以 `w:` 开头；
     * 原生自己换源（交叉淡化 / 过渡 / 系统控件）用 `n:`。songKey 分不开 A→B→A 同 key，令牌可以。
     */
    sourceToken?: string;
    /** 原生实际出声/缓冲状态，seeked 不再凭位置跳变推断已恢复播放。 */
    playing?: boolean;
    buffering?: boolean;
};

/**
 * 传输命令（prepare / play / pause / stop / seek）的结果。
 *
 * Promise 在播放器线程**真正执行完**动作之后才结束；被更新的换源 / 播放意图取代而没执行的命令
 * 以 `{ ok: false, stale: true }` resolve（不是 reject）。真正的失败才 reject。
 */
export type NativeCommandResult = {
    ok: boolean;
    stale?: boolean;
    reason?: string;
    transition?: boolean;
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
    /** 引擎此刻装的那一首的 source 令牌（认领时用它丢旧 source 的迟到事件）。 */
    sourceToken?: string;
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
        /** 耳机交叉馈送 0 ~ 1。 */
        crossfeed: number;
        /** 保留旧协议范围 -180 ~ +180，对应声像 -100% ~ +100%。 */
        rotation: number;
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
    /**
     * 母带块：损失补偿 + 九项修复/塑造/增强效果。可缺省，原生对缺席的块按中性（全关）处理。
     * 协议仍是 v2 —— 这是增量扩展字段，老包不带也能照常播放。
     */
    mastering?: {
        compensation: {
            enabled: boolean;
            /** 补偿强度 0 ~ 1。 */
            amount: number;
            /** 最大补偿增益 0 ~ 12 dB。 */
            maxGainDb: number;
            /** AGC 响应时间 50 ~ 800 ms。 */
            responseMs: number;
        };
        noiseGate: {
            enabled: boolean;
            thresholdDb: number;
            attackMs: number;
            releaseMs: number;
            reductionDb: number;
        };
        deEsser: {
            enabled: boolean;
            frequencyHz: number;
            thresholdDb: number;
            ratio: number;
        };
        dePlosive: {
            enabled: boolean;
            reductionDb: number;
        };
        bassBoost: {
            enabled: boolean;
            gainDb: number;
            frequencyHz: number;
        };
        exciter: {
            enabled: boolean;
            amount: number;
            mix: number;
        };
        transient: {
            enabled: boolean;
            amount: number;
        };
        /** 音色塑造四旋钮，0 ~ 6 dB。 */
        tone: {
            air: number;
            presence: number;
            warmth: number;
            clarity: number;
        };
        loudness: {
            enabled: boolean;
            amount: number;
        };
        balance: {
            enabled: boolean;
            value: number;
        };
        /** 工作室块：四大方向 12 项，可缺省，原生按中性兜底。 */
        studio?: {
            normalize: { enabled: boolean; targetLufs: number; truePeak: boolean };
            restore: { declick: boolean; hum: boolean; denoise: boolean; amount: number };
            advanced: {
                dynamicEq: boolean; dynamicEqFreq: number; dynamicEqAmount: number;
                vocalBoost: number;
            };
            scene: { genre: string; compare: boolean; headphone: string; amount: number };
        };
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
        /** 这一次装源的令牌（`w:` 开头）；原生随事件回传，Web 侧据此丢旧 source 的迟到事件。 */
        sourceToken?: string | null;
    }): Promise<NativeCommandResult>;
    play(): Promise<NativeCommandResult | undefined>;
    pause(): Promise<NativeCommandResult | undefined>;
    stop(): Promise<NativeCommandResult | undefined>;
    seek(options: { positionMs: number }): Promise<NativeCommandResult | undefined>;
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
    /** 只留人声（清唱轨）；与关闭人声互斥，互斥由原生状态层保证。 */
    setVocalOnlyEnabled(options: { enabled: boolean }): Promise<void>;
    /**
     * 三态「全部 / 人声 / 伴奏」的原子切换：一次调用同时写两个互斥开关、只换源一次。
     * 界面那一行的三选一走这里；旧包没有这个方法的会 reject，调用方降级到两个旧 setter。
     */
    setVocalTrackMode(options: { mode: 'off' | 'vocal' | 'instrumental' }): Promise<void>;
    /**
     * 「删除人声分离缓存」：清掉原生 cacheDir 里两轨 m4a、把模式退回全部，回新的用量。
     * 界面拿到后要同步本地的两个开关，别让选中态还停在「人声 / 伴奏」。
     */
    clearSeparationCache(): Promise<{ ok: boolean; mode: 'off'; usedCount: number; usedBytes: number; limitBytes: number }>;
    /**
     * 提前把这首歌的两轨分离结果备好，不换源。
     *
     * 返回只表示「任务已排上」，真正生成在原生后台跑几十秒；
     * 已经备过或正在生成的歌会直接返回。
     */
    prepareSongTracks(options: { url: string; songKey: string | null }): Promise<{ ok: boolean }>;
    /** 「设置 → 存储」里的总开关：预先拆分音轨。原生存一份，通知栏起播也能读到。 */
    setPrebuildTracksEnabled(options: { enabled: boolean }): Promise<void>;
    /**
     * 「关闭人声」此刻的状态。
     *
     * idle / building / ready / failed —— ready 表示播的是离线分离好的伴奏，
     * building 时 percent 是分离进度。只在那一页开着时问，不轮询。
     */
    getInstrumentalState(): Promise<{
        state: string;
        percent: number;
        key: string | null;
        /**
         * 这条状态是不是「此刻正在播的这首歌」的。切歌后原生可能还留着上一首的
         * building / ready，界面据此把状态归零，不沿用上一首的旧数据。
         * 可选：旧版 APK 不回这个字段，缺省按「属于当前歌」处理。
         */
        forCurrent?: boolean;
        /** 已缓存首数 / 占用字节 / 当前上限（上限跟着磁盘剩余走，见 InstrumentalStore）。 */
        usedCount: number;
        usedBytes: number;
        limitBytes: number;
        /** instrumental / vocal / off：此刻生效的是哪一轨（用户意图 / 开关）。 */
        mode: 'instrumental' | 'vocal' | 'off';
        /**
         * 播放器此刻真正装着的那一轨：original / instrumental / vocal / none。
         * 换源是异步的，它可能与 mode 短暂不一致；界面据此纠正「切了没生效」的选中态。
         * 可选：旧版 APK 不回这个字段。
         */
        currentTrack?: 'original' | 'instrumental' | 'vocal' | 'none';
    }>;
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
    setVocalOnlyEnabled: (enabled: boolean) => FoliaNativePlayer.setVocalOnlyEnabled({ enabled }),
    setVocalTrackMode: (mode: 'off' | 'vocal' | 'instrumental') =>
        FoliaNativePlayer.setVocalTrackMode({ mode }),
    clearSeparationCache: () => FoliaNativePlayer.clearSeparationCache(),
    prepareSongTracks: (url: string, songKey: string | null) =>
        FoliaNativePlayer.prepareSongTracks({ url, songKey }),
    setPrebuildTracksEnabled: (enabled: boolean) => FoliaNativePlayer.setPrebuildTracksEnabled({ enabled }),
    getInstrumentalState: () => FoliaNativePlayer.getInstrumentalState(),
    getSpectrum: () => FoliaNativePlayer.getSpectrum(),
    getSnapshot: () => FoliaNativePlayer.getSnapshot(),
    getAudioPipelineDiagnostics: () => FoliaNativePlayer.getAudioPipelineDiagnostics(),
    release: () => FoliaNativePlayer.release(),
    addListener: (listener: (event: NativePlaybackEvent) => void) =>
        FoliaNativePlayer.addListener('foliaNativePlayer', listener),
};

/**
 * 「关闭人声」的进度事件。
 *
 * 与播放事件分开一条通道：它是几十秒一次的长任务，混进 foliaNativePlayer
 * 那条高频流里，界面代码到处都要多判一次类型。
 *
 * ⚠️ registerPlugin 返回的代理上 addListener 的签名只声明了播放事件，
 * 这里按事件名另外注册 —— 传错名字不会报错，只是永远收不到。
 */
export const addInstrumentalListener = (
    listener: (event: { state: string; percent: number }) => void,
): void => {
    void (FoliaNativePlayer as unknown as {
        addListener: (
            eventName: string,
            callback: (event: { state: string; percent: number }) => void,
        ) => Promise<unknown>;
    }).addListener('instrumental', listener);
};

/**
 * 「原生手上那条原曲地址不该再用了，请重新解析一个」。
 *
 * 原生那边切回「全部」时，如果原曲地址带取流签名、或者已经装了很久，它不会把那条
 * 可疑的地址塞给播放器（本地又没有原曲的媒体缓存副本时，那就是一个读不出来的源 ——
 * 用户看到「全部」，却听不到声音），而是发这一条事件让 Web 侧重新要地址。
 *
 * 原生不认识任何音乐平台，重新要地址只能在这里做（omni）；拿到新地址后走的是
 * 播放页现成的音源恢复路径，装完播放器自然停在「全部」上。
 *
 * 回一个取消订阅的函数：这个订阅挂在随歌曲变化而重新挂载的 effect 里，
 * 不取消就会一次一次叠上去，同一次事件换好几次流。
 */
export const addSourceReloadListener = (
    listener: (event: { songKey?: string; reason?: string }) => void,
): (() => void) => {
    let handle: { remove?: () => Promise<void> } | null = null;
    let removed = false;
    void (FoliaNativePlayer as unknown as {
        addListener: (
            eventName: string,
            callback: (event: { songKey?: string; reason?: string }) => void,
        ) => Promise<{ remove?: () => Promise<void> }>;
    }).addListener('sourceReload', listener).then(
        (registered) => {
            // 注册在取消之后才回来：立刻拆掉，别让它活过这次挂载。
            if (removed) void registered.remove?.();
            else handle = registered;
        },
        () => undefined,
    );
    return () => {
        removed = true;
        void handle?.remove?.();
        handle = null;
    };
};
