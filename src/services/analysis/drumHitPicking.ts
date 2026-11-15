import { BEAT_THIS_FPS, MEL_BANDS, melBandCentresHz, type MelSpectrogram } from './beatThis';
import type { DrumBands } from './drumHitStream';

// src/services/analysis/drumHitPicking.ts
// The drum hits' arithmetic, apart from running anything (split out of drumHits.ts, which separates
// and keeps them): the bands of a drum stem's spectrogram, the hits picked off them, and the energy
// the drumless guard compares.
//
// A hit is where the stem rises: each of three bands (kick below KICK_MAX_HZ, snare up to SNARE_MAX_HZ,
// hats from HAT_MIN_HZ) against that band's own loud hits (HIT_TOP), a hit wherever the largest of the
// three peaks (a local maximum over PEAK_HALF frames either side, at least MIN_HIT_GAP apart) above
// HIT_ONSET_FLOOR, filed under the band that rose most, as strong as that share (0..1).
//
// A track with next to no drums has none (`getDrumHits` null): htdemucs still hands back a stem, and
// in a track without drums it is what leaked in - a bass line read as kicks (雪绒花). The guard is how
// much of the track the drums play in (`drumCoverage`), not how loud they are on the median: a song
// with drums in only half of it (小半, 麦恩莉) reads near 0 on the median like 雪绒花. Measured on the
// user's 21 separated tracks (2026-10-17): Edelweiss 0.006, 理想三旬 0.024, 第二圆舞曲 0.043, then
// every track with a drum kit from 0.135 up (走马 0.148), so DRUMLESS_COVERAGE sits in that gap. The
// stem's and the mix's energy are stored beside the hits so the guard can be tuned without separating
// anything again.

export type DrumHitKind = 0 | 1 | 2;
export const DRUM_KICK: DrumHitKind = 0;
export const DRUM_SNARE: DrumHitKind = 1;
export const DRUM_HAT: DrumHitKind = 2;
export interface DrumHits {
    times: Float64Array;
    strengths: Float32Array;
    kinds: Uint8Array;
    /** While the track is still separating: the time (s) the hits reach, none after it known yet. */
    until?: number;
}

/** What one separation leaves behind: the hits, and the stem's and the mix's energy per ENERGY_HOP. */
export interface DrumAnalysis {
    hits: DrumHits;
    drumEnergy: Float32Array;
    mixEnergy: Float32Array;
}

/** The rise window around a frame, at 50 fps - the same as beatAccents.ts. */
const PEAK_BEFORE = 1;
const PEAK_AFTER = 2;
const BASE_FROM = 6;
const BASE_TO = 2;
const HIT_TOP = 0.99;
const HIT_ONSET_FLOOR = 0.15;
const PEAK_HALF = 3;
const MIN_HIT_GAP = 0.09;
const KICK_MAX_HZ = 150;
const SNARE_MAX_HZ = 4000;
const HAT_MIN_HZ = 6000;

/** Energy frames: 10 ms at 44.1 kHz. */
export const ENERGY_HOP = 441;
/** The coverage is counted over windows of this many energy frames (0.25 s)... */
export const SHARE_WINDOW = 25;
/** ...where the mix is louder than this share of its median window (silence and fades left out)... */
const SHARE_AUDIBLE = 0.05;
/** ...a window having drums when the stem holds at least this share of its energy (about -15 dB). */
const DRUMS_PLAYING_SHARE = 0.03;
/** A track whose drums play in less than this share of its audible windows is drumless. */
export const DRUMLESS_COVERAGE = 0.08;

/** A track still separating has hits from this much of its stem on (s); the guard needs a stretch. */
export const LIVE_MIN_SECONDS = 10;
/** And they are picked again about this often (ms) while it separates. */
export const LIVE_EVERY_MS = 1000;
/**
 * The last frames of the head are left out of a pick: a peak there may be beaten by one just after it
 * (PEAK_HALF, MIN_HIT_GAP), and a rise needs PEAK_AFTER frames past it.
 */
