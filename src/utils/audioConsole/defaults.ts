import {
    type AudioConsoleReverbPreset,
    type AudioConsoleCompressorBandId,
    type AudioConsoleCompressorBand,
    type AudioConsoleSettings,
} from './model';

// 与原生协议一致的范围和出厂设置。
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

export const AUDIO_CONSOLE_CROSSFEED_MIN = 0;
export const AUDIO_CONSOLE_CROSSFEED_MAX = 1;
export const AUDIO_CONSOLE_ROTATION_MIN = -180;
export const AUDIO_CONSOLE_ROTATION_MAX = 180;
export const AUDIO_CONSOLE_BASS_MONO_MAX = 400;

export const AUDIO_CONSOLE_SATURATION_DRIVE_MIN = 0;
export const AUDIO_CONSOLE_SATURATION_DRIVE_MAX = 24;
export const AUDIO_CONSOLE_SATURATION_OUTPUT_MIN = -24;
export const AUDIO_CONSOLE_SATURATION_OUTPUT_MAX = 6;

export const AUDIO_CONSOLE_LIMITER_CEILING_MIN = -6;
export const AUDIO_CONSOLE_LIMITER_CEILING_MAX = 0;
export const AUDIO_CONSOLE_LIMITER_RELEASE_MIN = 40;
export const AUDIO_CONSOLE_LIMITER_RELEASE_MAX = 500;

// —— 母带块：损失补偿与四个新增效果的取值范围 ——
export const AUDIO_CONSOLE_COMP_AMOUNT_MIN = 0;
export const AUDIO_CONSOLE_COMP_AMOUNT_MAX = 1;
export const AUDIO_CONSOLE_COMP_MAX_GAIN_MIN = 0;
export const AUDIO_CONSOLE_COMP_MAX_GAIN_MAX = 12;
export const AUDIO_CONSOLE_COMP_RESPONSE_MIN = 50;
export const AUDIO_CONSOLE_COMP_RESPONSE_MAX = 800;

export const AUDIO_CONSOLE_GATE_THRESHOLD_MIN = -80;
export const AUDIO_CONSOLE_GATE_THRESHOLD_MAX = -20;
export const AUDIO_CONSOLE_GATE_ATTACK_MIN = 0.5;
export const AUDIO_CONSOLE_GATE_ATTACK_MAX = 50;
export const AUDIO_CONSOLE_GATE_RELEASE_MIN = 20;
export const AUDIO_CONSOLE_GATE_RELEASE_MAX = 600;
export const AUDIO_CONSOLE_GATE_REDUCTION_MIN = -60;
export const AUDIO_CONSOLE_GATE_REDUCTION_MAX = -6;

export const AUDIO_CONSOLE_DEESS_FREQ_MIN = 4000;
export const AUDIO_CONSOLE_DEESS_FREQ_MAX = 10000;
export const AUDIO_CONSOLE_DEESS_THRESHOLD_MIN = -48;
export const AUDIO_CONSOLE_DEESS_THRESHOLD_MAX = 0;
export const AUDIO_CONSOLE_DEESS_RATIO_MIN = 1;
export const AUDIO_CONSOLE_DEESS_RATIO_MAX = 10;

export const AUDIO_CONSOLE_BASS_GAIN_MIN = 0;
export const AUDIO_CONSOLE_BASS_GAIN_MAX = 12;
export const AUDIO_CONSOLE_BASS_FREQ_MIN = 40;
export const AUDIO_CONSOLE_BASS_FREQ_MAX = 250;

export const AUDIO_CONSOLE_TONE_MIN = 0;
export const AUDIO_CONSOLE_TONE_MAX = 6;

export const AUDIO_CONSOLE_EXCITER_AMOUNT_MIN = 0;
export const AUDIO_CONSOLE_EXCITER_AMOUNT_MAX = 1;

export const AUDIO_CONSOLE_TRANSIENT_MIN = -1;
export const AUDIO_CONSOLE_TRANSIENT_MAX = 1;

export const AUDIO_CONSOLE_LOUDNESS_MIN = 0;
export const AUDIO_CONSOLE_LOUDNESS_MAX = 1;

export const AUDIO_CONSOLE_DEPLOSIVE_REDUCTION_MIN = -24;
export const AUDIO_CONSOLE_DEPLOSIVE_REDUCTION_MAX = 0;

export const AUDIO_CONSOLE_BALANCE_MIN = -1;
export const AUDIO_CONSOLE_BALANCE_MAX = 1;

// —— 工作室块取值范围 ——
export const AUDIO_CONSOLE_TARGET_LUFS_MIN = -20;
export const AUDIO_CONSOLE_TARGET_LUFS_MAX = -9;
export const AUDIO_CONSOLE_RESTORE_AMOUNT_MIN = 0;
export const AUDIO_CONSOLE_RESTORE_AMOUNT_MAX = 1;
export const AUDIO_CONSOLE_DYNEQ_FREQ_MIN = 80;
export const AUDIO_CONSOLE_DYNEQ_FREQ_MAX = 400;
export const AUDIO_CONSOLE_DYNEQ_AMOUNT_MIN = 0;
export const AUDIO_CONSOLE_DYNEQ_AMOUNT_MAX = 12;
export const AUDIO_CONSOLE_VOCAL_MIN = 0;
export const AUDIO_CONSOLE_VOCAL_MAX = 1;
export const AUDIO_CONSOLE_SCENE_AMOUNT_MIN = 0;
export const AUDIO_CONSOLE_SCENE_AMOUNT_MAX = 1;

export const AUDIO_CONSOLE_GENRES = ['flat', 'pop', 'rock', 'jazz', 'classical', 'electronic', 'vocal'] as const;
export const AUDIO_CONSOLE_HEADPHONES = ['flat', 'airpods', 'sony', 'sennheiser'] as const;

/** 出厂值的每段压缩参数：低频慢一点，空气段快一点 —— 和耳朵对各频段瞬态的容忍度一致。 */
export const BAND_DEFAULTS: Record<AudioConsoleCompressorBandId, AudioConsoleCompressorBand> = {
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
        crossfeed: 0,
        rotation: 0,
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
    mastering: {
        compensation: {
            enabled: false,
            amount: 0.7,
            maxGainDb: 6,
            responseMs: 300,
        },
        noiseGate: {
            enabled: false,
            thresholdDb: -50,
            attackMs: 5,
            releaseMs: 120,
            reductionDb: -24,
        },
        deEsser: {
            enabled: false,
            frequencyHz: 6500,
            thresholdDb: -24,
            ratio: 4,
        },
        dePlosive: {
            enabled: false,
            reductionDb: -12,
        },
        bassBoost: {
            enabled: false,
            gainDb: 4,
            frequencyHz: 90,
        },
        exciter: {
            enabled: false,
            amount: 0.4,
            mix: 0.35,
        },
        transient: {
            enabled: false,
            amount: 0.5,
        },
        tone: {
            air: 0,
            presence: 0,
            warmth: 0,
            clarity: 0,
        },
        loudness: {
            enabled: false,
            amount: 0.5,
        },
        balance: {
            enabled: false,
            value: 0,
        },
        studio: {
            normalize: {
                enabled: false,
                targetLufs: -14,
                truePeak: true,
            },
            restore: {
                declick: false,
                hum: false,
                denoise: false,
                amount: 0.5,
            },
            advanced: {
                dynamicEq: false,
                dynamicEqFreq: 180,
                dynamicEqAmount: 4,
                vocalBoost: 0,
            },
            scene: {
                genre: 'flat',
                compare: false,
                headphone: 'flat',
                amount: 0.6,
            },
        },
    },
};
