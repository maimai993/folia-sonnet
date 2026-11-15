import { getFromCache, saveToCache } from '../db';
import { melSpectrogramOffThread } from '../automix/analysisOffThread';
import { analyzeBeatsNative, analyzeBeatsNativeFromUrl, isNativeBeatAnalysisAvailable, type NativeBeat } from '../automix/nativeBeats';
import { analyseBeatGrid, canRunBeatThis, type BeatGrid } from './beatThis';
import { raiseGpuUrgency, runPercussiveEnergyGpu } from './beatThisGpu';
import type { Urgency } from './scheduler';
import { BEAT_GRID_PREFIX } from './beatGridKeys';
import { computeBeatAccents, formatBeatMeter, isBeatAccents, resolveBeatConfidence, type BeatAccents, type BeatMeter } from './beatAccents';

// src/services/analysis/beatGrid.ts
// A whole track's beats from Beat This!, run once and kept: on disk under the track's analysis key,
// and in flight for as long as one run is going.
//
// Two features want them and neither should pay twice. Automix's profile keeps only the collapsed
// `{offset, period}` grid, while 智能动感模式 needs every beat and downbeat; whichever asks
// first runs the model and stores the list, and the other reads it - or, if it asks while the run is
// still going, waits for that run instead of decoding and inferring the same track beside it. It is
// also what lets a replayed track have beat FX from its first second.
//
// Only whole tracks belong here: automix may measure just the head of a track that is still
// streaming, and a beat list that stops at twelve seconds would leave the FX silent for the rest.
// Such a caller runs `analyseBeatGrid` itself and stores nothing.
//
// One model, final0, for both: automix and the beat FX (智能动感模式) read the same list. (The beat FX
// once ran small0 and kept their own lists; those are left unread - beatGridKeys.ts.)
//
// A list also carries the beats' accents (beatAccents.ts) - how hard and how low or high each one
// hits - measured on the same spectrogram in the same run, whenever the run was the GPU's (it alone
// measures the percussive energy and hands back the logits the accents read). They are an optional
// field: a list stored by a CPU run, or before they existed, stays valid, and `getTrackBeatAccents`
// fills them in when the beat FX want them. Automix does not read them.
//
// The key prefix (beatGridKeys.ts) is registered in services/repositories/cacheRepository.ts as
// analysis data, so "clear analysis cache" clears these with the profiles they feed.

/** 原生推理退回「传样本」时的上限（见下方 native 分支）：桥与堆都撑不住整首歌。 */
const MAX_BRIDGE_SAMPLES = 1_000_000;

/** Bumped when the model, the spectrogram or the peak picking changes what a track's beats are. */
const BEAT_GRID_VERSION = 1;

interface StoredBeatGrid {
    version: number;
    beats: number[];
    downbeats: number[];
    accents?: BeatAccents;
    /**
     * 这份表完整到哪一秒。没有这个字段 = 整曲（旧记录都是整曲）。
     *
     * 分段交付时边算边存，所以要记下它还没到头：下次读到它先拿来用，再接着补。
     */
    until?: number;
}

/** A beat list, with its accents when they have been measured. */
export interface AccentedBeatGrid extends BeatGrid {
    accents?: BeatAccents;
}

const storageKey = (key: string) => `${BEAT_GRID_PREFIX}${key}`;

const isTimeList = (value: unknown): value is number[] =>
    Array.isArray(value) && value.every(time => typeof time === 'number' && Number.isFinite(time));

/**
 * A stored beat list and how far it reaches. `until` undefined means the whole track; a number is a
 * list picked part way through a run, kept so the next play starts from it instead of from zero.
 * Accents that do not fit the list (another version, another length) are left off rather than
 * failing the beats.
 */
const readStoredBeatGridEntry = async (
    key: string,
): Promise<{ grid: AccentedBeatGrid; until: number | undefined } | null> => {
    const stored = await getFromCache<StoredBeatGrid>(storageKey(key));
    if (!stored || stored.version !== BEAT_GRID_VERSION) return null;
    if (!isTimeList(stored.beats) || !isTimeList(stored.downbeats) || !stored.beats.length) return null;
    const grid: AccentedBeatGrid = { beats: stored.beats, downbeats: stored.downbeats };
    if (isBeatAccents(stored.accents, stored.beats.length)) grid.accents = stored.accents;
    const until = typeof stored.until === 'number' && Number.isFinite(stored.until) && stored.until > 0
        ? stored.until
        : undefined;
    return { grid, until };
};

/** The stored whole-track beat list for this analysis key, or null. */
export const readStoredBeatGrid = async (key: string): Promise<AccentedBeatGrid | null> =>
    (await readStoredBeatGridEntry(key))?.grid ?? null;

