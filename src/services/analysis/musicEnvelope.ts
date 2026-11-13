import { getFromCache, saveToCache } from '../db';
import { MUSIC_ENVELOPE_PREFIX } from './beatGridKeys';
import { joinStemRun, stemRunReached } from './stemRun';

// src/services/analysis/musicEnvelope.ts
// 一首歌的四条音乐包络：低频（bass 轨）、人声（vocals 轨）、其余乐器（other 轨）、整体（混音）。
//
// 为什么要它们：智能动感模式原先只有两种驱动 —— beat_this 的拍点，和 htdemucs 鼓轨上的鼓点。
// 于是画面能「跟着鼓动」，却不会唱歌、不会随低频下沉、不会在副歌亮起来。这四条曲线就是
// 那三件事的原料：低频管脉动与下沉，人声管光与色温，整体能量管明暗与景深，other 轨管
// 和声/旋律变化带来的结构位移。
//
// 成本几乎为零：htdemucs 本来就一次吐四轨（drums/bass/other/vocals），原先只拷 drums，
// 现在多拷三份，推理时间一模一样；每轨只交回每 50ms 一个 RMS 值（四分钟约 60KB），
// 波形一个字节都不过桥。分离本身与鼓点共用同一次任务（stemRun.ts），不会跑两遍。
//
// 与人的听感对齐要做的两件事：
//   · 归一化 —— 交回的是绝对 RMS，整首歌（或者已分离到的部分）的 97 分位当成 1。
//     这里不能按块拉满：否则前奏和副歌一样亮，画面就失去起伏。
//   · 平滑 —— 20fps 的 RMS 直接读会有台阶，采样时取当前时刻往前 0.15 秒的平均。
//     采样是纯函数（只看时间），拖进度条、暂停之后画面一致。

/** 一条曲线。 */
export type MusicEnvelopeKind = 'bass' | 'vocals' | 'other' | 'energy';

export interface MusicEnvelope {
    /** 每秒多少帧（原生给 20）。 */
    fps: number;
    /** 以下四条都是绝对 RMS，长度相同。 */
    bass: Float32Array;
    vocals: Float32Array;
    other: Float32Array;
    energy: Float32Array;
    /** 已经覆盖到第几秒；没有这个字段 = 整曲。 */
    until?: number;
}

/** 包络的版本：曲线含义变了就加一，旧记录不再读。 */
const ENVELOPE_VERSION = 1;

/** 归一化的分位：整首歌里最响的那一小撮当成 1。 */
const TOP_SHARE = 0.97;

/** 采样时往回平均多少帧（0.15 秒）。 */
const SMOOTH_SECONDS = 0.15;

/** 每这么多秒落一次盘：切歌或退出之后，下次从这里接着算。 */
const SAVE_SECONDS = 30;

const isMusicEnvelope = (value: unknown): value is MusicEnvelope => {
    const entry = value as (MusicEnvelope & { version?: number }) | null;
    if (!entry || entry.version !== ENVELOPE_VERSION) return false;
    return Number.isFinite(entry.fps) && entry.fps > 0
        && entry.bass instanceof Float32Array && entry.vocals instanceof Float32Array
        && entry.other instanceof Float32Array && entry.energy instanceof Float32Array;
};

/** Per key, the envelopes in memory this session, the most recent kept. */
const envelopes = new Map<string, MusicEnvelope>();
const MAX_TRACKS = 8;

const keep = (key: string, envelope: MusicEnvelope) => {
    envelopes.delete(key);
    envelopes.set(key, envelope);
    while (envelopes.size > MAX_TRACKS) {
        const oldest = envelopes.keys().next().value;
        if (oldest === undefined) break;
        envelopes.delete(oldest);
    }
};

/** 这首歌的包络（可能只有前几段），没有就 null。画面每帧调它，必须是同步的。 */
export const getMusicEnvelope = (key: string | null): MusicEnvelope | null => (key ? envelopes.get(key) ?? null : null);