export const liveTailFrames = () => PEAK_AFTER + PEAK_HALF + Math.ceil(MIN_HIT_GAP * BEAT_THIS_FPS);

const quantile = (values: number[], q: number): number => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};

/** Per frame, the mean of the drum mel's bands centred in [fromHz, toHz). */
const bandTrack = (mel: MelSpectrogram, fromHz: number, toHz: number): Float32Array => {
    const bands = melBandCentresHz().map((hz, band) => (hz >= fromHz && hz < toHz ? band : -1)).filter(band => band >= 0);
    const out = new Float32Array(mel.frames);
    for (let frame = 0; frame < mel.frames; frame += 1) {
        let sum = 0;
        for (const band of bands) sum += mel.data[frame * MEL_BANDS + band];
        out[frame] = bands.length ? sum / bands.length : 0;
    }
    return out;
};

const riseAt = (track: Float32Array, frame: number): number => {
    let peak = 0;
    for (let at = frame - PEAK_BEFORE; at <= frame + PEAK_AFTER; at += 1) {
        if (at >= 0 && at < track.length) peak = Math.max(peak, track[at]);
    }
    let base = 0;
    let count = 0;
    for (let at = frame - BASE_FROM; at <= frame - BASE_TO; at += 1) {
        if (at >= 0 && at < track.length) { base += track[at]; count += 1; }
    }
    return Math.max(0, peak - (count ? base / count : 0));
};

/** A band's rise per frame as a share of its loud hits, capped at 1. */
const riseShares = (track: Float32Array): Float32Array => {
    const rise = new Float32Array(track.length);
    for (let frame = 0; frame < track.length; frame += 1) rise[frame] = riseAt(track, frame);
    // Sorted as a typed array: picked again every second while a track separates, on the UI thread.
    const loud = rise.filter(value => value > 0).sort();
    const top = (loud.length ? loud[Math.min(loud.length - 1, Math.floor(HIT_TOP * loud.length))] : 0) || 1;
    return rise.map(value => Math.min(1, value / top));
};

/** A drum stem spectrogram's kick, snare and hat bands per frame. */
export const drumBandTracks = (mel: MelSpectrogram): DrumBands => [
    bandTrack(mel, 0, KICK_MAX_HZ),
    bandTrack(mel, KICK_MAX_HZ, SNARE_MAX_HZ),
    bandTrack(mel, HAT_MIN_HZ, Infinity),
];

/** The hits of a drum stem's spectrogram (see the header). */
export const pickDrumHits = (mel: MelSpectrogram): DrumHits => pickBandHits(drumBandTracks(mel), mel.frames);

/** The hits of the first `frames` frames of a drum stem's three bands. */
export const pickBandHits = (tracks: DrumBands, frames: number): DrumHits => {
    const bands = tracks.map(track => riseShares(track.subarray(0, frames)));
    const top = new Float32Array(frames);
    const kindOf = new Uint8Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
        for (let kind = 0; kind < bands.length; kind += 1) {
            if (bands[kind][frame] > top[frame]) { top[frame] = bands[kind][frame]; kindOf[frame] = kind; }
        }
    }
    const times: number[] = [];
    const strengths: number[] = [];
    const kinds: number[] = [];
    for (let frame = 0; frame < frames; frame += 1) {
        const share = top[frame];
        if (share < HIT_ONSET_FLOOR) continue;
        let peak = true;
        for (let at = Math.max(0, frame - PEAK_HALF); at <= Math.min(frames - 1, frame + PEAK_HALF) && peak; at += 1) {
            if (top[at] > share || (top[at] === share && at < frame)) peak = false;
        }
        if (!peak) continue;
        const time = frame / BEAT_THIS_FPS;
        const last = times.length - 1;
        if (last >= 0 && time - times[last] < MIN_HIT_GAP) {
            if (share > strengths[last]) { times[last] = time; strengths[last] = share; kinds[last] = kindOf[frame]; }
            continue;
        }
        times.push(time);
        strengths.push(share);
        kinds.push(kindOf[frame]);
    }
    return { times: Float64Array.from(times), strengths: Float32Array.from(strengths), kinds: Uint8Array.from(kinds) };
};

