// src/utils/lyrics/autoAlignOffset.ts
//
// 自动校准：从音频本身估出「这一首的歌词整体该往前还是往后挪多少」。
//
// 思路很朴素 —— 歌词行的时间戳标的是「这一句开始唱」的那一刻。歌里人声真的进来的位置，
// 和这个时间戳之间通常有一个**整曲恒定**的差：有的源差几十毫秒，有的整首歌都偏半秒。
// 所以对每一行，在它前后一小段里找「声音突然起来」的位置（人声起唱的能量跃升），
// 拿「行时间戳 − 实际起唱」当作这一行的样本，全曲取中位数 —— 单行的噪声（鼓点、和声、
// 前一句的尾音）会被中位数吃掉，只有所有行都一致的那个偏移留下来。
//
// 为什么不用人声分离：htdemucs 那套要模型和 GPU，不是每台机器都有，而且一首歌几十秒。
// 这里只做一次 8 kHz 解码 + 带通滤波 + 能量包络（一首四分钟的歌约 1 秒），换来的精度
// 对「整曲偏移」这个自由度足够 —— 它本来就是个几十毫秒量级的数，不是逐字对齐。
//
// 估不出来就明确说估不出来（samples 太少、方向不一致、偏差太小），绝不硬套一个值：
// 自动校准一旦把一首本来对齐的歌调歪，比不校准更糟。

/** 参与估计的歌词行，只要求时间戳与文本 —— 与 Line 结构兼容。 */
export interface AutoAlignLine {
    startTime: number;
    endTime: number;
    fullText: string;
}

export type AutoAlignSkipReason =
    /** 可用的行太少（少于 minSamples），中位数没有意义。 */
    | 'not-enough-lines'
    /** 各行给出的偏移方向不一致：不是整曲偏移，可能是逐行错位或检测噪声。 */
    | 'low-confidence'
    /** 估出来的偏差小于听感阈值，没必要动。 */
    | 'negligible';

export interface AutoAlignResult {
    /** 建议应用到本曲的偏移（毫秒）。正数 = 歌词整体延后。未采用时为 0。 */
    offsetMs: number;
    /** 0..1：落在中位数 ±200 ms 内的行占比。 */
    confidence: number;
    /** 真正给出样本的行数。 */
    samples: number;
    applied: boolean;
    reason?: AutoAlignSkipReason;
}

export interface AutoAlignOptions {
    /** 人声进入的判定：能量跃升至少这么多 dB。 */
    minRiseDb?: number;
    /** 分析窗口：行首之前 / 之后各看多少秒。 */
    lookBehindSec?: number;
    lookAheadSec?: number;
    /** 至少多少行参与才下结论。 */
    minSamples?: number;
    /** 方向一致性下限。 */
    minConfidence?: number;
    /** 小于这个偏差就不改（听不出来，改了反而多一个变量）。 */
    minOffsetMs?: number;
    /** 大于这个偏差就不改：真实歌曲的整曲偏移很少超过半秒，再大基本是检测撞上了别的声音。 */
    maxOffsetMs?: number;
}

const DEFAULTS: Required<AutoAlignOptions> = {
    minRiseDb: 4,
    lookBehindSec: 0.7,
    lookAheadSec: 0.7,
    minSamples: 8,
    minConfidence: 0.6,
    minOffsetMs: 80,
    maxOffsetMs: 800,
};

/** 间奏占位行（`……`）不参与：它没有「唱」这回事。 */
const INTERLUDE_TEXT = '……';

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * RBJ biquad，直接作用在副本上。这里只需要「去掉低频鼓点、去掉高频齿音」，
 * Q 取 0.707（Butterworth）即可，听感/测量都不需要更陡的斜率。
 */
const applyBiquad = (
    input: Float32Array,
    sampleRate: number,
    frequency: number,
    type: 'lowpass' | 'highpass',
): Float32Array => {
    const output = new Float32Array(input.length);
    const w0 = (2 * Math.PI * frequency) / sampleRate;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * 0.707);
    const a0 = 1 + alpha;
    const b0 = type === 'lowpass' ? (1 - cos) / 2 : (1 + cos) / 2;
    const b1 = type === 'lowpass' ? 1 - cos : -(1 + cos);
    const b2 = b0;
    const a1 = -2 * cos;
    const a2 = 1 - alpha;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let index = 0; index < input.length; index += 1) {
        const x0 = input[index];
        const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
        output[index] = y0;
        x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    }
    return output;
};

/**
 * 人声频段的能量包络（dB），帧率 `fps`，每帧取两跳的窗（约 20 ms @ 100 fps）。
 *
 * 8 kHz 采样时人声在 250–3400 Hz 之间，把两头切掉之后，底鼓/贝斯那种「一直响着」的
 * 低频不再把每一行都填满 —— 行尾才找得到真正的落点。
 */
