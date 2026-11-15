import { melSpectrogramOffThread } from '../automix/analysisOffThread';
import { getFromCache, removeFromCache, saveToCache } from '../db';
import { BEAT_THIS_FPS, BEAT_THIS_SAMPLE_RATE } from './beatThis';
import {
    DRUM_HAT, DRUM_KICK, DRUM_SNARE, DRUMLESS_COVERAGE, drumBandTracks, drumCoverage, ENERGY_HOP, energyFrames, isDrumAnalysis,
    LIVE_EVERY_MS, LIVE_MIN_SECONDS, liveTailFrames, MIX_DRUM_REGULARIZE, pickBandHits, regularizeDrumHits, SHARE_WINDOW,
    type DrumAnalysis, type DrumHits,
} from './drumHitPicking';
import { DRUM_HITS_PREFIX } from './beatGridKeys';
import { createDrumBandStream, streamNeedsFrom, type DrumBands } from './drumHitStream';
import { drumStemSegments, startDrumStem, type DrumStemProgress } from './drumStem';
import type { StemReader } from './stemPass';
import { runTrackStems, setWantedStemTrack, stemTrackWanted, type StemTask } from './trackStemRun';
import { dropStemDrums, setStemDrumsKeptListener } from './stemRange';
import { HTDEMUCS_GPU_SEGMENT } from './beatThisGpu';
import { modelCanRun } from './modelAvailability';
import { decodeAtRate } from './trackAudio';
import { decodeTrackAtRate } from './trackBytes';
import { analyzeDrumBandsNativeFromUrl, cancelNativeSeparation, isNativeModelsAvailable } from '../automix/nativeModels';
import { joinStemRun } from './stemRun';
import { waitForForeground } from '../../utils/foregroundYield';

// src/services/analysis/drumHits.ts
// A whole track's drum hits, read off htdemucs' drum stem (drumStem.ts, the renderer's GPU) and kept:
// in memory, on disk under the track's analysis key (DRUM_HITS_PREFIX, registered with the beat lists
// in services/repositories/cacheRepository.ts as analysis data), and in flight for as long as one run
// is going - the layering of beatGrid.ts. 时计 plays them under 智能动感模式
// (components/visualizer/pendolo/usePendoloBeatFx.ts): the user found the drums' own hits far truer
// than any rule over beat_this' beats (2026-10-17).
//
// The hits themselves, and the drumless guard, are worked out in drumHitPicking.ts.
//
// GPU only, and only with htdemucs_gpu installed (`canRunDrumStem`): without them there are no hits,
// and 时计 plays beat_this' beats as it always did. A separation takes ~15 s of GPU for a four-minute
// track, so it runs only for the wanted track (`setWantedDrumTrack`) and stops at its next segment
// once another is wanted - skipping through tracks does not queue their separations up. The wanted
// track is the one 智能动感模式 plays while it is on (hooks/useBeatFxTrack.ts), not only while 时计 is
// on screen: a separation stopped on a picture switch threw away what it had, and coming back to 时计
// separated the track again from the start. Under 智能动感模式's `cached` nothing separates: only a
// stored analysis is read (`loadStoredDrumHits`), and switching to it stops a separation as leaving the
// track does - its hits so far go with it (the `finally` in loadTrackDrumHits).
// (From the PR #750 review: the two sentences above on a picture switch are PR #734's; since the
// analysis service's 2b a picture switch stops the separation again, and it keeps where it was and
// the hits so far (DrumResume) to carry on from - see the note at the end of hooks/useBeatFxTrack.ts.)
//
// A track separating now has hits before it is done: the stem is read as its head is finished
// (drumHitStream.ts), and about once a second (LIVE_EVERY_MS) the hits so far are picked again and
// handed over with `until`, the time they reach. Picked again, not appended: a band's loud hits
// (HIT_TOP), which every strength is a share of, are known only over what has been heard, so each
// pick rescales what came before - online softmax's running normaliser, and the hits ahead of the
// playhead are the better for it. The drumless guard is the same, over the head so far, and only
// from LIVE_MIN_SECONDS of it: before that, 时计 plays the beats. Separation runs far ahead of
// playback (some 15x on an M-series GPU), so the hits are there in about a second, and the stored
// analysis is the last pick - the whole track's.

// What callers have always imported from here.
export {
    DRUM_HAT, DRUM_KICK, DRUM_SNARE, DRUMLESS_COVERAGE, drumBandTracks, drumCoverage, energyFrames, pickBandHits, pickDrumHits,
} from './drumHitPicking';
export type { DrumAnalysis, DrumHitKind, DrumHits } from './drumHitPicking';

/** htdemucs' rate. A change to the stem or the picking bumps the version in DRUM_HITS_PREFIX. */
const STEM_RATE = 44100;
/** The drum hits' kind on a track's stem run (trackStemRun.ts). */
export const DRUM_HITS_TASK = 'drum hits';

/**
 * Whether a drum **stem** can be had here: the real htdemucs separation.
 *
 * 只有桌面有：htdemucs_gpu 已安装，且有可用的 WebGPU。
 *
 * 安卓不算 —— 那边的原生 onnxruntime 能跑 htdemucs，但一段 3.9 秒的音频要 4～8 秒，
 * 比播放慢，分离永远追不上播放头（详见 `loadMixDrumHits` 的头注释）。安卓的鼓点
 * 因此改从混音的频带取，不走分轨；这里回答 false，连带让人声分轨（雾笺）也不再
 * 在手机上启动一条追不上的慢路径。
 */
export const canRunDrumStem = (): boolean => {
    if (isNativeModelsAvailable()) return false;
    return typeof window !== 'undefined'
        && typeof window.electron?.getHtdemucsGpuWeights === 'function'
        && typeof navigator !== 'undefined' && 'gpu' in navigator
        && modelCanRun('htdemucs_gpu');
};

