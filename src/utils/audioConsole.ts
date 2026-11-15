// src/utils/audioConsole.ts
// 调音台的模型层：混响、压缩器、前置/后置 EQ 的形状参数。
//
// 与 audioEqualizer.ts 的分工：那边管的是**十段增益本身**（含预设、自定义槽位、mod 曲线），
// 这份文件管的是「这些增益怎么被用」以及另外三块处理。分开存有两个好处：
//   1. 老的存储键（audio_equalizer_settings）一个字节都不用动，升级不会让用户丢设置；
//   2. mod 曲线只作用于十段增益，不会连带把压缩器和混响也改掉 —— 那是两件事。
//
// 存的是「用户的选择」，不是「此刻的声音」：所有字段都是可读的物理量
// （秒、dB、比率、毫秒），原生侧照着算就行，不需要在这里预先算系数。

export const AUDIO_CONSOLE_STORAGE_KEY = 'folia_audio_console';

/** 混响的声学预设。数值是协议里的编号，改动要同步 EqSettings.kt 的 ReverbPreset。 */
export const AUDIO_CONSOLE_REVERB_PRESETS = ['factory', 'hall', 'cathedral', 'plate'] as const;
export type AudioConsoleReverbPreset = typeof AUDIO_CONSOLE_REVERB_PRESETS[number];

/** 压缩器的四段。分频点与原生 MultibandCompressor 一致，改这里要改那边。 */
export const AUDIO_CONSOLE_COMPRESSOR_BANDS = ['low', 'mid', 'high', 'air'] as const;
export type AudioConsoleCompressorBandId = typeof AUDIO_CONSOLE_COMPRESSOR_BANDS[number];

/** 每段的显示名与频率范围（只用于界面，不参与 DSP）。 */
export const AUDIO_CONSOLE_COMPRESSOR_BAND_INFO: Record<
    AudioConsoleCompressorBandId,
    { label: string; range: string }
> = {
    low: { label: 'Low', range: '20 – 250 Hz' },
    mid: { label: 'Mid', range: '250 – 2000 Hz' },
    high: { label: 'High', range: '2000 – 8000 Hz' },
    air: { label: 'Air', range: '8000 – 20000 Hz' },
};

export type AudioConsoleCompressorBand = {
    enabled: boolean;
    /** 阈值 -48 ~ 0 dB。 */
    thresholdDb: number;
    /** 压缩比 1 ~ 20。 */
    ratio: number;
    /** 启动 0.5 ~ 100 ms。 */
    attackMs: number;
    /** 释放 10 ~ 1000 ms。 */
    releaseMs: number;
    /** 补偿增益 0 ~ 12 dB。 */
    makeupDb: number;
    /**
     * 软拐点宽度，2 ~ 18 dB。
     *
     * 小拐点（2 dB）进得干脆，适合鼓与贝斯；大拐点（12 dB 以上）过渡非常软，
     * 人声听不出「什么时候开始压」。出厂 6 dB 是两头都能用的折中。
     */
    kneeDb: number;
    /**
     * 平行压缩的混合比，0 ~ 1。
     *
     * 1 是常规串联压缩（整段都被压）。小于 1 时把压过的信号按比例混回未压的干声，
     * 瞬态保住、密度上来 —— 混音台上最常用的那招。因为压缩本身不引入延迟，
     * 这里等价于把增益量按比例缩放，不会产生梳状滤波。
     */
    mix: number;
};

export type AudioConsoleReverb = {
    enabled: boolean;
    preset: AudioConsoleReverbPreset;
    /** RT60：衰减 60 dB 所需时间，0.3 ~ 10 秒。 */
    rt60: number;
    /** 湿声相对干声的增益，-24 ~ 6 dB。 */
    roomLevelDb: number;
    /** 高频阻尼 0.02 ~ 0.9：越大尾巴越暗。切预设时跟着预设走，之后可单独调。 */
    damping: number;
    /** 预延迟 0 ~ 120 ms：直达声到第一次反射之间的空档，决定「有多远」。 */
    preDelayMs: number;
    /** 干湿比 0 ~ 1（等功率）：0 全干，1 全湿。 */
    mix: number;
    /** 暂停时让余音自然落下，而不是跟着播放器一起断。 */
    tailOnPause: boolean;
};