/*
 * 混音路径的鼓点规整（`regularizeDrumHits`）。
 *
 * 为什么需要：真分轨里只有鼓，一节拍常常只有一个起音；混音里贝斯、人声、钢琴的起音
 * 都落在 kick / snare 的频带里，`MIN_HIT_GAP` 0.09 秒意味着**每秒最多 11 个** hit。
 * 于是同一段音乐，节拍特效按 beat_this 的拍点走（120 BPM 时 2 下/秒），仿真鼓面却被
 * 敲 4~6 下/秒 —— 用户的原话是「鼓点和动感模式总有一个慢一个快」。
 *
 * 规整做三件事：
 *   1. 从 kick / snare 的间隔自估**基本脉冲**（不需要拍点列表，时计只吃鼓点时不跑 beat_this）；
 *   2. 落在脉冲网格 ±SNAP 内的起音吸附到网格上，同一格只留最强的一个；
 *   3. 离网格远且不强的起音丢掉（那是贝斯的滑音、人声的辅音），强的保留（切分重音）。
 *
 * 帽子单独走：它本来就密（八分、十六分），只做最小间隔，不参与网格。
 */
export interface RegularizeDrumOptions {
    /** 起音吸附到脉冲网格的最大距离（秒）。 */
    snap: number;
    /** 网格外、强度低于此值的 body 起音丢掉。 */
    weakFloor: number;
    /** 帽子之间的最小间隔（秒）。 */
    hatGap: number;
    /** 指定脉冲周期（秒）；不给就从 hits 自己估。 */
    period?: number | null;
}

/** 混音路径的默认参数（见上面的注释）。 */
export const MIX_DRUM_REGULARIZE: RegularizeDrumOptions = {
    snap: 0.08,
    /*
     * 0.5 不是随手写的：混音里贝斯与人声漏进鼓频带的起音，强度大多落在 0.3~0.45
     * （它们没有鼓的瞬态）；真正的切分重音（军鼓反拍、tom）通常 0.6 以上。
     * 门槛压到 0.28 会把贝斯线全留下，鼓面又变密了。
     */
    weakFloor: 0.5,
    hatGap: 0.11,
};

/** 自估的脉冲周期限制在这个范围里：30~200 BPM 的拍长（含半拍）。 */
const PULSE_MIN = 0.15;
const PULSE_MAX = 1.1;
/** 少于这么多个 body 起音就不估：样本太少的众数是噪声。 */
const PULSE_MIN_HITS = 8;
/** 估周期时先只看这么强的 body 起音：真鼓比漏进来的贝斯、人声响。 */
const PULSE_STRONG = 0.55;

/**
 * 从 kick / snare 的相邻间隔里取众数，当作基本脉冲（秒）；样本不足或没有明显周期时 null。
 *
 * 直方图而不是中位数：切分多的歌里，一半间隔是八分音符、一半是四分音符，中位数会落在
 * 两者之间；众数至少落在一个真实的脉冲上。
 *
 * 先用强的起音估。混音里贝斯每 0.1 秒换一个音，弱的起音连成片，众数会落到 0.1 秒上 ——
 * 那等于「把每一根贝斯弦都当鼓敲」，比不规整还密。真鼓的起音强度明显高一截，用它估出来的
 * 才是鼓组的脉冲；强的样本不够时才退回全部起音。
 */