/** 44.1 kHz mono to the 22.05 kHz beat_this rate, by the browser's own resampler; the vocal envelope's too (vocalStemRun.ts). */
export const resampleStem = async (signal: Float32Array): Promise<Float32Array> => {
    const length = Math.ceil(signal.length * BEAT_THIS_SAMPLE_RATE / STEM_RATE);
    const context = new OfflineAudioContext(1, length, BEAT_THIS_SAMPLE_RATE);
    const source = context.createBufferSource();
    const input = context.createBuffer(1, signal.length, STEM_RATE);
    input.copyToChannel(signal as Float32Array<ArrayBuffer>, 0);
    source.buffer = input;
    source.connect(context.destination);
    source.start();
    return (await context.startRendering()).getChannelData(0);
};


/** Per key, the hits 时计 plays, set once a track's analysis is in and it has drums. */
const hitLists = new Map<string, DrumHits>();
const runs = new Map<string, Promise<DrumAnalysis | null>>();
/** Hit lists kept in memory; the analyses themselves are on disk. */
const MAX_TRACKS = 24;

/*
 * 给设置页那一行状态用的订阅。
 *
 * 「时计不动」在画面上只有一种表现，原因却有五六种。状态行已经能说「只吃鼓点」，
 * 但用户看不出鼓点到底是**还没读**、**读到一半**还是**读完了**。这三个都能从
 * 下面这个快照同步读出来，于是不必再让用户去翻日志。
 */
const hitListeners = new Set<() => void>();

/** Subscribes to the hit lists changing (a live pick, a completed analysis). */
export const subscribeDrumHits = (listener: () => void): (() => void) => {
    hitListeners.add(listener);
    return () => {
        hitListeners.delete(listener);
    };
};

const notifyDrumHits = (): void => {
    for (const listener of hitListeners) listener();
};

/**
 * 鼓点读到哪一步了。
 *
 * 这一行存在的理由：`正在从混音里读鼓点…` 在界面上是一个**静止**的状态 —— 取音频（在线曲目
 * 要先拿直链、整曲下载）、解码（一首四分钟的歌在 WebView 里要几秒到几十秒）、挑鼓点，三段
 * 加起来新手机会等半分钟，而这半分钟里一个字都不变，用户只会以为卡死了。
 * 分开说之后，至少知道它在哪一段、有没有往前走。
 */
export type DrumStage = 'bytes' | 'decode' | 'pick' | 'no-bytes';

const stages = new Map<string, DrumStage>();

/** 进入某一段；`null` 清掉（分析完成或放弃）。 */
export const setDrumStage = (key: string, stage: DrumStage | null): void => {
    if (stage === null) {
        if (!stages.delete(key)) return;
    } else {
        if (stages.get(key) === stage) return;
        stages.set(key, stage);
    }
    notifyDrumHits();
};

/** The step `key`'s drum hits are at, if a read is running. */
export const getDrumStage = (key: string | null): DrumStage | null => (key ? stages.get(key) ?? null : null);

/**
 * A stable string for `key`'s hits: how many, how far they reach (`until`, empty once the whole track
 * is picked), and the step a read is at when there are none yet. A string so `useSyncExternalStore`
 * sees the same value until something changes.
 */
export const drumHitsSnapshot = (key: string | null): string => {
    const hits = key ? hitLists.get(key) : undefined;
    const stage = key ? stages.get(key) : undefined;
    const base = hits
        ? `${hits.times.length}|${hits.until === undefined ? '' : hits.until.toFixed(1)}`
        : '0|';
    return stage ? `${base}|${stage}` : base;
};

/** Reads a `drumHitsSnapshot` back. */
export const parseDrumHitsSnapshot = (snapshot: string): { count: number; until: number | null; stage: DrumStage | null } => {
    const [count, until, stage] = snapshot.split('|');
    const known: DrumStage[] = ['bytes', 'decode', 'pick', 'no-bytes'];
    return {
        count: Number(count) || 0,
        until: until ? Number(until) : null,
        stage: known.includes(stage as DrumStage) ? (stage as DrumStage) : null,
    };
};


/**
 * Names the track whose drum hits are wanted now, or null for none (it was left, or 智能动感模式 is
 * off). Set when a picture asks for the hits; cleared when it is left - the track changes, the
 * picture switches (since the analysis service's 2b: the separation stops and keeps where it was, see
 * DrumResume) or the switch goes off.
 */
export const setWantedDrumTrack = (key: string | null): void => {
    setWantedStemTrack(key);
};

/** The drum hits of `key`, or null when the track has none (yet, or drumless). */
export const getDrumHits = (key: string | null): DrumHits | null => (key ? hitLists.get(key) ?? null : null);

/**
 * Keys whose analysis is in (separated to the end, or read from the store), drumless ones included:
 * nothing separates them again, so automix's drums for them are not kept (stemRange.ts, from the PR
 * #750 review). Kept apart from `hitLists`, which holds no drumless track and only MAX_TRACKS; a key is
 * a short string, so this keeps many more.
 */
const settled = new Set<string>();
const MAX_SETTLED = 1024;

/** Whether `key`'s drum hits are in, whole: its separation will not run again. */
export const drumHitsSettled = (key: string): boolean => settled.has(key);

/** Keys already looked up in the store for `lookInStore`, so each is read at most once. */
const lookedUp = new Set<string>();

/**
 * Drums kept for a track not settled this session (stemRange.ts): its analysis may be stored from an
 * earlier one. Read once; if it is, it settles like any read from the store, and the drums go.
 */
