import {
    AUDIO_CONSOLE_REVERB_PRESETS,
    type AudioConsoleReverbPreset,
    type AudioConsoleCompressorBandId,
    type AudioConsoleCompressorBand,
    AUDIO_CONSOLE_SATURATION_MODES,
    type AudioConsoleSaturationMode,
    type AudioConsoleCurve,
    type AudioConsoleMastering,
    type AudioConsoleSettings,
} from './model';
import {
    AUDIO_CONSOLE_REVERB_SHAPES,
    AUDIO_CONSOLE_REVERB_RT60_MIN,
    AUDIO_CONSOLE_REVERB_RT60_MAX,
    AUDIO_CONSOLE_ROOM_LEVEL_MIN,
    AUDIO_CONSOLE_ROOM_LEVEL_MAX,
    AUDIO_CONSOLE_DAMPING_MIN,
    AUDIO_CONSOLE_DAMPING_MAX,
    AUDIO_CONSOLE_PRE_DELAY_MAX,
    AUDIO_CONSOLE_STEREO_WIDTH_MIN,
    AUDIO_CONSOLE_STEREO_WIDTH_MAX,
    AUDIO_CONSOLE_Q_MIN,
    AUDIO_CONSOLE_Q_MAX,
    AUDIO_CONSOLE_GLOBAL_GAIN_MIN,
    AUDIO_CONSOLE_GLOBAL_GAIN_MAX,
    AUDIO_CONSOLE_THRESHOLD_MIN,
    AUDIO_CONSOLE_THRESHOLD_MAX,
    AUDIO_CONSOLE_RATIO_MIN,
    AUDIO_CONSOLE_RATIO_MAX,
    AUDIO_CONSOLE_ATTACK_MIN,
    AUDIO_CONSOLE_ATTACK_MAX,
    AUDIO_CONSOLE_RELEASE_MIN,
    AUDIO_CONSOLE_RELEASE_MAX,
    AUDIO_CONSOLE_KNEE_MIN,
    AUDIO_CONSOLE_KNEE_MAX,
    AUDIO_CONSOLE_CROSSOVER_MIN,
    AUDIO_CONSOLE_CROSSOVER_MAX,
    AUDIO_CONSOLE_CROSSOVER_RATIO,
    AUDIO_CONSOLE_CROSSFEED_MIN,
    AUDIO_CONSOLE_CROSSFEED_MAX,
    AUDIO_CONSOLE_ROTATION_MIN,
    AUDIO_CONSOLE_ROTATION_MAX,
    AUDIO_CONSOLE_BASS_MONO_MAX,
    AUDIO_CONSOLE_SATURATION_DRIVE_MIN,
    AUDIO_CONSOLE_SATURATION_DRIVE_MAX,
    AUDIO_CONSOLE_SATURATION_OUTPUT_MIN,
    AUDIO_CONSOLE_SATURATION_OUTPUT_MAX,
    AUDIO_CONSOLE_LIMITER_CEILING_MIN,
    AUDIO_CONSOLE_LIMITER_CEILING_MAX,
    AUDIO_CONSOLE_LIMITER_RELEASE_MIN,
    AUDIO_CONSOLE_LIMITER_RELEASE_MAX,
    AUDIO_CONSOLE_COMP_AMOUNT_MIN,
    AUDIO_CONSOLE_COMP_AMOUNT_MAX,
    AUDIO_CONSOLE_COMP_MAX_GAIN_MIN,
    AUDIO_CONSOLE_COMP_MAX_GAIN_MAX,
    AUDIO_CONSOLE_COMP_RESPONSE_MIN,
    AUDIO_CONSOLE_COMP_RESPONSE_MAX,
    AUDIO_CONSOLE_GATE_THRESHOLD_MIN,
    AUDIO_CONSOLE_GATE_THRESHOLD_MAX,
    AUDIO_CONSOLE_GATE_ATTACK_MIN,
    AUDIO_CONSOLE_GATE_ATTACK_MAX,
    AUDIO_CONSOLE_GATE_RELEASE_MIN,
    AUDIO_CONSOLE_GATE_RELEASE_MAX,
    AUDIO_CONSOLE_GATE_REDUCTION_MIN,
    AUDIO_CONSOLE_GATE_REDUCTION_MAX,
    AUDIO_CONSOLE_DEESS_FREQ_MIN,
    AUDIO_CONSOLE_DEESS_FREQ_MAX,
    AUDIO_CONSOLE_DEESS_THRESHOLD_MIN,
    AUDIO_CONSOLE_DEESS_THRESHOLD_MAX,
    AUDIO_CONSOLE_DEESS_RATIO_MIN,
    AUDIO_CONSOLE_DEESS_RATIO_MAX,
    AUDIO_CONSOLE_BASS_GAIN_MIN,
    AUDIO_CONSOLE_BASS_GAIN_MAX,
    AUDIO_CONSOLE_BASS_FREQ_MIN,
    AUDIO_CONSOLE_BASS_FREQ_MAX,
    AUDIO_CONSOLE_TONE_MIN,
    AUDIO_CONSOLE_TONE_MAX,
    AUDIO_CONSOLE_EXCITER_AMOUNT_MIN,
    AUDIO_CONSOLE_EXCITER_AMOUNT_MAX,
    AUDIO_CONSOLE_TRANSIENT_MIN,
    AUDIO_CONSOLE_TRANSIENT_MAX,
    AUDIO_CONSOLE_LOUDNESS_MIN,
    AUDIO_CONSOLE_LOUDNESS_MAX,
    AUDIO_CONSOLE_DEPLOSIVE_REDUCTION_MIN,
    AUDIO_CONSOLE_DEPLOSIVE_REDUCTION_MAX,
    AUDIO_CONSOLE_BALANCE_MIN,
    AUDIO_CONSOLE_BALANCE_MAX,
    AUDIO_CONSOLE_TARGET_LUFS_MIN,
    AUDIO_CONSOLE_TARGET_LUFS_MAX,
    AUDIO_CONSOLE_RESTORE_AMOUNT_MIN,
    AUDIO_CONSOLE_RESTORE_AMOUNT_MAX,
    AUDIO_CONSOLE_DYNEQ_FREQ_MIN,
    AUDIO_CONSOLE_DYNEQ_FREQ_MAX,
    AUDIO_CONSOLE_DYNEQ_AMOUNT_MIN,
    AUDIO_CONSOLE_DYNEQ_AMOUNT_MAX,
    AUDIO_CONSOLE_VOCAL_MIN,
    AUDIO_CONSOLE_VOCAL_MAX,
    AUDIO_CONSOLE_SCENE_AMOUNT_MIN,
    AUDIO_CONSOLE_SCENE_AMOUNT_MAX,
    AUDIO_CONSOLE_GENRES,
    AUDIO_CONSOLE_HEADPHONES,
    BAND_DEFAULTS,
    DEFAULT_AUDIO_CONSOLE_SETTINGS,
} from './defaults';