export const estimateDrumPulse = (
    times: Float64Array,
    kinds: Uint8Array,
    strengths?: Float32Array,
): number | null => {
    const estimate = (pickStrong: boolean): number | null => {
        const body: number[] = [];
        for (let at = 0; at < times.length; at += 1) {
            if (kinds[at] === DRUM_HAT) continue;
            if (pickStrong && strengths && strengths[at] < PULSE_STRONG) continue;
            body.push(times[at]);
        }
        if (body.length < PULSE_MIN_HITS) return null;
        const bin = 0.025;
        const counts = new Map<number, number>();
        for (let at = 1; at < body.length; at += 1) {
            const gap = body[at] - body[at - 1];
            if (gap < PULSE_MIN || gap > PULSE_MAX) continue;
            const slot = Math.round(gap / bin);
            counts.set(slot, (counts.get(slot) ?? 0) + 1);
        }
        let best = -1;
        let bestCount = 0;
        for (const [slot, count] of counts) {
            if (count > bestCount || (count === bestCount && slot < best)) {
                best = slot;
                bestCount = count;
            }
        }
        // 一个周期要站得住：至少四次重复，且占全部间隔的十分之一以上。
        const total = body.length - 1;
        if (best < 0 || bestCount < 4 || bestCount / total < 0.1) return null;
        return best * bin;
    };
    return estimate(true) ?? estimate(false);
};

/**
 * 把混音里读到的起音收成鼓组的脉冲（见上面的注释）。没有可信周期时只做密度控制。
 *
 * `until` 原样带过去：它说的是「hits 覆盖到哪」，规整只挪动几十毫秒。
 */
export const regularizeDrumHits = (hits: DrumHits, options: RegularizeDrumOptions = MIX_DRUM_REGULARIZE): DrumHits => {
    const count = hits.times.length;
    if (count === 0) return hits;
    /*
     * 先按时间排一遍。
     *
     * 上游的 pick 是有序的，但这个函数也会拿到「手拼」的列表（测试、缓存里的旧数据、
     * 以后接别的拾取器），而网格化是按相邻关系归格的 —— 一条乱序的输入会让两个
     * 本该合到一格的起音分别落进两格。
     */
    const order = Array.from({ length: count }, (_, index) => index).sort((left, right) => hits.times[left] - hits.times[right]);
    const times = Float64Array.from(order, index => hits.times[index]);
    const strengths = Float32Array.from(order, index => hits.strengths[index]);
    const kinds = Uint8Array.from(order, index => hits.kinds[index]);

    const period = options.period === undefined
        ? estimateDrumPulse(times, kinds, strengths)
        : options.period;
    const bodyTimes: number[] = [];
    const bodyStrengths: number[] = [];
    const bodyKinds: number[] = [];
    const hatTimes: number[] = [];
    const hatStrengths: number[] = [];
    let lastHat = -Infinity;

    for (let at = 0; at < count; at += 1) {
        const time = times[at];
        const strength = strengths[at];
        const kind = kinds[at];
        if (kind === DRUM_HAT) {
            // 帽子只留最小的间隔，密到听不出个数的那种一律收掉。
            if (time - lastHat < options.hatGap) {
                const last = hatTimes.length - 1;
                if (last >= 0 && strength > hatStrengths[last]) {
                    hatTimes[last] = time;
                    hatStrengths[last] = strength;
                    lastHat = time;
                }
                continue;
            }
            hatTimes.push(time);
            hatStrengths.push(strength);
            lastHat = time;
            continue;
        }
        bodyTimes.push(time);
        bodyStrengths.push(strength);
        bodyKinds.push(kind);
    }

    const outTimes: number[] = [];
    const outStrengths: number[] = [];
    const outKinds: number[] = [];
    if (!period || period <= 0 || bodyTimes.length === 0) {
        /*
         * 估不出周期：只做密度控制。
         *
         * 阈值不能再取 snap（0.08）：混音里贝斯换音就是 0.1 秒一下，全留下了。0.16 是
         * 「再快也不可能是鼓组的一拍」的下限 —— 375 BPM 的十六分才比这密。
         */
        const gap = Math.max(options.snap, 0.16);
        let last = -Infinity;
        for (let at = 0; at < bodyTimes.length; at += 1) {
            if (bodyTimes[at] - last < gap) {
                const index = outTimes.length - 1;
                if (index >= 0 && bodyStrengths[at] > outStrengths[index]) {
                    outTimes[index] = bodyTimes[at];
                    outStrengths[index] = bodyStrengths[at];
                    outKinds[index] = bodyKinds[at];
                    last = bodyTimes[at];
                }
                continue;
            }
            outTimes.push(bodyTimes[at]);
            outStrengths.push(bodyStrengths[at]);
            outKinds.push(bodyKinds[at]);
            last = bodyTimes[at];
        }
    } else {
        const phase = bodyTimes[0];
        const slotOf = (time: number) => Math.round((time - phase) / period);
        // 一拍里可能先来 kick 后来 snare：按格收集，最后每格留最强的一个。
        // 隔得远的格子分开记（切分重音不进 Map，免得和网格点抢同一格）。
        const slots = new Map<number, { time: number; strength: number; kind: number }>();
        for (let at = 0; at < bodyTimes.length; at += 1) {
            const time = bodyTimes[at];
            const slot = slotOf(time);
            const gridTime = phase + slot * period;
            const distance = Math.abs(time - gridTime);
            if (distance > options.snap) {
                // 不在网格上：只有够强才当切分重音留着，否则是别的乐器漏进来的起音。
                if (bodyStrengths[at] < options.weakFloor) continue;
                outTimes.push(time);
                outStrengths.push(bodyStrengths[at]);
                outKinds.push(bodyKinds[at]);
                continue;
            }
            const kept = slots.get(slot);
            if (!kept || bodyStrengths[at] > kept.strength) {
                slots.set(slot, { time: gridTime, strength: bodyStrengths[at], kind: bodyKinds[at] });
            }
        }
        for (const kept of slots.values()) {
            outTimes.push(kept.time);
            outStrengths.push(kept.strength);
            outKinds.push(kept.kind);
        }
    }

    for (let at = 0; at < hatTimes.length; at += 1) {
        outTimes.push(hatTimes[at]);
        outStrengths.push(hatStrengths[at]);
        outKinds.push(DRUM_HAT);
    }
    // 三组各自已经有序，合起来重排（帽子与 body 交错）。
    const finalOrder = outTimes.map((_, index) => index).sort((left, right) => outTimes[left] - outTimes[right]);
    return {
        times: Float64Array.from(finalOrder, index => outTimes[index]),
        strengths: Float32Array.from(finalOrder, index => outStrengths[index]),
        kinds: Uint8Array.from(finalOrder, index => outKinds[index]),
        ...(hits.until === undefined ? {} : { until: hits.until }),
    };
};