const lookInStore = (key: string) => {
    if (settled.has(key) || lookedUp.has(key)) return;
    lookedUp.add(key);
    while (lookedUp.size > MAX_SETTLED) {
        const oldest = lookedUp.keys().next().value;
        if (oldest === undefined) break;
        lookedUp.delete(oldest);
    }
    void loadStoredDrumHits(key);
};
setStemDrumsKeptListener(lookInStore);

/**
 * Forgets which tracks settled and were looked up, for when the stored analyses are cleared (the
 * settings' 分析 cache): a track judged in from a store that is now empty would otherwise have its
 * drums go unkept for the rest of the session (from the review of the PR #750 fixes).
 */
export const forgetSettledDrumHits = (): void => {
    settled.clear();
    lookedUp.clear();
};

const keep = (key: string, hits: DrumHits) => {
    /*
     * 混音的鼓点在这里收一遍（见 drumHitPicking.ts 的 `regularizeDrumHits`）：
     * 混音里贝斯与人声的起音也会落进 kick / snare 的频带，不收敛的话鼓面被敲得
     * 比拍点密好几倍，听感上就是「鼓点和动感模式一个快一个慢」。
     * 真分轨（桌面 htdemucs）不经过这里：它本来就是鼓，规整只会抹平演奏。
     */
    const shaped = usesMixBands() ? regularizeDrumHits(hits, MIX_DRUM_REGULARIZE) : hits;
    hitLists.delete(key);
    hitLists.set(key, shaped);
    while (hitLists.size > MAX_TRACKS) {
        const oldest = hitLists.keys().next().value;
        if (oldest === undefined) break;
        hitLists.delete(oldest);
    }
    notifyDrumHits();
};

const remember = (key: string, analysis: DrumAnalysis, note: string, complete = true) => {
    const coverage = drumCoverage(analysis.drumEnergy, analysis.mixEnergy);
    const counted = [0, 0, 0];
    analysis.hits.kinds.forEach((kind) => { counted[kind] += 1; });
    const drumless = coverage < DRUMLESS_COVERAGE;
    console.info(`[DrumHits] ${key}: ${drumless ? 'drumless' : `${analysis.hits.times.length} hits`} | drum coverage ${coverage.toFixed(3)} | kick ${counted[DRUM_KICK]} snare ${counted[DRUM_SNARE]} hat ${counted[DRUM_HAT]} | ${note}`);
    // A track whose head looked drummed may still be judged drumless as a whole: its live hits go.
    if (drumless) {
        hitLists.delete(key);
        notifyDrumHits();
    } else keep(key, analysis.hits);
    /*
     * 只有整曲算完才算「结算」：半份（`hits.until` 有值）只是先拿来用，
     * 后面的块还会到 —— 把它记成结算，会把还在跑的分析当成已经结束。
     */
    if (!complete) return;
    settled.delete(key);
    settled.add(key);
    while (settled.size > MAX_SETTLED) {
        const oldest = settled.keys().next().value;
        if (oldest === undefined) break;
        settled.delete(oldest);
    }
    dropStemDrums(key);
};

/**
 * What a separation stopped part way keeps, to carry on from (analysis service plan, 2b): the hits it
 * had, and of everything else only what the rest needs - the stem from where the band stream and the
 * energy will read it again up to the last sample a separated segment reached, the bands and the
 * drum energy so far (only as far as they go), and the next segment (no weight since the stem pass:
 * stemPass.ts works it out at each sample). Some 0.4 MB plus about 0.3 KB per second separated, against the ~80 MB the decoded
 * track and the stem take while separating, which are let go. In memory only: a track not finished is
 * never stored, and after a restart it separates from the start.
 */
interface DrumResume {
    total: number;
    next: number;
    divided: number;
    tailStart: number;
    /** The stem in [tailStart, reached): divided up to `divided`, a running sum past it. */
    drums: Float32Array;
    /** The bands of the frames before `done`. */
    bands: DrumBands;
    done: number;
    /** The drum energy's cells up to the one `measured` reaches into. */
    drumEnergy: Float32Array;
    measured: number;
    hits: DrumHits | null;
}
const resumes = new Map<string, DrumResume>();
/** The tracks whose separation can carry on, the most recently stopped kept. */
const MAX_RESUMES = 4;

const keepResume = (key: string, resume: DrumResume) => {
    resumes.delete(key);
    resumes.set(key, resume);
    while (resumes.size > MAX_RESUMES) {
        const oldest = resumes.keys().next().value;
        if (oldest === undefined) break;
        resumes.delete(oldest);
    }
};

/**
 * The drum hits as a task on the track's stem run (trackStemRun.ts): one drum reader on its pass, the
 * whole stem laid into `progress.drums`; the live picks as segments come in, the analysis at the end,
 * and what carries it on when the run stops first (DrumResume) - the stopped run's own `resume` taken
 * up here when it was of this decode's length.
 */