/** 声场宽度：M/S 加权。只用在中置之后的干声上，混响尾巴不重复处理。 */
export type AudioConsoleStereo = {
    enabled: boolean;
    /** 0 = 完全单声道，1 = 原样，2 = 侧向加倍（宽到喇叭外面）。 */
    width: number;
    /**
     * 低频单声道：这个频率以下的侧向分量归零，只留中置；0 表示关。
     *
     * 唱片里的低频常常两声道相位不一致，叠起来会互相抵消 —— 在外放与单声道蓝牙箱
     * 上就是「底鼓变薄、贝斯消失」。120 Hz 以下是母带处理的常用起点。
     */
    bassMonoHz: number;
};

/** 饱和的三种传输曲线，编号与 EqSettings.kt 的 SaturationMode 一致。 */
export const AUDIO_CONSOLE_SATURATION_MODES = ['tape', 'tube', 'diode'] as const;
export type AudioConsoleSaturationMode = typeof AUDIO_CONSOLE_SATURATION_MODES[number];

/**
 * 饱和 / 染色：给信号加谐波，EQ 与压缩都做不到这件事。
 *
 * 三个参数各管一件事：drive 决定「进曲线多深」，mix 决定「平行的比例」，
 * output 决定「出口多响」。饱和会把响度顶上去，所以 output 是手动的。
 */
export type AudioConsoleSaturation = {
    enabled: boolean;
    mode: AudioConsoleSaturationMode;
    /** 进曲线之前的增益，0 ~ 24 dB。 */
    driveDb: number;
    /** 干湿比 0 ~ 1（等功率）。0.3 ~ 0.5 是保留瞬态的平行饱和。 */
    mix: number;
    /** 出口电平，-24 ~ +6 dB。 */
    outputDb: number;
};

/** 链末前瞻限幅器的两个旋钮（前瞻固定 5 ms）。 */
export type AudioConsoleLimiter = {
    /** 输出上限，-6 ~ 0 dBFS。 */
    ceilingDb: number;
    /** 峰值过后的回落时间，40 ~ 500 ms。 */
    releaseMs: number;
};

export type AudioConsoleCompressor = {
    enabled: boolean;
    /** 2 段（Low / High）或 4 段。 */
    bandCount: 2 | 4;
    /** gentle：慢启动 + 自动补偿；flat：快、不补偿，用来做 A/B。 */
    profile: 'gentle' | 'flat';
    bands: Record<AudioConsoleCompressorBandId, AudioConsoleCompressorBand>;
    /**
     * 三级分频点（Hz），升序：Low|Mid、Mid|High、High|Air。
     *
     * 2 段模式只用第一级。改动它等于重画四段的边界，是「这台压缩器适配这套歌」的关键 ——
     * 男声的 Mid 起点通常比女声低，鼓组的 Air 起点通常比人声高。
     */
    crossovers: [number, number, number];
};

export type AudioConsoleCurve = 'geq' | 'peq';

/** 前置 EQ 的形状（十段增益本身在 audioEqualizerSettings 里）。 */
export type AudioConsoleFrontEq = {
    curve: AudioConsoleCurve;
    /** PEQ 的 Q；GEQ 时忽略。 */
    q: number;
    /** 十段之外的总增益。 */
    globalGainDb: number;
};

export type AudioConsolePostEq = {
    enabled: boolean;
    gains: number[];
    curve: AudioConsoleCurve;
    q: number;
    globalGainDb: number;
};

export type AudioConsoleSettings = {
    reverb: AudioConsoleReverb;
    compressor: AudioConsoleCompressor;
    frontEq: AudioConsoleFrontEq;
    postEq: AudioConsolePostEq;
    stereo: AudioConsoleStereo;
    saturation: AudioConsoleSaturation;
    limiter: AudioConsoleLimiter;
};