export const buildVocalBandEnvelope = (samples: Float32Array, sampleRate: number, fps = 100): Float32Array => {
    if (samples.length === 0 || sampleRate <= 0) {
        return new Float32Array(0);
    }
    const highPassed = applyBiquad(samples, sampleRate, 250, 'highpass');
    const bandLimited = applyBiquad(highPassed, sampleRate, Math.min(3400, sampleRate * 0.42), 'lowpass');
    const hop = Math.max(1, Math.round(sampleRate / fps));
    const window = hop * 2;
    const frames = Math.max(1, Math.floor(bandLimited.length / hop));
    const envelope = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
        const from = frame * hop;
        const to = Math.min(bandLimited.length, from + window);
        let sum = 0;
        for (let at = from; at < to; at += 1) {
            sum += bandLimited[at] * bandLimited[at];
        }
        envelope[frame] = 10 * Math.log10(sum / Math.max(1, to - from) + 1e-10);
    }
    return envelope;
};

const quantile = (values: number[], share: number): number => {
    if (values.length === 0) {
        return 0;
    }
    const sorted = values.slice().sort((left, right) => left - right);
    return sorted[clamp(Math.floor(share * sorted.length), 0, sorted.length - 1)];
};

const median = (values: number[]): number => quantile(values, 0.5);

/**
 * 用能量包络与歌词行估整曲偏移。
 *
 * 纯函数：包络由 `buildVocalBandEnvelope` 产出，测试里可以直接喂一条合成包络。
 */
export const estimateAutoAlign = (
    envelope: Float32Array,
    fps: number,
    lines: AutoAlignLine[],
    options: AutoAlignOptions = {},
): AutoAlignResult => {
    const config = { ...DEFAULTS, ...options };
    const empty = (reason: AutoAlignSkipReason): AutoAlignResult => ({
        offsetMs: 0, confidence: 0, samples: 0, applied: false, reason,
    });
    if (envelope.length < fps || lines.length === 0) {
        return empty('not-enough-lines');
    }

    // 全曲响度参考：只用「响的那部分」的分布，安静段落不会把它拉低。
    const reference = quantile(Array.from(envelope), 0.9);
    const riseFrames = Math.max(1, Math.round(fps * 0.04));
    const behindFrames = Math.round(config.lookBehindSec * fps);
    const aheadFrames = Math.round(config.lookAheadSec * fps);
    const deltas: number[] = [];

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.fullText.trim() || line.fullText.trim() === INTERLUDE_TEXT) {
            continue;
        }
        // 太短的行（气口、单字）起点容易被上一句的尾音盖住。
        if (line.endTime - line.startTime < 0.5) {
            continue;
        }

        const centre = Math.round(line.startTime * fps);
        const nextStart = lines[index + 1]?.startTime;
        const aheadLimit = nextStart === undefined
            ? aheadFrames
            : Math.min(aheadFrames, Math.max(0, Math.round((nextStart - line.startTime) * fps * 0.5)));
        const from = Math.max(riseFrames, centre - behindFrames);
        const to = Math.min(envelope.length - 1, centre + aheadLimit);
        if (to - from < riseFrames + 2) {
            continue;
        }

        let bestFrame = -1;
        let bestRise = 0;
        for (let frame = from; frame <= to; frame += 1) {
            // 人声起唱是「安静 → 有声」，所以只认上升到有声区的那些帧。
            if (envelope[frame] < reference - 26) {
                continue;
            }
            const rise = envelope[frame] - envelope[frame - riseFrames];
            if (rise > bestRise) {
                bestRise = rise;
                bestFrame = frame;
            }
        }
        if (bestFrame < 0 || bestRise < config.minRiseDb) {
            continue;
        }

        const delta = line.startTime - bestFrame / fps;
        // 超过一秒的差基本不是「整曲偏移」，是这一行本身标错了或撞上了别的声音。
        if (Math.abs(delta) <= 1) {
            deltas.push(delta);
        }
    }

    if (deltas.length < config.minSamples) {
        return { ...empty('not-enough-lines'), samples: deltas.length };
    }

    const centre = median(deltas);
    const inliers = deltas.filter(delta => Math.abs(delta - centre) <= 0.2).length;
    const confidence = inliers / deltas.length;
    const offsetMs = Math.round((centre * 1000) / 10) * 10;

    if (confidence < config.minConfidence) {
        return { offsetMs: 0, confidence, samples: deltas.length, applied: false, reason: 'low-confidence' };
    }
    if (Math.abs(offsetMs) < config.minOffsetMs) {
        return { offsetMs: 0, confidence, samples: deltas.length, applied: false, reason: 'negligible' };
    }
    if (Math.abs(offsetMs) > config.maxOffsetMs) {
        return { offsetMs: 0, confidence, samples: deltas.length, applied: false, reason: 'low-confidence' };
    }

    return { offsetMs, confidence, samples: deltas.length, applied: true };
};