const drumHitsTask = (key: string, resume: DrumResume | null): StemTask<DrumAnalysis | null> => ({
    kind: DRUM_HITS_TASK,
    open: ({ left, right }) => {
        const started = performance.now();
        const total = left.length;
        const mix = new Float32Array(total);
        for (let at = 0; at < total; at += 1) mix[at] = (left[at] + right[at]) / 2;
        const mixEnergy = energyFrames(mix);
        const drumEnergy = new Float32Array(mixEnergy.length);
        let measured = 0;
        const progress = startDrumStem(total);
        // Carried on only from a stop of this very decode's length; anything else starts again.
        const from = resume && resume.total === total ? resume : null;
        if (resume && !from) console.info(`[DrumHits] ${key}: the track decodes to another length than when it stopped, separating from the start`);
        if (from) {
            progress.drums.set(from.drums, from.tailStart);
            progress.next = from.next;
            progress.divided = from.divided;
            drumEnergy.set(from.drumEnergy);
            measured = from.measured;
            console.info(`[DrumHits] ${key}: carrying on from ${(from.divided / STEM_RATE).toFixed(1)}s`);
        }
        // Kept until this run stops again (and keeps its own) or finishes: a run that throws loses nothing.
        if (resume && !from) resumes.delete(key);
        const stream = createDrumBandStream(total, { resample: resampleStem, mel: melSpectrogramOffThread, bands: drumBandTracks }, from ? { bands: from.bands, done: from.done } : undefined);
        // The hits of the head so far, for 时计 while the rest separates (see the header).
        const pickLive = async (drums: Float32Array, final: number) => {
            for (; measured < final; measured += 1) drumEnergy[Math.floor(measured / ENERGY_HOP)] += drums[measured] * drums[measured];
            await stream.advance(drums, final, false);
            if (!stemTrackWanted(key)) return;
            const windows = Math.floor(final / ENERGY_HOP / SHARE_WINDOW) * SHARE_WINDOW;
            if (drumCoverage(drumEnergy.subarray(0, windows), mixEnergy.subarray(0, windows)) < DRUMLESS_COVERAGE) {
                hitLists.delete(key);
                notifyDrumHits();
                return;
            }
            const until = Math.max(0, stream.done - liveTailFrames()) / BEAT_THIS_FPS;
            const hits = pickBandHits(stream.bands, stream.done);
            const count = hits.times.findIndex(time => time >= until);
            const head = count < 0 ? hits.times.length : count;
            if (!shown) {
                shown = true;
                console.info(`[DrumHits] ${key}: live hits ${((performance.now() - started) / 1000).toFixed(1)}s in, to ${until.toFixed(1)}s of the track`);
            }
            keep(key, {
                times: hits.times.slice(0, head),
                strengths: hits.strengths.slice(0, head),
                kinds: hits.kinds.slice(0, head),
                until,
            });
        };
        let shown = false;
        let live: Promise<void> | null = null;
        let liveAt = -Infinity;
        const reader: StemReader = {
            source: 'drums',
            next: progress.next,
            divided: progress.divided,
            window: { samples: progress.drums, base: 0 },
            read: (final) => {
                progress.next = reader.next;
                progress.divided = final;
                if (!live && final >= LIVE_MIN_SECONDS * STEM_RATE && performance.now() - liveAt >= LIVE_EVERY_MS) {
                    liveAt = performance.now();
                    live = pickLive(progress.drums, final)
                        .catch(error => console.warn(`[DrumHits] ${key}: live hits failed`, error))
                        .finally(() => { live = null; });
                }
                // The whole stem stays: the live picks read it after the segment is in.
                return 0;
            },
        };
        return {
            readers: [reader],
            finish: async () => {
                await live;
                const drums = progress.drums;
                // The energy the live picks summed so far, finished to the end: the same sums in the same order
                // as `energyFrames(drums)`, so the same bits, without the stem's head (gone after a resume).
                for (; measured < drums.length; measured += 1) drumEnergy[Math.floor(measured / ENERGY_HOP)] += drums[measured] * drums[measured];
                await stream.advance(drums, drums.length, true);
                const analysis: DrumAnalysis = {
                    hits: pickBandHits(stream.bands, stream.frames),
                    drumEnergy,
                    mixEnergy,
                };
                resumes.delete(key);
                remember(key, analysis, `separated in ${((performance.now() - started) / 1000).toFixed(1)}s`);
                await saveToCache(`${DRUM_HITS_PREFIX}${key}`, analysis);
                return analysis;
            },
            stop: async () => {
                await live;
                if (!stemTrackWanted(key)) console.info(`[DrumHits] ${key}: separation stopped at ${(progress.divided / STEM_RATE).toFixed(1)}s, the track or the picture was left`);
                if (progress.next > 0) await stopForLater(key, progress, stream, drumEnergy, measured, total);
                return null;
            },
        };
    },
});

/**
 * Keeps what a separation stopped at a segment boundary needs to carry on (DrumResume): the energy and
 * the bands brought up to what is final, then the stem from where they will read it next.
 */
const stopForLater = async (
    key: string,
    progress: DrumStemProgress,
    stream: ReturnType<typeof createDrumBandStream>,
    drumEnergy: Float32Array,
    measuredSoFar: number,
    total: number,
) => {
    let measured = measuredSoFar;
    const { drums, divided, next } = progress;
    for (; measured < divided; measured += 1) drumEnergy[Math.floor(measured / ENERGY_HOP)] += drums[measured] * drums[measured];
    try {
        await stream.advance(drums, divided, false);
    } catch (error) {
        console.warn(`[DrumHits] ${key}: could not keep where it stopped`, error);
        return;
    }
    const starts = drumStemSegments(total);
    // The last sample a separated segment reached: past it the sum is all zeros.
    const reached = Math.min(total, starts[next - 1] + HTDEMUCS_GPU_SEGMENT);
    const tailStart = Math.min(streamNeedsFrom(stream.done), measured, divided);
    keepResume(key, {
        total,
        next,
        divided,
        tailStart,
        drums: drums.slice(tailStart, reached),
        bands: [stream.bands[0].slice(0, stream.done), stream.bands[1].slice(0, stream.done), stream.bands[2].slice(0, stream.done)],
        done: stream.done,
        drumEnergy: drumEnergy.slice(0, Math.ceil(measured / ENERGY_HOP)),
        measured,
        hits: getDrumHits(key),
    });
};