/**
 * 每个预设自带的阻尼与预延迟。
 *
 * 选中预设时这两个值会被**写进设置**（预设只是起点，之后可以单独拧），所以它们
 * 同时承担两个职责：切换预设时的初值，以及旧存档缺字段时的兜底。原生侧
 * `ReverbPreset.defaultDamping()` / `defaultPreDelayMs()` 是同一张表，改要一起改。
 */
export const AUDIO_CONSOLE_REVERB_SHAPES: Record<
    AudioConsoleReverbPreset,
    { damping: number; preDelayMs: number }
> = {
    factory: { damping: 0.2, preDelayMs: 0 },
    hall: { damping: 0.28, preDelayMs: 18 },
    cathedral: { damping: 0.34, preDelayMs: 42 },
    plate: { damping: 0.1, preDelayMs: 0 },
};

export const AUDIO_CONSOLE_REVERB_RT60_MIN = 0.3;
export const AUDIO_CONSOLE_REVERB_RT60_MAX = 10;
export const AUDIO_CONSOLE_ROOM_LEVEL_MIN = -24;
export const AUDIO_CONSOLE_ROOM_LEVEL_MAX = 6;
export const AUDIO_CONSOLE_DAMPING_MIN = 0.02;
export const AUDIO_CONSOLE_DAMPING_MAX = 0.9;
export const AUDIO_CONSOLE_PRE_DELAY_MAX = 120;
export const AUDIO_CONSOLE_STEREO_WIDTH_MIN = 0;
export const AUDIO_CONSOLE_STEREO_WIDTH_MAX = 2;
export const AUDIO_CONSOLE_Q_MIN = 0.3;
export const AUDIO_CONSOLE_Q_MAX = 8;
export const AUDIO_CONSOLE_GLOBAL_GAIN_MIN = -24;
export const AUDIO_CONSOLE_GLOBAL_GAIN_MAX = 12;
export const AUDIO_CONSOLE_THRESHOLD_MIN = -48;
export const AUDIO_CONSOLE_THRESHOLD_MAX = 0;
export const AUDIO_CONSOLE_RATIO_MIN = 1;
export const AUDIO_CONSOLE_RATIO_MAX = 20;
export const AUDIO_CONSOLE_ATTACK_MIN = 0.5;
export const AUDIO_CONSOLE_ATTACK_MAX = 100;
export const AUDIO_CONSOLE_RELEASE_MIN = 10;
export const AUDIO_CONSOLE_RELEASE_MAX = 1000;
export const AUDIO_CONSOLE_KNEE_MIN = 2;
export const AUDIO_CONSOLE_KNEE_MAX = 18;

/** 分频点：相邻两级至少差 1.4 倍，否则 LR4 的两条支路会重叠成一团。 */
export const AUDIO_CONSOLE_CROSSOVER_MIN = 60;
export const AUDIO_CONSOLE_CROSSOVER_MAX = 16000;
export const AUDIO_CONSOLE_CROSSOVER_RATIO = 1.4;

export const AUDIO_CONSOLE_BASS_MONO_MAX = 400;

export const AUDIO_CONSOLE_SATURATION_DRIVE_MIN = 0;
export const AUDIO_CONSOLE_SATURATION_DRIVE_MAX = 24;
export const AUDIO_CONSOLE_SATURATION_OUTPUT_MIN = -24;
export const AUDIO_CONSOLE_SATURATION_OUTPUT_MAX = 6;

export const AUDIO_CONSOLE_LIMITER_CEILING_MIN = -6;
export const AUDIO_CONSOLE_LIMITER_CEILING_MAX = 0;
export const AUDIO_CONSOLE_LIMITER_RELEASE_MIN = 40;
export const AUDIO_CONSOLE_LIMITER_RELEASE_MAX = 500;