/**
 * Stores a beat list, with its accents if it has them; an empty one is not worth keeping.
 *
 * `until` marks a list picked part way through a run: it is still worth storing (the next play reads
 * it and carries on), but it must not be mistaken for the whole track. A finished run stores without
 * it, which replaces whatever partial list was there.
 */
export const storeBeatGrid = async (
    key: string,
    grid: AccentedBeatGrid,
    until?: number,
): Promise<void> => {
    if (!grid.beats.length) return;
    const entry: StoredBeatGrid = { version: BEAT_GRID_VERSION, beats: [...grid.beats], downbeats: [...grid.downbeats] };
    if (grid.accents && isBeatAccents(grid.accents, grid.beats.length)) entry.accents = grid.accents;
    if (until !== undefined && Number.isFinite(until) && until > 0) entry.until = until;
    await saveToCache(storageKey(key), entry);
};

interface Run {
    grid: Promise<AccentedBeatGrid | null>;
    cpuFallback: boolean;
}

const running = new Map<string, Run>();

export interface TrackBeatGridOptions {
    /**
     * Whether the CPU may take what the GPU cannot (see `analyseBeatGrid`). A caller that may not
     * can still be handed a list an earlier CPU run stored; it just never starts one.
     */
    cpuFallback?: boolean;
    /**
     * Never start a run (智能动感模式's `cached`): a stored list, or a run already in flight (automix's)
     * joined, or null - and `readMid` is never called, so nothing is decoded or read off a stream.
     */
    storedOnly?: boolean;
    /** How the GPU scheduler orders a run started here (scheduler.ts); automix's default, 'background'. */
    urgency?: Urgency;
    /**
     * 安卓原生推理的音频来源：本地绝对路径或 http(s) 地址，由原生自己解码。
     *
     * 给了就整首歌不过桥；没给（桌面、或这一首既没有路径也没有可用地址）才退到
     * `readMid` + `analyzeBeats` —— 那条路要把整首歌的 PCM 编成 base64，只适合短音频，
     * 见 automix/nativeBeats.ts 的 analyzeBeatsFromUrl 说明。
     */
    nativeSourceUrl?: () => Promise<string | null>;

    /**
     * 安卓原生分段交付：每算完一块（累积，从头到 `seconds`）回调一次。
     *
     * 只在原生那条路上有意义。整曲要二十秒以上，而第一块（45 秒）一两秒就好 ——
     * 调用方拿它先把画面点亮，整曲到了再替换。
     */
    onPartial?: (beats: NativeBeat[], seconds: number) => void;
}

/**
 * A whole track's beats: stored, joined from a run in flight, or run now. Null when the model could
 * not answer; a grid with no beats when it answered "none".
 *
 * `readMid` is called only when the model actually has to run - a stored list or a joined run never
 * decodes anything. It answers the track's mono (mid) samples at the Beat This! rate, or null when
 * they cannot be had, which is not remembered: a later call may find the bytes.
 *
 * A GPU-only run that came back null does not answer a caller allowed the CPU; that caller runs again
 * with the fallback, which is the one case two runs of a track can follow each other.
 */
/** 原生回传的拍点表：存与用都是这个形状。 */
const nativeGrid = (beats: NativeBeat[]): AccentedBeatGrid => ({
    beats: beats.map(beat => beat.time),
    downbeats: beats.filter(beat => beat.downbeat).map(beat => beat.time),
});

/**
 * Starts one whole-track run; a run already going for this key is joined, never doubled.
 *
 * Every chunk the phone hands over is stored before it is passed on: a run that is cut short - the
 * next track, the app going away, a picture switch - then still leaves behind the beats it did find,
 * and the next play reads them in a second or two instead of paying for the decode and the model again.
 */