// 把旧存档和部分输入归一化为完整设置。
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

/**
 * 母带块的归一化：老存档没有 mastering 时整块按出厂值补齐。
 *
 * 与其余几块一样，第一件事永远是「确认它是个对象」——被手改过的存档可能把它写成数组或数字，
 * 直接读字段会抛异常，让整个调音台打不开。
 */
const normalizeMastering = (value: unknown): AudioConsoleMastering => {
    const root = asRecord(value);
    const compensation = asRecord(root.compensation);
    const noiseGate = asRecord(root.noiseGate);
    const deEsser = asRecord(root.deEsser);
    const dePlosive = asRecord(root.dePlosive);
    const bassBoost = asRecord(root.bassBoost);
    const exciter = asRecord(root.exciter);
    const transient = asRecord(root.transient);
    const tone = asRecord(root.tone);
    const loudness = asRecord(root.loudness);
    const balance = asRecord(root.balance);
    const studio = asRecord(root.studio);
    const normalize = asRecord(studio.normalize);
    const restore = asRecord(studio.restore);
    const advanced = asRecord(studio.advanced);
    const scene = asRecord(studio.scene);
    const defaults = DEFAULT_AUDIO_CONSOLE_SETTINGS.mastering;
    return {
        compensation: {
            enabled: readBoolean(compensation.enabled, defaults.compensation.enabled),
            amount: clamp(compensation.amount, AUDIO_CONSOLE_COMP_AMOUNT_MIN, AUDIO_CONSOLE_COMP_AMOUNT_MAX, defaults.compensation.amount),
            maxGainDb: clamp(compensation.maxGainDb, AUDIO_CONSOLE_COMP_MAX_GAIN_MIN, AUDIO_CONSOLE_COMP_MAX_GAIN_MAX, defaults.compensation.maxGainDb),
            responseMs: clamp(compensation.responseMs, AUDIO_CONSOLE_COMP_RESPONSE_MIN, AUDIO_CONSOLE_COMP_RESPONSE_MAX, defaults.compensation.responseMs),
        },
        noiseGate: {
            enabled: readBoolean(noiseGate.enabled, defaults.noiseGate.enabled),
            thresholdDb: clamp(noiseGate.thresholdDb, AUDIO_CONSOLE_GATE_THRESHOLD_MIN, AUDIO_CONSOLE_GATE_THRESHOLD_MAX, defaults.noiseGate.thresholdDb),
            attackMs: clamp(noiseGate.attackMs, AUDIO_CONSOLE_GATE_ATTACK_MIN, AUDIO_CONSOLE_GATE_ATTACK_MAX, defaults.noiseGate.attackMs),
            releaseMs: clamp(noiseGate.releaseMs, AUDIO_CONSOLE_GATE_RELEASE_MIN, AUDIO_CONSOLE_GATE_RELEASE_MAX, defaults.noiseGate.releaseMs),
            reductionDb: clamp(noiseGate.reductionDb, AUDIO_CONSOLE_GATE_REDUCTION_MIN, AUDIO_CONSOLE_GATE_REDUCTION_MAX, defaults.noiseGate.reductionDb),
        },
        deEsser: {
            enabled: readBoolean(deEsser.enabled, defaults.deEsser.enabled),
            frequencyHz: clamp(deEsser.frequencyHz, AUDIO_CONSOLE_DEESS_FREQ_MIN, AUDIO_CONSOLE_DEESS_FREQ_MAX, defaults.deEsser.frequencyHz),
            thresholdDb: clamp(deEsser.thresholdDb, AUDIO_CONSOLE_DEESS_THRESHOLD_MIN, AUDIO_CONSOLE_DEESS_THRESHOLD_MAX, defaults.deEsser.thresholdDb),
            ratio: clamp(deEsser.ratio, AUDIO_CONSOLE_DEESS_RATIO_MIN, AUDIO_CONSOLE_DEESS_RATIO_MAX, defaults.deEsser.ratio),
        },
        dePlosive: {
            enabled: readBoolean(dePlosive.enabled, defaults.dePlosive.enabled),
            reductionDb: clamp(dePlosive.reductionDb, AUDIO_CONSOLE_DEPLOSIVE_REDUCTION_MIN, AUDIO_CONSOLE_DEPLOSIVE_REDUCTION_MAX, defaults.dePlosive.reductionDb),
        },
        bassBoost: {
            enabled: readBoolean(bassBoost.enabled, defaults.bassBoost.enabled),
            gainDb: clamp(bassBoost.gainDb, AUDIO_CONSOLE_BASS_GAIN_MIN, AUDIO_CONSOLE_BASS_GAIN_MAX, defaults.bassBoost.gainDb),
            frequencyHz: clamp(bassBoost.frequencyHz, AUDIO_CONSOLE_BASS_FREQ_MIN, AUDIO_CONSOLE_BASS_FREQ_MAX, defaults.bassBoost.frequencyHz),
        },
        exciter: {
            enabled: readBoolean(exciter.enabled, defaults.exciter.enabled),
            amount: clamp(exciter.amount, AUDIO_CONSOLE_EXCITER_AMOUNT_MIN, AUDIO_CONSOLE_EXCITER_AMOUNT_MAX, defaults.exciter.amount),
            mix: clamp(exciter.mix, 0, 1, defaults.exciter.mix),
        },
        transient: {
            enabled: readBoolean(transient.enabled, defaults.transient.enabled),
            amount: clamp(transient.amount, AUDIO_CONSOLE_TRANSIENT_MIN, AUDIO_CONSOLE_TRANSIENT_MAX, defaults.transient.amount),
        },
        tone: {
            air: clamp(tone.air, AUDIO_CONSOLE_TONE_MIN, AUDIO_CONSOLE_TONE_MAX, defaults.tone.air),
            presence: clamp(tone.presence, AUDIO_CONSOLE_TONE_MIN, AUDIO_CONSOLE_TONE_MAX, defaults.tone.presence),
            warmth: clamp(tone.warmth, AUDIO_CONSOLE_TONE_MIN, AUDIO_CONSOLE_TONE_MAX, defaults.tone.warmth),
            clarity: clamp(tone.clarity, AUDIO_CONSOLE_TONE_MIN, AUDIO_CONSOLE_TONE_MAX, defaults.tone.clarity),
        },
        loudness: {
            enabled: readBoolean(loudness.enabled, defaults.loudness.enabled),
            amount: clamp(loudness.amount, AUDIO_CONSOLE_LOUDNESS_MIN, AUDIO_CONSOLE_LOUDNESS_MAX, defaults.loudness.amount),
        },
        balance: {
            enabled: readBoolean(balance.enabled, defaults.balance.enabled),
            value: clamp(balance.value, AUDIO_CONSOLE_BALANCE_MIN, AUDIO_CONSOLE_BALANCE_MAX, defaults.balance.value),
        },
        studio: {
            normalize: {
                enabled: readBoolean(normalize.enabled, defaults.studio.normalize.enabled),
                targetLufs: clamp(normalize.targetLufs, AUDIO_CONSOLE_TARGET_LUFS_MIN, AUDIO_CONSOLE_TARGET_LUFS_MAX, defaults.studio.normalize.targetLufs),
                truePeak: readBoolean(normalize.truePeak, defaults.studio.normalize.truePeak),
            },
            restore: {
                declick: readBoolean(restore.declick, defaults.studio.restore.declick),
                hum: readBoolean(restore.hum, defaults.studio.restore.hum),
                denoise: readBoolean(restore.denoise, defaults.studio.restore.denoise),
                amount: clamp(restore.amount, AUDIO_CONSOLE_RESTORE_AMOUNT_MIN, AUDIO_CONSOLE_RESTORE_AMOUNT_MAX, defaults.studio.restore.amount),
            },
            advanced: {
                dynamicEq: readBoolean(advanced.dynamicEq, defaults.studio.advanced.dynamicEq),
                dynamicEqFreq: clamp(advanced.dynamicEqFreq, AUDIO_CONSOLE_DYNEQ_FREQ_MIN, AUDIO_CONSOLE_DYNEQ_FREQ_MAX, defaults.studio.advanced.dynamicEqFreq),
                dynamicEqAmount: clamp(advanced.dynamicEqAmount, AUDIO_CONSOLE_DYNEQ_AMOUNT_MIN, AUDIO_CONSOLE_DYNEQ_AMOUNT_MAX, defaults.studio.advanced.dynamicEqAmount),
                vocalBoost: clamp(advanced.vocalBoost, AUDIO_CONSOLE_VOCAL_MIN, AUDIO_CONSOLE_VOCAL_MAX, defaults.studio.advanced.vocalBoost),
            },
            scene: {
                genre: AUDIO_CONSOLE_GENRES.includes(scene.genre as typeof AUDIO_CONSOLE_GENRES[number])
                    ? scene.genre as typeof AUDIO_CONSOLE_GENRES[number]
                    : defaults.studio.scene.genre,
                compare: readBoolean(scene.compare, defaults.studio.scene.compare),
                headphone: AUDIO_CONSOLE_HEADPHONES.includes(scene.headphone as typeof AUDIO_CONSOLE_HEADPHONES[number])
                    ? scene.headphone as typeof AUDIO_CONSOLE_HEADPHONES[number]
                    : defaults.studio.scene.headphone,
                amount: clamp(scene.amount, AUDIO_CONSOLE_SCENE_AMOUNT_MIN, AUDIO_CONSOLE_SCENE_AMOUNT_MAX, defaults.studio.scene.amount),
            },
        },
    };
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
    // 老存档没有 mastering 时整块按出厂值补齐；新存档则逐字段夹紧，防止手改的数值越界。
    const mastering = normalizeMastering(root.mastering);
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
            crossfeed: clamp(stereo.crossfeed, AUDIO_CONSOLE_CROSSFEED_MIN, AUDIO_CONSOLE_CROSSFEED_MAX, defaults.stereo.crossfeed),
            rotation: clamp(stereo.rotation, AUDIO_CONSOLE_ROTATION_MIN, AUDIO_CONSOLE_ROTATION_MAX, defaults.stereo.rotation),
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
        mastering,
    };
};