/** 出厂值的每段压缩参数：低频慢一点，空气段快一点 —— 和耳朵对各频段瞬态的容忍度一致。 */
const BAND_DEFAULTS: Record<AudioConsoleCompressorBandId, AudioConsoleCompressorBand> = {
    low: { enabled: true, thresholdDb: -16, ratio: 1.5, attackMs: 5, releaseMs: 60, makeupDb: 0, kneeDb: 6, mix: 1 },
    mid: { enabled: true, thresholdDb: -18, ratio: 1.6, attackMs: 8, releaseMs: 80, makeupDb: 0, kneeDb: 6, mix: 1 },
    high: { enabled: true, thresholdDb: -20, ratio: 1.8, attackMs: 3, releaseMs: 50, makeupDb: 0, kneeDb: 6, mix: 1 },
    air: { enabled: true, thresholdDb: -22, ratio: 2, attackMs: 2, releaseMs: 40, makeupDb: 0, kneeDb: 6, mix: 1 },
};

export const DEFAULT_AUDIO_CONSOLE_SETTINGS: AudioConsoleSettings = {
    reverb: {
        enabled: false,
        preset: 'factory',
        rt60: 2.2,
        roomLevelDb: -2,
        damping: AUDIO_CONSOLE_REVERB_SHAPES.factory.damping,
        preDelayMs: AUDIO_CONSOLE_REVERB_SHAPES.factory.preDelayMs,
        mix: 0.4,
        tailOnPause: true,
    },
    compressor: {
        enabled: false,
        bandCount: 4,
        profile: 'gentle',
        crossovers: [250, 2000, 8000],
        bands: { ...BAND_DEFAULTS },
    },
    frontEq: {
        curve: 'geq',
        q: 0.85,
        globalGainDb: 0,
    },
    postEq: {
        enabled: false,
        gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        curve: 'geq',
        q: 0.85,
        globalGainDb: 0,
    },
    stereo: {
        enabled: false,
        width: 1,
        bassMonoHz: 0,
    },
    saturation: {
        enabled: false,
        mode: 'tape',
        driveDb: 6,
        mix: 0.5,
        outputDb: -6,
    },
    limiter: {
        ceilingDb: -0.3,
        releaseMs: 120,
    },
};

/**
 * 把存档里读到的未知值当成对象用。
 *
 * 存档可能是旧版本写的、也可能被手改过，所以每个层级都要先确认「它是个对象」。
 * 这行判断原先在 normalize 里抄了五遍，抄漏一处就是一次 `Cannot read property of undefined`。
 */
const asRecord = (value: unknown): Record<string, unknown> => (
    value && typeof value === 'object' ? value as Record<string, unknown> : {}
);

const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
};

const readBoolean = (value: unknown, fallback: boolean): boolean => (
    typeof value === 'boolean' ? value : fallback
);

const readCurve = (value: unknown): AudioConsoleCurve => (value === 'peq' ? 'peq' : 'geq');

const readPreset = (value: unknown): AudioConsoleReverbPreset => (
    AUDIO_CONSOLE_REVERB_PRESETS.includes(value as AudioConsoleReverbPreset)
        ? value as AudioConsoleReverbPreset
        : 'factory'
);

const readSaturationMode = (value: unknown): AudioConsoleSaturationMode => (
    AUDIO_CONSOLE_SATURATION_MODES.includes(value as AudioConsoleSaturationMode)
        ? value as AudioConsoleSaturationMode
        : 'tape'
);

/**
 * 分频点夹紧：从低往高逐级往上推，保证严格升序。
 *
 * 与原生 `sanitizeCrossovers` 是同一套规则。不夹的话，把第一级拖到第二级右边，
 * 中间那段会变成负宽度，四段求和就不再是平的 —— 听感是分频点附近塌下去一块。
 */
export const clampCrossovers = (value: unknown): [number, number, number] => {
    const list = Array.isArray(value) ? value : [];
    const low = clamp(list[0], AUDIO_CONSOLE_CROSSOVER_MIN, 600, 250);
    const mid = clamp(list[1], low * AUDIO_CONSOLE_CROSSOVER_RATIO, 6000, Math.max(low * AUDIO_CONSOLE_CROSSOVER_RATIO, 2000));
    const high = clamp(
        list[2],
        mid * AUDIO_CONSOLE_CROSSOVER_RATIO,
        AUDIO_CONSOLE_CROSSOVER_MAX,
        Math.max(mid * AUDIO_CONSOLE_CROSSOVER_RATIO, 8000),
    );
    return [low, mid, high];
};