/** 归一用的「顶点」，按曲线缓存：97 分位要排序，不能每帧算一次。 */
const tops = new WeakMap<MusicEnvelope, Partial<Record<MusicEnvelopeKind, number>>>();

const topOf = (envelope: MusicEnvelope, kind: MusicEnvelopeKind): number => {
    const cached = tops.get(envelope);
    if (cached?.[kind] !== undefined) return cached[kind]!;
    const track = envelope[kind];
    let top = 0;
    if (track.length) {
        const sorted = track.slice().sort();
        top = sorted[Math.min(sorted.length - 1, Math.floor(TOP_SHARE * sorted.length))];
    }
    const entry = cached ?? {};
    entry[kind] = top;
    tops.set(envelope, entry);
    return top;
};

/**
 * 曲线在 `seconds` 处的值，0..1（对该曲自己归一），带 0.15 秒的平滑。
 * 超出已分离范围时给出最后一个值，未知时 0。
 */
export const sampleMusicEnvelope = (
    envelope: MusicEnvelope,
    kind: MusicEnvelopeKind,
    seconds: number,
): number => {
    const track = envelope[kind];
    if (!track.length) return 0;
    const top = topOf(envelope, kind);
    if (!(top > 1e-6)) return 0;
    const last = track.length - 1;
    const end = Math.min(last, Math.max(0, Math.floor(seconds * envelope.fps)));
    const span = Math.max(1, Math.round(SMOOTH_SECONDS * envelope.fps));
    const from = Math.max(0, end - span + 1);
    let sum = 0;
    for (let frame = from; frame <= end; frame += 1) sum += track[frame];
    return Math.min(1, sum / (end - from + 1) / top);
};

/**
 * 把 `tail` 放到整条曲线的第 `startFrame` 帧上。
 *
 * 按**帧位置**放，而不是简单追加：两张听众可能在不同的起点发起分离（一个人从 0，一个人从
 * 缓存里半份的位置），块到达的顺序也就未必首尾相接。缺口补 0，重叠部分丢掉 —— 时间轴必须
 * 按秒对齐，否则后面每一条曲线都是错的。
 */
const place = (head: Float32Array, tail: Float32Array, startFrame: number): Float32Array => {
    if (!tail.length) return head;
    const at = Math.max(0, Math.round(startFrame));
    const skip = Math.max(0, head.length - at);
    if (skip >= tail.length) return head;
    const take = tail.subarray(skip);
    const gap = Math.max(0, at - head.length);
    const out = new Float32Array(head.length + gap + take.length);
    out.set(head, 0);
    out.set(take, head.length + gap);
    return out;
};

/**
 * 收下一块（一段音频的四条曲线）。
 *
 * `block.untilSec` 是这块到第几秒，存进 `until`：半份也要能读，下次播放从那里接着算。
 */
export const ingestMusicEnvelope = (key: string, block: {
    fps: number;
    bass: Float32Array;
    vocals: Float32Array;
    other: Float32Array;
    energy: Float32Array;
    fromSec: number;
    untilSec: number;
}): MusicEnvelope => {
    const known = envelopes.get(key);
    // 帧率变了（旧记录、旧包）就不接，免得两条曲线的时间轴错位。
    const head = known && known.fps === block.fps ? known : null;
    const startFrame = block.fromSec * block.fps;
    const envelope: MusicEnvelope = {
        fps: block.fps,
        bass: place(head?.bass ?? new Float32Array(0), block.bass, startFrame),
        vocals: place(head?.vocals ?? new Float32Array(0), block.vocals, startFrame),
        other: place(head?.other ?? new Float32Array(0), block.other, startFrame),
        energy: place(head?.energy ?? new Float32Array(0), block.energy, startFrame),
        until: Math.max(block.untilSec, (head?.bass.length ?? 0) / block.fps),
    };
    keep(key, envelope);
    return envelope;
};