const startRun = (
    key: string,
    readMid: () => Promise<Float32Array | null>,
    { cpuFallback = false, urgency = 'background', nativeSourceUrl, onPartial }: TrackBeatGridOptions = {},
): Promise<AccentedBeatGrid | null> => {
    const existing = running.get(key);
    if (existing) {
        if (urgency !== 'background') raiseGpuUrgency(key, urgency);
        return existing.grid;
    }

    /*
     * 每算完一块就落一次盘。
     *
     * 这是「下次不用重算」的关键：整曲在手机上要二十秒以上，用户常常等不到它算完就切歌、
     * 切后台或者退出 —— 只在最后存一次，那二三十秒每次都白干。存半份的代价是每块一次
     * IndexedDB 写入（几百个浮点数，几 KB），换来的是下次播放一两秒就有拍点。
     */
    const handlePartial = (beats: NativeBeat[], seconds: number) => {
        if (beats.length) {
            void storeBeatGrid(key, nativeGrid(beats), seconds).catch((error) => {
                console.warn('[BeatGrid] storing a partial beat list failed', error);
            });
        }
        onPartial?.(beats, seconds);
    };

    const grid = (async (): Promise<AccentedBeatGrid | null> => {
        /*
         * 安卓：走内置的 beat_this（onnxruntime-android）。
         *
         * 必须排在 `canRunBeatThis()` **之前**：那条判断问的是「桌面主进程的桥在不在，
         * 或者这个渲染进程有没有 WebGPU」—— 安卓两样都没有，先问它就会在这里直接 return null，
         * 原生这一条永远到不了。权重在 APK 里、推理在原生线程上，它不需要上面任何一样。
         *
         * 音频优先交给原生按地址自己解（`nativeSourceUrl`）：整首歌的 PCM 过桥是 20MB+ 的
         * base64，桥和堆都撑不住。只有拿不到地址时才退回「JS 解码 + 传样本」。
         *
         * 与 GPU 路径刻意不同的是**不产出 accents**：
         * accents 依赖频谱的打击乐能量，那是 GPU 那套顺带算出来的东西。
         * 原生这次只交了拍点，没有那份频谱，硬凑一个会让动感模式的
         * 强弱控制失真。没有 accents 时下游会退回按拍点平均分配，
         * 那是「不知道强弱」该有的样子，不是编一个出来。
         */
        if (isNativeBeatAnalysisAvailable()) {
            let analysis: Awaited<ReturnType<typeof analyzeBeatsNative>> | null = null;
            const sourceUrl = nativeSourceUrl ? await nativeSourceUrl() : null;
            if (sourceUrl) {
                /*
                 * 不必先「安装」一遍：原生 analyzeBeatsFromUrl 里自己 ensureLocal，
                 * 权重不在私有目录就当场从 assets 拷。原来这里横着一道 installModel 的闸，
                 * 它失败一次就整首歌没有拍点 —— 而失败原因还到不了任何一行日志上。
                 */
                try {
                    // 端口每次启动都变，别把它写进日志；路径本身足以判断走的是哪条来源。
                    const where = sourceUrl.replace(/^(https?:\/\/127\.0\.0\.1):\d+/, '$1:…');
                    console.info(`[BeatGrid] native analysis from ${where}`);
                    analysis = await analyzeBeatsNativeFromUrl(sourceUrl, undefined, handlePartial);
                } catch (error) {
                    console.warn('[BeatGrid] native analysis failed', error);
                    return null;
                }
            } else {
                /*
                 * 退路：PCM 已经在 JS 手里、又没有可交出去的地址。
                 *
                 * 这条路要把样本编码成 base64 过桥，所以只对短音频开口子：
                 * 100 万个样本（约 45 秒）编码后 5.3MB，还在桥的 8MiB 以内。
                 * 更长的整首歌走这里不是慢，是把 WebView 的堆撞穿 —— 宁可不给拍点。
                 */
                const mid = await readMid();
                if (mid && mid.length > MAX_BRIDGE_SAMPLES) {
                    console.warn(`[BeatGrid] native beat analysis needs a source URL for ${key}: ${mid.length} samples would not fit the bridge`);
                    analysis = null;
                } else {
                    analysis = mid ? await analyzeBeatsNative(mid) : null;
                }
            }
            if (!analysis) {
                console.warn('[BeatGrid] native analysis returned nothing');
                return null;
            }
            console.info(`[BeatGrid] native analysis: ${analysis.beats.length} beats, ${analysis.beats.filter((beat: NativeBeat) => beat.downbeat).length} downbeats`);
            const found = nativeGrid(analysis.beats);
            // 整曲：不带 until，覆盖掉之前存的半份。
            if (found.beats.length) await storeBeatGrid(key, found);
            return found.beats.length ? found : null;
        }

        if (!canRunBeatThis()) return null;

        const mid = await readMid();
        if (!mid) return null;
        const mel = await melSpectrogramOffThread(mid);
        // The GPU also measures the spectrogram's percussive energy, for the accents' gate.
        const analysed = await analyseBeatGrid(mel, { cpuFallback, percussive: true, urgency, key });
        // The energy is only an input: the grid kept and handed on is the beats alone.
        const grid: BeatGrid | null = analysed ? { beats: analysed.beats, downbeats: analysed.downbeats } : null;
        // The accents ride on the spectrogram the beats were found on: a few ms, no second decode. Only
        // from a GPU run, the one with the energy; a CPU run's list gets them later, if the beat FX ask.
        const found: AccentedBeatGrid | null = grid?.beats.length && analysed?.percussive
            ? {
                ...grid,
                accents: computeBeatAccents(mel, grid.beats, grid.downbeats, analysed?.percussive ?? null, {
                    confidence: analysed?.beatLogits ? resolveBeatConfidence(analysed.beatLogits, grid.beats) : null,
                    onMeter: logBeatMeter(key),
                }),
            }
            : grid;
        if (found) await storeBeatGrid(key, found);
        return found;
    })();

    const run: Run = { grid, cpuFallback };
    running.set(key, run);
    void grid.finally(() => {
        if (running.get(key) === run) running.delete(key);
    }).catch(() => undefined);
    return grid;
};