const readBand = (value: unknown, id: AudioConsoleCompressorBandId): AudioConsoleCompressorBand => {
    const candidate = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    const fallback = BAND_DEFAULTS[id];
    return {
        enabled: readBoolean(candidate.enabled, fallback.enabled),
        thresholdDb: clamp(candidate.thresholdDb, AUDIO_CONSOLE_THRESHOLD_MIN, AUDIO_CONSOLE_THRESHOLD_MAX, fallback.thresholdDb),
        ratio: clamp(candidate.ratio, AUDIO_CONSOLE_RATIO_MIN, AUDIO_CONSOLE_RATIO_MAX, fallback.ratio),
        attackMs: clamp(candidate.attackMs, AUDIO_CONSOLE_ATTACK_MIN, AUDIO_CONSOLE_ATTACK_MAX, fallback.attackMs),
        releaseMs: clamp(candidate.releaseMs, AUDIO_CONSOLE_RELEASE_MIN, AUDIO_CONSOLE_RELEASE_MAX, fallback.releaseMs),
        makeupDb: clamp(candidate.makeupDb, 0, 12, fallback.makeupDb),
        kneeDb: clamp(candidate.kneeDb, AUDIO_CONSOLE_KNEE_MIN, AUDIO_CONSOLE_KNEE_MAX, fallback.kneeDb),
        mix: clamp(candidate.mix, 0, 1, fallback.mix),
    };
};

const readGains = (value: unknown): number[] => {
    if (!Array.isArray(value)) return [...DEFAULT_AUDIO_CONSOLE_SETTINGS.postEq.gains];
    return Array.from({ length: 10 }, (_, index) => clamp(value[index], -12, 12, 0));
};