/**
 * 安卓：不跑 htdemucs，直接拿**混音**的三个频带当鼓点。
 *
 * 为什么必须换一条路（真机实测的结论，不是猜的）：
 *   · htdemucs 一段 3.9 秒的音频，桌面 8 核 CPU 上 0.85 秒；手机上（2 线程、大核更少）
 *     要 4～8 秒。一首四分钟的歌 60 多段，合计 4～8 分钟；
 *   · 而分离是**边播边分**的：播放头 3.9 秒走完一段，分离却要 4～8 秒才出一段，
 *     于是 `until`（已分到的时间）永远落在播放头后面，`getDrumHits` 里没有一个
 *     落在"当前时间"上的 hit —— 仿真鼓面一动不动。用户看到的就是「时计没效果」。
 *
 * 混音上直接取频带没有这个问题：整曲解码一次（不到一秒），每 10 秒做一次 mel
 * （worker 里，几十到几百毫秒），第一个 10 秒的 hits 半秒内就到手，全程快于播放。
 *
 * 代价是准确度：混音的低频带里有贝斯，中频带里有人声和钢琴，高频带里有镲和齿音 ——
 * 这些起音都会被记成 kick / snare / hat。鼓面因此比真分轨"忙"一些，但**跟着音乐动**，
 * 而且桌面（真 htdemucs_gpu）的行为一点没变：这条只在安卓生效，缓存在独立的前缀下。
 *
 * 桌面那条路（`drumHitsTask` + `runTrackStems`）原样保留。
 */
const MIX_HITS_PREFIX = `${DRUM_HITS_PREFIX}mix_`;
/** 每读这么多秒，重挑一次 hits 交出去（见上面：第一个 10 秒半秒内就到手）。 */
const MIX_CHUNK_SECONDS = 10;

/** 分块分析期间，每隔这么多秒把已挑出的鼓点落一次盘（见 `savedTo`）。 */
const PARTIAL_SAVE_SECONDS = 30;

/** 等这首歌的音频最多这么久（见 `readWithTimeout`）：在线直链失效时不再无限等。 */
const READ_BYTES_TIMEOUT_MS = 90_000;

/** 安卓的混音频带分析：读字节、解码、分块取 mel、边算边交（见上面）。 */
const loadMixDrumHits = async (
    key: string,
    readBytes: () => Promise<ArrayBuffer | null>,
    nativeUrl: string | null = null,
): Promise<DrumAnalysis | null> => {
    const started = performance.now();
    /*
     * ★ 先试原生：解码 + mel 都在 Kotlin 里做，一两秒出整曲的频带。
     *
     * WebView 的 `decodeAudioData` 解一首四分钟的歌要几秒到几十秒，那段时间鼓面只能停着；
     * 而原生用 MediaCodec（播放器本来就在用），四分钟的歌一两秒。
     * 只回传三条频带，挑点仍是下面的 `pickBandHits` —— 起音判据只有一份。
     * 原生不可用（旧 APK、非在线曲目、解码失败）就落到下面那条 WebView 的路。
     */
    if (nativeUrl) {
        setDrumStage(key, 'decode');
        const native = await analyzeDrumBandsNativeFromUrl(nativeUrl);
        if (native && stemTrackWanted(key)) {
            setDrumStage(key, 'pick');
            /*
             * `drumCoverage` 要的两条能量在这里没有：原生只回传频带。
             * 给一对相等的 1 —— 覆盖率因此是 1（「有鼓」），这和混音路径本来的结论一致：
             * 混音里总能挑出鼓点，从来没有「这首歌没有鼓」这个分支。
             */
            const analysis: DrumAnalysis = {
                hits: pickBandHits(native.bands, native.frames),
                drumEnergy: Float32Array.of(1),
                mixEnergy: Float32Array.of(1),
            };
            remember(key, analysis, `native bands in ${((performance.now() - started) / 1000).toFixed(1)}s (${native.seconds.toFixed(1)}s of audio)`);
            await saveToCache(`${MIX_HITS_PREFIX}${key}`, analysis);
            // 混音这份已经能播了：后台把鼓轨分离出来，一块一块换成更准的。
            void refineDrumHitsWithStem(key, nativeUrl);
            return analysis;
        }
        console.info(`[DrumHits] ${key}: native drum bands unavailable, falling back to the WebView decode`);
    }
    const bytes = await readBytes();
    if (!bytes) {
        console.info(`[DrumHits] ${key}: mix bands need the track's bytes, none read yet`);
        return null;
    }
    if (!stemTrackWanted(key)) return null;
    setDrumStage(key, 'decode');
    const buffer = await decodeTrackAtRate(key, STEM_RATE, bytes, decodeAtRate, 'drum-mix', 'own');
    if (!buffer) {
        console.info(`[DrumHits] ${key}: mix bands could not decode the track`);
        setDrumStage(key, 'no-bytes');
        return null;
    }
    const left = buffer.getChannelData(0);
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
    const total = left.length;
    // 单声道解码（WebView 常见）就不必再复制一份：一首四分钟的歌那是 42MB。
    let mix = left;
    if (buffer.numberOfChannels > 1) {
        const mono = new Float32Array(total);
        for (let at = 0; at < total; at += 1) mono[at] = (left[at] + right[at]) / 2;
        mix = mono;
    }
    const mixEnergy = energyFrames(mix);
    const stream = createDrumBandStream(total, { resample: resampleStem, mel: melSpectrogramOffThread, bands: drumBandTracks });
    const step = MIX_CHUNK_SECONDS * STEM_RATE;
    let announced = false;
    /*
     * 上一次落盘的进度（秒）。
     *
     * 每 10 秒挑一次就写一次盘太频繁（四分钟的歌 24 次），而只在整曲结束时写又等于
     * 中途切歌就白算 —— 所以每 30 秒（以及最后一块）存一次：下次播放先读这一份，
     * 接着往后续，不必从第一个 10 秒重新挑。
     */
    let savedTo = 0;
    setDrumStage(key, 'pick');
    for (let at = 0; at < total; at += step) {
        /*
         * The track (or the picture) was left: the rest is not read.
         *
         * 后台也一样：没人看着画面时，这一整首歌的 mel 没有理由继续算 ——
         * 桌面端关掉了后台节流，不定在这里就会在兜里把四分钟的活干完。
         * 等回前台接着算，结果完全相同。
         */
        const wanted = await waitForForeground(() => stemTrackWanted(key));
        if (!wanted) {
            console.info(`[DrumHits] ${key}: mix bands stopped at ${(at / STEM_RATE).toFixed(1)}s, the track or the picture was left`);
            return null;
        }
        const final = Math.min(total, at + step);
        const end = final >= total;
        await stream.advance(mix, final, end);
        const until = end ? total / STEM_RATE : Math.max(0, stream.done - liveTailFrames()) / BEAT_THIS_FPS;
        const hits = pickBandHits(stream.bands, stream.done);
        // 与真分轨的 live pick 同样的截断：末尾几帧的峰可能被下一帧盖过，先不交出去。
        const head = (() => {
            const count = hits.times.findIndex(time => time >= until);
            return count < 0 ? hits.times.length : count;
        })();
        const chunk: DrumHits = {
            times: hits.times.slice(0, head),
            strengths: hits.strengths.slice(0, head),
            kinds: hits.kinds.slice(0, head),
            until,
        };
        keep(key, chunk);
        if (head > 0 && (end || until - savedTo >= PARTIAL_SAVE_SECONDS)) {
            savedTo = until;
            void saveToCache(`${MIX_HITS_PREFIX}${key}`, { hits: chunk, drumEnergy: mixEnergy, mixEnergy } satisfies DrumAnalysis);
        }
        if (!announced) {
            announced = true;
            console.info(`[DrumHits] ${key}: mix bands, first ${head} hits ${((performance.now() - started) / 1000).toFixed(1)}s in, to ${until.toFixed(1)}s of the track`);
        }
        // 让出主线程：一个 10 秒块算完立刻进下一块，会把画面帧挤掉。
        await new Promise<void>(resolve => { setTimeout(resolve, 0); });
    }
    const analysis: DrumAnalysis = {
        hits: pickBandHits(stream.bands, stream.frames),
        drumEnergy: mixEnergy,
        mixEnergy,
    };
    remember(key, analysis, `mix bands in ${((performance.now() - started) / 1000).toFixed(1)}s`);
    await saveToCache(`${MIX_HITS_PREFIX}${key}`, analysis);
    return analysis;
};