/** 存一份。半份存 `until`，整曲不带（下一次读到就知道要从头补还是接上）。 */
const store = async (key: string, envelope: MusicEnvelope): Promise<void> => {
    try {
        await saveToCache(`${MUSIC_ENVELOPE_PREFIX}${key}`, { version: ENVELOPE_VERSION, ...envelope });
    } catch (error) {
        console.warn(`[MusicEnvelope] ${key}: cache write failed`, error);
    }
};

/** 已经存着的包络（半份也交），没有就 null。 */
export const loadStoredMusicEnvelope = async (key: string): Promise<MusicEnvelope | null> => {
    const known = envelopes.get(key);
    if (known) return known;
    try {
        const stored = await getFromCache<MusicEnvelope & { version?: number }>(`${MUSIC_ENVELOPE_PREFIX}${key}`);
        if (!isMusicEnvelope(stored)) return null;
        const envelope: MusicEnvelope = {
            fps: stored.fps,
            bass: stored.bass,
            vocals: stored.vocals,
            other: stored.other,
            energy: stored.energy,
            ...(typeof stored.until === 'number' && Number.isFinite(stored.until) && stored.until > 0 ? { until: stored.until } : {}),
        };
        keep(key, envelope);
        return envelope;
    } catch (error) {
        console.warn(`[MusicEnvelope] ${key}: cache read failed`, error);
        return null;
    }
};

/** 这首歌已经存到第几秒（没有则 0）。 */
export const musicEnvelopeReached = async (key: string): Promise<number> => {
    const stored = await loadStoredMusicEnvelope(key);
    if (!stored) return 0;
    return stored.until ?? stored.bass.length / stored.fps;
};

export interface MusicEnvelopeRunOptions {
    /** 还要不要继续（切歌、画面切走、效果关掉）。 */
    wanted: () => boolean;
}

/**
 * 读这首歌的包络：库里有就先交出来（半份也交），同时在后台加入/发起那次分离把剩下的补上。
 *
 * 与鼓点共用同一次分离（stemRun.ts）—— 所以这里不关心"谁先到"，两边的块由同一次推理产出。
 * 每 30 秒落一次盘：切歌或退出之后，下次从这里接着算，不用从头再来。
 */
export const loadTrackMusicEnvelope = async (
    key: string,
    url: string,
    options: MusicEnvelopeRunOptions,
): Promise<MusicEnvelope | null> => {
    const stored = await loadStoredMusicEnvelope(key);
    if (stored && stored.until === undefined) return stored;

    const startFrom = stored?.until ?? 0;
    // 上一次播放留下的半份，从这里接着分离。
    const reached = stemRunReached(key);
    const from = Math.max(startFrom, reached ?? 0);
    let lastSaved = from;

    void joinStemRun(key, url, {
        wanted: options.wanted,
        onBlock: (block) => {
            const curves = block.envelopes;
            if (!curves) return;
            const envelope = ingestMusicEnvelope(key, {
                fps: curves.fps,
                bass: curves.bass,
                vocals: curves.vocals,
                other: curves.other,
                energy: curves.energy,
                fromSec: block.fromSec,
                untilSec: block.untilSec,
            });
            const until = envelope.bass.length / envelope.fps;
            if (until - lastSaved >= SAVE_SECONDS) {
                lastSaved = until;
                void store(key, envelope);
            }
        },
        onDone: (outcome) => {
            const envelope = envelopes.get(key);
            if (!envelope) return;
            // 走到尾（或至少前进了）才算整曲：被取消时保留 `until`，下次接着补。
            const complete = Boolean(outcome) && !outcome!.cancelled && outcome!.seconds > 0;
            const final: MusicEnvelope = complete
                ? { fps: envelope.fps, bass: envelope.bass, vocals: envelope.vocals, other: envelope.other, energy: envelope.energy }
                : envelope;
            keep(key, final);
            void store(key, final);
            console.info(`[MusicEnvelope] ${key}: ${(final.bass.length / final.fps).toFixed(0)}s of curves${complete ? ' (whole track)' : ''}`);
        },
    }, from);

    return stored;
};