/** 把存档里读到的（可能是旧版本、可能是手改过的）设置整理成一份完整合法的设置。 */
export const normalizeAudioConsoleSettings = (value: unknown): AudioConsoleSettings => {
    const root = asRecord(value);
    const reverb = asRecord(root.reverb);
    const compressor = asRecord(root.compressor);
    const frontEq = asRecord(root.frontEq);
    const postEq = asRecord(root.postEq);
    const stereo = asRecord(root.stereo);
    const saturation = asRecord(root.saturation);
    const limiter = asRecord(root.limiter);
    const bands = asRecord(compressor.bands);
    const defaults = DEFAULT_AUDIO_CONSOLE_SETTINGS;
    // 阻尼与预延迟缺席时按预设兜底：旧存档里这两个字段还不存在，而不同预设的
    // 「应该有」的数值不一样，用统一默认值会让大教堂听起来像出厂。
    const preset = readPreset(reverb.preset);
    const shape = AUDIO_CONSOLE_REVERB_SHAPES[preset];

    return {
        reverb: {
            enabled: readBoolean(reverb.enabled, defaults.reverb.enabled),
            preset,
            rt60: clamp(reverb.rt60, AUDIO_CONSOLE_REVERB_RT60_MIN, AUDIO_CONSOLE_REVERB_RT60_MAX, defaults.reverb.rt60),
            roomLevelDb: clamp(reverb.roomLevelDb, AUDIO_CONSOLE_ROOM_LEVEL_MIN, AUDIO_CONSOLE_ROOM_LEVEL_MAX, defaults.reverb.roomLevelDb),
            damping: clamp(reverb.damping, AUDIO_CONSOLE_DAMPING_MIN, AUDIO_CONSOLE_DAMPING_MAX, shape.damping),
            preDelayMs: clamp(reverb.preDelayMs, 0, AUDIO_CONSOLE_PRE_DELAY_MAX, shape.preDelayMs),
            mix: clamp(reverb.mix, 0, 1, defaults.reverb.mix),
            tailOnPause: readBoolean(reverb.tailOnPause, defaults.reverb.tailOnPause),
        },
        compressor: {
            enabled: readBoolean(compressor.enabled, defaults.compressor.enabled),
            bandCount: compressor.bandCount === 2 ? 2 : 4,
            profile: compressor.profile === 'flat' ? 'flat' : 'gentle',
            crossovers: clampCrossovers(compressor.crossovers),
            bands: {
                low: readBand(bands.low, 'low'),
                mid: readBand(bands.mid, 'mid'),
                high: readBand(bands.high, 'high'),
                air: readBand(bands.air, 'air'),
            },
        },
        frontEq: {
            curve: readCurve(frontEq.curve),
            q: clamp(frontEq.q, AUDIO_CONSOLE_Q_MIN, AUDIO_CONSOLE_Q_MAX, defaults.frontEq.q),
            globalGainDb: clamp(frontEq.globalGainDb, AUDIO_CONSOLE_GLOBAL_GAIN_MIN, AUDIO_CONSOLE_GLOBAL_GAIN_MAX, defaults.frontEq.globalGainDb),
        },
        postEq: {
            enabled: readBoolean(postEq.enabled, defaults.postEq.enabled),
            gains: readGains(postEq.gains),
            curve: readCurve(postEq.curve),
            q: clamp(postEq.q, AUDIO_CONSOLE_Q_MIN, AUDIO_CONSOLE_Q_MAX, defaults.postEq.q),
            globalGainDb: clamp(postEq.globalGainDb, AUDIO_CONSOLE_GLOBAL_GAIN_MIN, AUDIO_CONSOLE_GLOBAL_GAIN_MAX, defaults.postEq.globalGainDb),
        },
        stereo: {
            enabled: readBoolean(stereo.enabled, defaults.stereo.enabled),
            width: clamp(stereo.width, AUDIO_CONSOLE_STEREO_WIDTH_MIN, AUDIO_CONSOLE_STEREO_WIDTH_MAX, defaults.stereo.width),
            bassMonoHz: clamp(stereo.bassMonoHz, 0, AUDIO_CONSOLE_BASS_MONO_MAX, defaults.stereo.bassMonoHz),
        },
        saturation: {
            enabled: readBoolean(saturation.enabled, defaults.saturation.enabled),
            mode: readSaturationMode(saturation.mode),
            driveDb: clamp(saturation.driveDb, AUDIO_CONSOLE_SATURATION_DRIVE_MIN, AUDIO_CONSOLE_SATURATION_DRIVE_MAX, defaults.saturation.driveDb),
            mix: clamp(saturation.mix, 0, 1, defaults.saturation.mix),
            outputDb: clamp(saturation.outputDb, AUDIO_CONSOLE_SATURATION_OUTPUT_MIN, AUDIO_CONSOLE_SATURATION_OUTPUT_MAX, defaults.saturation.outputDb),
        },
        limiter: {
            ceilingDb: clamp(limiter.ceilingDb, AUDIO_CONSOLE_LIMITER_CEILING_MIN, AUDIO_CONSOLE_LIMITER_CEILING_MAX, defaults.limiter.ceilingDb),
            releaseMs: clamp(limiter.releaseMs, AUDIO_CONSOLE_LIMITER_RELEASE_MIN, AUDIO_CONSOLE_LIMITER_RELEASE_MAX, defaults.limiter.releaseMs),
        },
    };
};

export const readStoredAudioConsoleSettings = (): AudioConsoleSettings => {
    if (typeof window === 'undefined') return normalizeAudioConsoleSettings(null);
    try {
        const raw = window.localStorage.getItem(AUDIO_CONSOLE_STORAGE_KEY);
        return normalizeAudioConsoleSettings(raw ? JSON.parse(raw) : null);
    } catch {
        return normalizeAudioConsoleSettings(null);
    }
};

export const writeStoredAudioConsoleSettings = (settings: AudioConsoleSettings) => {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(AUDIO_CONSOLE_STORAGE_KEY, JSON.stringify(settings));
    } catch {
        // 存不下（隐私模式配额）不该让界面崩：这一份只在这次会话里有效。
    }
};

/** 参数是否一样：store 用它在拖动结束时判「要不要落盘」，推原生也用它去重。 */
export const areAudioConsoleSettingsEqual = (left: AudioConsoleSettings, right: AudioConsoleSettings): boolean => (
    JSON.stringify(left) === JSON.stringify(right)
);