/** 正在跑的「用真鼓轨替换」：一首歌一次，切歌时停。 */
const stemRefines = new Map<string, Promise<void>>();

/**
 * 混音那份先顶上，后台再用 htdemucs 的**鼓轨**把鼓点换准。
 *
 * 为什么要接这一桥：混音里贝斯、人声、钢琴的起音都落在 kick / snare 的频带里，
 * 鼓面会被「不是鼓的东西」敲响；真鼓轨里只有鼓。代价是慢 —— 手机上一块 30 秒音频
 * 要几十秒推理 —— 所以它永远不在首屏那条路上：混音一两秒交付，这一条慢慢补，
 * 回来一块就替换一次，表只会更准。
 *
 * 不 await、不阻塞播放；`stemTrackWanted` 说不再要这首歌时立刻让原生停下。
 * `startFrom` 是缓存里那份半成品已经覆盖到的位置，从那里接着分离。
 */
const refineDrumHitsWithStem = (key: string, url: string, startFrom = 0): Promise<void> => {
    const running = stemRefines.get(key);
    if (running) return running;

    const run = (async () => {
        /*
         * 后台不跑。htdemucs 在手机上是满核几分钟的活，丢到后台等于把「听歌时发烫」
         * 重新引回来 —— 而它是「越准越好」而不是「不跑就没声音」，完全可以等前台再补。
         * 半成品留在缓存里，下次从那里接着分离。
         */
        if (typeof document !== 'undefined' && document.hidden) {
            console.info(`[DrumHits] ${key}: drum stem left for the foreground`);
            return;
        }
        // 让播放先稳下来：分离一起来就是满核，开头几秒留给解码与首屏。
        await new Promise<void>((resolve) => { setTimeout(resolve, 3000); });
        if (!stemTrackWanted(key)) return;

        const fps = BEAT_THIS_FPS;
        const offsetFrames = Math.max(0, Math.round(startFrom * fps));
        let bands: DrumBands = [
            new Float32Array(offsetFrames),
            new Float32Array(offsetFrames),
            new Float32Array(offsetFrames),
        ];
        let frames = offsetFrames;
        let lastSaved = startFrom;
        const started = performance.now();

        /*
         * 与四轨包络共用同一次分离（stemRun.ts）：同一首歌上，鼓点和智能动感的其他效果
         * 各自跑一遍 htdemucs，就是把满核几分钟翻倍，而模型本来就一次吐四轨。
         */
        const outcome = await joinStemRun(key, url, {
            // 切歌、或者退到后台：让原生在下一个窗口边界停下，下次从这块接着分离。
            wanted: () => stemTrackWanted(key) && !(typeof document !== 'undefined' && document.hidden),
            onBlock: (block) => {
                // 只有包络的块（这首歌这一段没有鼓）：鼓点这边没有可接的东西。
                if (block.frames <= 0) return;
                /*
                 * 只接「接着上一块末尾」的块。原生是按 fromSec 递增发的，正常不会断；
                 * 真断了（切后台被别的分析插队、某一块解码失败）就在这里停下 ——
                 * 已经接上的部分仍然可用，不必把整首歌作废。
                 */
                const expected = frames / block.fps;
                if (block.fromSec - expected > 0.5 || expected - block.fromSec > 0.5) {
                    console.info(`[DrumHits] ${key}: drum stem block at ${block.fromSec.toFixed(1)}s does not follow ${expected.toFixed(1)}s, stopping`);
                    void cancelNativeSeparation();
                    return;
                }
                const next: DrumBands = [
                    new Float32Array(frames + block.frames),
                    new Float32Array(frames + block.frames),
                    new Float32Array(frames + block.frames),
                ];
                for (let kind = 0; kind < 3; kind += 1) {
                    next[kind].set(bands[kind], 0);
                    next[kind].set(block.bands[kind].subarray(0, block.frames), frames);
                }
                bands = next;
                frames += block.frames;
                const until = frames / fps;
                const hits = pickBandHits(bands, frames);
                keep(key, { ...hits, until });
                // 每 30 秒落一次盘：切歌或退出之后，下次从这里接着分离。
                if (until - lastSaved >= PARTIAL_SAVE_SECONDS) {
                    lastSaved = until;
                    void saveToCache(`${DRUM_HITS_PREFIX}${key}`, {
                        hits: { ...hits, until },
                        drumEnergy: Float32Array.of(1),
                        mixEnergy: Float32Array.of(1),
                    } satisfies DrumAnalysis);
                }
            },
        }, startFrom);

        if (!outcome || outcome.cancelled || frames <= offsetFrames) return;
        const hits = pickBandHits(bands, frames);
        const analysis: DrumAnalysis = {
            hits,
            drumEnergy: Float32Array.of(1),
            mixEnergy: Float32Array.of(1),
        };
        remember(key, analysis, `separated drums in ${((performance.now() - started) / 1000).toFixed(1)}s`);
        await saveToCache(`${DRUM_HITS_PREFIX}${key}`, analysis);
        /*
         * 真鼓轨那份已经完整，混音那份就是次好的了：删掉，免得下次先命中它。
         * 删失败也无所谓 —— 读取时会先看真分轨这一份。
         */
        void removeFromCache(`${MIX_HITS_PREFIX}${key}`).catch(() => undefined);
    })().catch((error) => {
        console.warn(`[DrumHits] ${key}: drum stem refinement failed`, error);
    });

    stemRefines.set(key, run);
    void run.finally(() => {
        if (stemRefines.get(key) === run) stemRefines.delete(key);
    });
    return run;
};