/**
 * A whole track's beats: stored, joined from a run in flight, or run now. Null when the model could
 * not answer; a grid with no beats when it answered "none".
 *
 * `readMid` is called only when the model actually has to run - a stored list or a joined run never
 * decodes anything. It answers the track's mono (mid) samples at the Beat This! rate, or null when
 * they cannot be had, which is not remembered: a later call may find the bytes.
 *
 * A GPU-only run that came back null does not answer a caller allowed the CPU; that caller runs again
 * with the fallback, which is the one case two runs of a track can follow each other.
 *
 * A list stored part way through (the phone stores each chunk) is handed on as it is and finished in
 * the background: waiting for the last chunk is what made a replayed track look like it was never
 * analysed at all.
 */
export const getTrackBeatGrid = async (
    key: string,
    readMid: () => Promise<Float32Array | null>,
    options: TrackBeatGridOptions = {},
): Promise<AccentedBeatGrid | null> => {
    const { cpuFallback = false, storedOnly = false, urgency = 'background' } = options;

    const stored = await readStoredBeatGridEntry(key);
    if (stored) {
        if (stored.until !== undefined && !storedOnly) {
            /*
             * 存的是半份：先交出去，让画面现在就动，同时在后台把剩下的补上。
             * 不 await 那次补齐 —— 用户要的是「立刻有拍点」，补齐只把表接长，
             * 末尾与已有的重叠，时钟不会因此跳。
             */
            void startRun(key, readMid, options).catch((error) => {
                console.warn('[BeatGrid] finishing a stored partial beat list failed', error);
            });
        }
        return stored.grid;
    }

    const joined = running.get(key);
    if (joined) {
        // A picture on screen joining automix's background run: its GPU unit moves up with it.
        if (urgency !== 'background') raiseGpuUrgency(key, urgency);
        const grid = await joined.grid;
        if (grid || joined.cpuFallback || !cpuFallback) return grid;
    }
    if (storedOnly) return null;

    return startRun(key, readMid, options);
};

/**
 * Logs how a track's bars read once its accents are measured - the model's tempo, its bar lengths,
 * the rise by bar position and whether only every few beats fire - so a track whose beat FX feel off
 * can be looked at from the console log alone. The key is the track's id, no URL or account data.
 */
const logBeatMeter = (key: string) => (meter: BeatMeter, pulse: readonly number[]) => {
    console.info(`[BeatMeter] ${key}: ${formatBeatMeter(meter, pulse)}`);
};

const accentRuns = new Map<string, Promise<BeatAccents | null>>();

/**
 * The accents of a stored list that has none - one a CPU run stored, or one stored before they
 * existed. Decodes and transforms the track again (on the worker), runs final0 again on the GPU for its percussive energy
 * and its confidence in each stored beat (the beats themselves are already known), measures, and
 * stores the list back with them. Null when the bytes cannot be had, which is not remembered: a later
 * play may find them. Concurrent callers for one key share the run.
 */
export const getTrackBeatAccents = (
    key: string,
    grid: BeatGrid,
    readMid: () => Promise<Float32Array | null>,
): Promise<BeatAccents | null> => {
    const running = accentRuns.get(key);
    if (running) return running;
    const run = (async () => {
        const mid = await readMid();
        if (!mid) return null;
        const mel = await melSpectrogramOffThread(mid);
        // final0 again for its logits at the stored beats and the percussive energy (GPU only, once per
        // track); when it cannot run, the energy alone, and null leaves every beat rhythmic.
        // Only the beat FX ask for accents, for the track on screen.
        const analysed = await analyseBeatGrid(mel, { percussive: true, urgency: 'onScreen' });
        const energy = analysed?.percussive ?? (analysed ? null : await runPercussiveEnergyGpu(mel, { urgency: 'onScreen', key }));
        const accents = computeBeatAccents(mel, grid.beats, grid.downbeats, energy, {
            confidence: analysed?.beatLogits ? resolveBeatConfidence(analysed.beatLogits, grid.beats) : null,
            onMeter: logBeatMeter(key),
        });
        // Stored against the list now on disk, so a list replaced meanwhile is not given another's accents.
        const stored = await readStoredBeatGrid(key);
        if (stored && stored.beats.length === grid.beats.length && stored.beats.every((time, index) => time === grid.beats[index])) {
            await storeBeatGrid(key, { ...stored, accents });
        }
        return accents;
    })();
    accentRuns.set(key, run);
    void run.finally(() => {
        if (accentRuns.get(key) === run) accentRuns.delete(key);
    }).catch(() => undefined);
    return run;
};