/**
 * 一段压缩的静态曲线：给定输入电平，返回输出电平（dB）。
 *
 * 只用于画出那条折线；真正的压缩在原生侧按块算，两条曲线用的是同一组
 * 阈值 / 比率 / 软拐点宽度，所以界面上看到的就是听到的。
 *
 * `mix` 不参与这条曲线：它决定的是「压过的信号混回多少」，画在曲线上会把
 * 一条本该是折线的形状压成两条线的加权平均，反而看不出拐点在哪。
 */
export const compressorTransferDb = (inputDb: number, band: AudioConsoleCompressorBand): number => {
    if (!band.enabled || band.ratio <= 1.001) return inputDb;
    const knee = Math.max(AUDIO_CONSOLE_KNEE_MIN, band.kneeDb);
    const over = inputDb - band.thresholdDb;
    const reduction = over <= -knee / 2
        ? 0
        : over < knee / 2
            ? (1 / band.ratio - 1) * (over + knee / 2) * (over + knee / 2) / (2 * knee)
            : (1 / band.ratio - 1) * over;
    return inputDb + reduction + band.makeupDb;
};

/** 增益衰减量（负数，dB）：给界面上的「-6.3 dB」用。 */
export const compressorGainReductionDb = (inputDb: number, band: AudioConsoleCompressorBand): number => (
    compressorTransferDb(inputDb, band) - inputDb
);

/** WAV 脉冲响应的分析结果。 */
export type AudioConsoleImpulseProfile = {
    /** 从直达声衰减 60 dB 的时间，夹在 0.3 ~ 10 秒。 */
    rt60: number;
    /** 预延迟（毫秒）：直达声之前的那一段静音。 */
    preDelayMs: number;
    /** 阻尼 0 ～ 1：尾巴越暗越大。 */
    damping: number;
    /** 文件里带的采样率，只用于显示。 */
    sampleRate: number;
    /** 时长（秒）。 */
    durationSeconds: number;
};

/**
 * 从一段 WAV 脉冲响应里量出「这个空间有多大、多暗、多远」。
 *
 * 为什么不做真卷积：48 kHz 立体声、2 秒的 IR 是 21 万个抽头，逐样本卷积在中端机上是
 * 几十个点的 CPU；分块 FFT 卷积能跑，但那是另一个量级的实现。这里的做法是**测量**这份
 * IR，把它的三个可听特征（衰减时间、预延迟、高频阻尼）折成参数化混响的参数 ——
 * 听感上得到同一个空间，代价是失去了 IR 里那些细节（比如某个特定的早期反射）。
 *
 * 只支持未压缩的 WAV（PCM 8/16/24/32 位或 IEEE float）。其它格式抛错，由调用方提示。
 */