/** 安卓上鼓点从混音频带取（见 `loadMixDrumHits`），缓存也分开存，免得和真分轨的结果混用。 */
const usesMixBands = (): boolean => isNativeModelsAvailable();

/**
 * A track's drum analysis from the cache only, never separated (智能动感模式's `cached`). Once it is
 * in, `getDrumHits(key)` answers its hits. Null when none is stored. A run in flight is not joined:
 * only `on` starts one, and leaving `on` stops it (`setWantedDrumTrack(null)`).
 */
export const loadStoredDrumHits = async (key: string): Promise<DrumAnalysis | null> => {
    try {
        const stored = await readStoredAnalysis(key);
        if (!stored) return null;
        // 半份也先用：`cached` 模式不跑分析，能拿到多少是多少，但不把它记成整曲。
        remember(key, stored.analysis, 'from the cache', stored.analysis.hits.until === undefined);
        return stored.analysis;
    } catch (error) {
        console.warn(`[DrumHits] ${key}: cache read failed`, error);
        return null;
    }
};

/**
 * A track's drum analysis: from the cache, joined from a run in flight, or a separation of
 * `readBytes`' bytes now (only when `canRunDrumStem`). Once it is in, `getDrumHits(key)` answers its
 * hits. Null when none can be had now, which is not remembered: a later play may find the bytes.
 * Separates only while `key` is the wanted track (`setWantedDrumTrack`).
 */
/**
 * 一首歌的分析可能存了两份：htdemucs 真分轨的鼓（`DRUM_HITS_PREFIX`）和混音的频带
 * （`MIX_HITS_PREFIX`）。真分轨那份干净得多，所以**先读它**；手上没有才退回混音。
 *
 * 这一条原来按平台二选一（安卓只读混音），结果是：分离过的歌再播一次，仍然要从混音
 * 重新算一遍 —— 用户看到的就是「每次都要重新分析」。
 */
const readStoredAnalysis = async (
    key: string,
): Promise<{ analysis: DrumAnalysis; fromStems: boolean } | null> => {
    const keys: Array<[string, boolean]> = usesMixBands()
        ? [[`${DRUM_HITS_PREFIX}${key}`, true], [`${MIX_HITS_PREFIX}${key}`, false]]
        : [[`${DRUM_HITS_PREFIX}${key}`, true]];
    for (const [cacheKey, fromStems] of keys) {
        const stored = await getFromCache<DrumAnalysis>(cacheKey);
        if (isDrumAnalysis(stored)) return { analysis: stored, fromStems };
    }
    return null;
};

/** 从库里读一份；半份也交出来（记成未结算），`partial` 说明后面还有。 */
const readCachedAnalysis = async (
    key: string,
): Promise<{ analysis: DrumAnalysis; partial: boolean; fromStems: boolean } | null> => {
    try {
        const stored = await readStoredAnalysis(key);
        if (!stored) return null;
        const partial = stored.analysis.hits.until !== undefined && !settled.has(key);
        remember(
            key,
            stored.analysis,
            partial ? `from ${stored.fromStems ? 'the drum stem' : 'the mix'}, to ${(stored.analysis.hits.until ?? 0).toFixed(0)}s` : 'from the cache',
            !partial,
        );
        return { analysis: stored.analysis, partial, fromStems: stored.fromStems };
    } catch (error) {
        console.warn(`[DrumHits] ${key}: cache read failed`, error);
        return null;
    }
};