export const energyFrames = (signal: Float32Array): Float32Array => {
    const out = new Float32Array(Math.ceil(signal.length / ENERGY_HOP));
    for (let at = 0; at < signal.length; at += 1) out[Math.floor(at / ENERGY_HOP)] += signal[at] * signal[at];
    return out;
};

/**
 * How much of the track the drums play in: of the SHARE_WINDOW windows where the mix is audible, the
 * share whose stem holds DRUMS_PLAYING_SHARE of the energy. 0 for a silent track.
 */
export const drumCoverage = (drumEnergy: Float32Array, mixEnergy: Float32Array): number => {
    const windows: Array<{ drum: number; mix: number }> = [];
    for (let from = 0; from < mixEnergy.length; from += SHARE_WINDOW) {
        let drum = 0;
        let mix = 0;
        for (let at = from; at < Math.min(mixEnergy.length, from + SHARE_WINDOW); at += 1) {
            drum += drumEnergy[at] ?? 0;
            mix += mixEnergy[at];
        }
        windows.push({ drum, mix });
    }
    const floor = quantile(windows.map(window => window.mix), 0.5) * SHARE_AUDIBLE;
    const audible = windows.filter(window => window.mix > floor && window.mix > 0);
    if (!audible.length) return 0;
    return audible.filter(window => window.drum >= DRUMS_PLAYING_SHARE * window.mix).length / audible.length;
};

export const isDrumAnalysis = (value: unknown): value is DrumAnalysis => {
    const entry = value as DrumAnalysis | null;
    return Boolean(entry?.hits?.times instanceof Float64Array && entry.hits.strengths instanceof Float32Array
        && entry.hits.kinds instanceof Uint8Array && entry.drumEnergy instanceof Float32Array
        && entry.mixEnergy instanceof Float32Array);
};