export const analyzeImpulseWav = (buffer: ArrayBuffer): AudioConsoleImpulseProfile => {
    const view = new DataView(buffer);
    if (buffer.byteLength < 44) throw new Error('not a wav');

    const readTag = (offset: number) => String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3),
    );

    if (readTag(0) !== 'RIFF' || readTag(8) !== 'WAVE') throw new Error('not a wav');

    let cursor = 12;
    let channels = 1;
    let sampleRate = 48000;
    let bitsPerSample = 16;
    let audioFormat = 1;
    let dataOffset = -1;
    let dataLength = 0;

    while (cursor + 8 <= buffer.byteLength) {
        const tag = readTag(cursor);
        const size = view.getUint32(cursor + 4, true);
        const body = cursor + 8;
        if (tag === 'fmt ') {
            audioFormat = view.getUint16(body, true);
            channels = view.getUint16(body + 2, true) || 1;
            sampleRate = view.getUint32(body + 4, true) || 48000;
            bitsPerSample = view.getUint16(body + 14, true) || 16;
        } else if (tag === 'data') {
            dataOffset = body;
            dataLength = Math.min(size, buffer.byteLength - body);
            break;
        }
        cursor = body + size + (size % 2);
    }

    if (dataOffset < 0) throw new Error('no data chunk');

    const bytesPerSample = Math.max(1, Math.round(bitsPerSample / 8));
    const frameBytes = bytesPerSample * channels;
    const frames = Math.floor(dataLength / frameBytes);
    if (frames < 64) throw new Error('too short');

    const sampleAt = (frame: number): number => {
        const offset = dataOffset + frame * frameBytes;
        if (audioFormat === 3 && bitsPerSample === 32) return view.getFloat32(offset, true);
        if (bitsPerSample === 8) return (view.getUint8(offset) - 128) / 128;
        if (bitsPerSample === 16) return view.getInt16(offset, true) / 32768;
        if (bitsPerSample === 24) {
            const low = view.getUint8(offset);
            const mid = view.getUint8(offset + 1);
            const high = view.getInt8(offset + 2);
            return ((high << 16) | (mid << 8) | low) / 8388608;
        }
        return view.getInt32(offset, true) / 2147483648;
    };

    // ① 峰值与它的位置：用来定预延迟，也用来把后续的量都相对它做。
    let peak = 0;
    let peakFrame = 0;
    for (let frame = 0; frame < frames; frame += 1) {
        const magnitude = Math.abs(sampleAt(frame));
        if (magnitude > peak) {
            peak = magnitude;
            peakFrame = frame;
        }
    }
    if (peak <= 0) throw new Error('silent impulse');

    // ② 预延迟：峰值之前、最后一次低于峰值 -40 dB 的位置。
    let directStart = peakFrame;
    for (let frame = peakFrame; frame >= 0; frame -= 1) {
        if (Math.abs(sampleAt(frame)) < peak * 0.01) {
            directStart = frame;
            break;
        }
    }
    const preDelayMs = (directStart / sampleRate) * 1000;

    // ③ RT60：Schroeder 反向能量积分，取 -5 dB 到 -35 dB 那一段的斜率外推到 -60 dB。
    //    直接找「-60 dB 那一点」在真实 IR 上不可靠：噪声底会把尾巴托住。
    const envelope = new Float64Array(frames);
    let accumulator = 0;
    for (let frame = frames - 1; frame >= 0; frame -= 1) {
        const sample = sampleAt(frame);
        accumulator += sample * sample;
        envelope[frame] = accumulator;
    }
    const total = envelope[0] || 1;
    const dbAt = (frame: number) => 10 * Math.log10(Math.max(envelope[frame] / total, 1e-12));

    let startDbFrame = -1;
    let endDbFrame = -1;
    for (let frame = 0; frame < frames; frame += 1) {
        const db = dbAt(frame);
        if (startDbFrame < 0 && db <= -5) startDbFrame = frame;
        if (endDbFrame < 0 && db <= -35) {
            endDbFrame = frame;
            break;
        }
    }
    let rt60 = 2.2;
    if (startDbFrame >= 0 && endDbFrame > startDbFrame) {
        const slope = (dbAt(endDbFrame) - dbAt(startDbFrame)) / (endDbFrame - startDbFrame);
        if (slope < 0) rt60 = (-60 / slope) / sampleRate;
    }
    rt60 = Math.min(AUDIO_CONSOLE_REVERB_RT60_MAX, Math.max(AUDIO_CONSOLE_REVERB_RT60_MIN, rt60));

    // ④ 阻尼：尾巴前半段与后半段的高频能量比。用一阶差分当高通，近似看「亮不亮」。
    const tailStart = Math.max(endDbFrame, directStart);
    const mid = Math.floor((tailStart + frames) / 2);
    let brightEarly = 0;
    let brightLate = 0;
    for (let frame = tailStart + 1; frame < mid; frame += 1) {
        brightEarly += Math.abs(sampleAt(frame) - sampleAt(frame - 1));
    }
    for (let frame = mid + 1; frame < frames; frame += 1) {
        brightLate += Math.abs(sampleAt(frame) - sampleAt(frame - 1));
    }
    const brightRatio = brightEarly > 0 ? brightLate / brightEarly : 1;
    const damping = Math.min(0.6, Math.max(0.05, 0.35 - (brightRatio - 1) * 0.3));

    return {
        rt60,
        preDelayMs: Math.min(120, Math.max(0, preDelayMs)),
        damping,
        sampleRate,
        durationSeconds: frames / sampleRate,
    };
};