/** 跑一次分离，不读库：手机上是混音频带，桌面上是真分轨。 */
const separate = async (
    key: string,
    readBytes: () => Promise<ArrayBuffer | null>,
    nativeUrl: string | null,
): Promise<DrumAnalysis | null> => {
    if (!stemTrackWanted(key)) return null;
    setDrumStage(key, 'bytes');
    /*
     * 取音频这一步也要有上限：在线曲目要先拿直链再整曲下载，直链失效或者网络卡住时
     * 这里会**一直**不回来 —— 界面上就是「正在从混音里读鼓点…」永远不变。
     * 90 秒还没到手就当作取不到，让界面说出「取不到这首歌的音频」而不是装作在忙。
     */
    const readWithTimeout = async (): Promise<ArrayBuffer | null> => {
        const bytes = await Promise.race([
            readBytes(),
            new Promise<null>((resolve) => { setTimeout(() => resolve(null), READ_BYTES_TIMEOUT_MS); }),
        ]);
        if (!bytes) setDrumStage(key, 'no-bytes');
        return bytes;
    };
    try {
        /*
         * 安卓走混音频带，桌边走真的 htdemucs 分轨（见 `loadMixDrumHits` 的头注释）：
         * 手机上的 htdemucs 比播放慢，鼓点永远追不上播放头，鼓面就一动不动。
         * 这条要在 `canRunDrumStem` 之前问：那个函数在安卓上回答 false。
         */
        if (usesMixBands()) {
            const result = await loadMixDrumHits(key, readWithTimeout, nativeUrl);
            setDrumStage(key, null);
            return result;
        }
        if (!canRunDrumStem()) {
            setDrumStage(key, null);
            return null;
        }
        setDrumStage(key, 'pick');
        // A separation stopped earlier: its hits play at once, while the track decodes again.
        const resume = resumes.get(key) ?? null;
        if (resume?.hits) keep(key, resume.hits);
        let analysis: DrumAnalysis | null = null;
        try {
            analysis = await runTrackStems(key, readWithTimeout, drumHitsTask(key, resume));
            setDrumStage(key, null);
            return analysis;
        } finally {
            // Hits put back from a stop, or picked live, and no analysis came (no bytes, no decode, a
            // separation left or failed part way): taken off again - a later play would read them as whole.
            if (!analysis && getDrumHits(key)?.until !== undefined) hitLists.delete(key);
        }
    } catch (error) {
        console.warn(`[DrumHits] ${key}: failed`, error);
        setDrumStage(key, 'no-bytes');
        return null;
    }
};

/**
 * A track's drum analysis: from the cache, joined from a run in flight, or a separation of
 * `readBytes`' bytes now (only when `canRunDrumStem`). Once it is in, `getDrumHits(key)` answers its
 * hits. Null when none can be had now, which is not remembered: a later play may find the bytes.
 * Separates only while `key` is the wanted track (`setWantedDrumTrack`).
 *
 * A list stored part way through (the mix path saves every 30 s of audio) is answered at once and
 * carried on in the background: the hits it has play now, and the rest arrives as it is picked.
 */
export const loadTrackDrumHits = (
    key: string,
    readBytes: () => Promise<ArrayBuffer | null>,
    nativeUrl: string | null = null,
): Promise<DrumAnalysis | null> => {
    const existing = runs.get(key);
    // Joined - but a run whose track was left and is wanted again before it reached its next segment
    // is stopping, and answers null: then one fresh run, rather than no hits for the rest of the play.
    // Only on null: a drumless track answers an analysis, and is not separated again.
    if (existing) {
        return existing.then(found => (found === null && stemTrackWanted(key) && !runs.has(key)
            ? loadTrackDrumHits(key, readBytes, nativeUrl)
            : found));
    }

    /*
     * 半份先交出去的那条路：`release` 一被调用，这一位调用方立刻拿到已有的那一段，
     * 而完整的那一次继续在后台跑 —— 同一个 key 后来的调用加入它，不另起一份。
     */
    let release!: (value: DrumAnalysis | null) => void;
    const half = new Promise<DrumAnalysis | null>((resolve) => { release = resolve; });

    const job = (async (): Promise<DrumAnalysis | null> => {
        const cached = await readCachedAnalysis(key);
        if (cached) {
            release(cached.analysis);
            // 整份已经到了，不用再算；半份则把剩下的接着补上。
            if (!cached.partial || !stemTrackWanted(key)) {
                /*
                 * 混音那份是完整的，但还没用真鼓轨分离过：这次播放（前台时）补上。
                 * 分离失败或没跑完都不要紧，下次播放还会再来。
                 */
                if (!cached.fromStems && nativeUrl) void refineDrumHitsWithStem(key, nativeUrl);
                return cached.analysis;
            }
            /*
             * 真鼓轨的半份：接着分离，而不是退回混音重算一遍。
             * 混音的半份则继续走下面的混音分析。
             */
            if (cached.fromStems && nativeUrl) {
                void refineDrumHitsWithStem(key, nativeUrl, cached.analysis.hits.until ?? 0);
                return cached.analysis;
            }
        }
        const full = await separate(key, readBytes, nativeUrl);
        release(full);
        return full;
    })();

    runs.set(key, job);
    // Only the run in flight is kept: an answer lives on in `hitLists` and on disk, a null is retried.
    void job.then(() => {
        if (runs.get(key) === job) runs.delete(key);
    });
    // 谁先到就用谁：存了半份就先交半份，整份到了再替换（播放端读到的表会跟着变长）。
    return Promise.race([job, half]);
};
