import {
    audioBands, audioPower, beatImpact, downbeatImpact, musicBody, musicChordMinor, musicChordRoot,
    musicEnvelopes, musicHarmony, musicKeyMinor, musicKeyRoot, musicLyricLift, musicPitch, musicSway, musicVocals, musicVoicing,
} from '../../stores/motionSignals';
import { clearMusicEnvelopeTarget, detectKey, getMusicEnvelope, MUSIC_ENVELOPE_KINDS, pumpMusicEnvelope, sampleMusicEnvelope, type MusicEnvelopeKind } from '../analysis/musicEnvelope';
import { createBeatFxClockState, stepBeatFxClock, type BeatFxEvent } from './clock';
import { resetEffectPulses, stepEffectPulses } from './effectTracks';
import type { BeatFxSourceKind } from './beatFxSource';

// src/services/beatFx/beatFxLive.ts
// The one live beat clock: fed the current track's beat list, stepped once per frame from the
// existing playback RAF loop, and written into the `beatImpact` / `downbeatImpact` MotionValues.
// No React state anywhere on this path.
//
// The MotionValues carry the envelopes already scaled by 智能动感模式's 轻拍 / 重拍 strengths
// (`setBeatFxIntensities`: both the strength of the beat-list effect on screen, since effects have
// their own), so every visualizer reading them gets the user's strengths without reading settings
// itself. An effect not driven by these signals asks `getBeatEffectStrength` for its own. Discrete
// effects (a ripple per beat) count `getBeatFxFiredCounts` instead
// and scale by `getBeatFxIntensities`.
//
// With accents (analysis/beatAccents.ts) the envelopes already peak lower on a weak beat and on a
// track whose beats barely stand out; a discrete effect reads the beat it fires for with
// `getBeatFxLastBeat` / `getBeatFxLastDownbeat` and scales by `resolveBeatFxAccentGain`.
//
// Diagnostics (`window.__foliaBeatFx`: beats fired, source, latency, the two envelopes) exist in a
// dev build, or in any build with localStorage['folia.dev.beatFxDebug'] = '1' at startup.

interface BeatFxDebug {
    beats: number;
    downbeats: number;
    lastT: number | null;
    heardT: number | null;
    source: BeatFxSourceKind | 'loading';
    note: string | null;
    trackKey: string | null;
    eventCount: number;
    latencyMs: number;
    beatImpact: number;
    downbeatImpact: number;
}

declare global {
    interface Window {
        __foliaBeatFx?: BeatFxDebug;
    }
}

/**
 * How long a track change keeps the previous track's "ready" while the new one's beats load.
 *
 * Without it every change - a skip, an automix handover, exactly the moments meant to be seamless -
 * dropped the visualizer to its original frame for the few frames a stored list takes to read, and
 * jumped back. Held, the frame stays a beat FX frame whose envelopes simply decay to rest; only a
 * track that really has no beats after this long drops back, once.
 */
const READY_HOLD_MS = 1500;

const readDebugFlag = (): boolean => {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem('folia.dev.beatFxDebug') === '1';
    } catch {
        return false;
    }
};

const debug: BeatFxDebug | null = (import.meta.env.DEV || readDebugFlag())
    ? {
        beats: 0,
        downbeats: 0,
        lastT: null,
        heardT: null,
        source: 'none',
        note: null,
        trackKey: null,
        eventCount: 0,
        latencyMs: 0,
        beatImpact: 0,
        downbeatImpact: 0,
    }
    : null;
if (debug && typeof window !== 'undefined') window.__foliaBeatFx = debug;

const state = createBeatFxClockState();
let trackKey: string | null = null;
let lastStepAt: number | null = null;
/** `performance.now()` until which a track change counts as ready; see READY_HOLD_MS. */
let holdUntil = 0;
/** Whether the last step had a deck being heard; false while paused or stopped. */
let hearing = false;
/** The playing track's time the listener hears, seconds; null while nothing plays. */
let heardAt: number | null = null;
/** The last time heard while playing, and its track: what a pause or a picture switch leaves. */
let lastHeard: { key: string | null; time: number } = { key: null, time: 0 };
const intensities = { beat: 1, downbeat: 1 };
/** Median gap between the installed track's beats, in seconds; see `getBeatFxBeatPeriod`. */
const DEFAULT_BEAT_PERIOD = 0.5;
let beatPeriod = DEFAULT_BEAT_PERIOD;

/** Median gap between consecutive events, or the default for fewer than two. */
export const resolveBeatFxBeatPeriod = (events: readonly BeatFxEvent[]): number => {
    if (events.length < 2) return DEFAULT_BEAT_PERIOD;
    const gaps: number[] = [];
    for (let index = 1; index < events.length; index += 1) gaps.push(events[index].t - events[index - 1].t);
    gaps.sort((a, b) => a - b);
    const median = gaps[gaps.length >> 1];
    return median > 0 ? median : DEFAULT_BEAT_PERIOD;
};
const firedCounts = { beats: 0, downbeats: 0 };
/**
 * `musicBody` 的上一帧值。放在模块级而不是每次重算，是为了让这条曲线有惯性：
 * 三条源曲线本来就是 20Hz 采样的，直接跟会在帧间留下台阶，读起来是「跳」而不是「呼吸」。
 */
let bodyLevel = 0;
let vocalLevel = 0;
let harmonyLevel = 0;
/**
 * 「慢速基线」：实时频谱的 1.6 秒跟随值，只在曲线还没算好时当回退用。
 *
 * 为什么需要它：`audioBands.vocal` 是**整混音** 250–2000 的实时能量，鼓就在里面。
 * 曲线没到位时直接读它，字就跟着每一拍军鼓抖；等分析完切到曲线，又突然安静下来。
 * 同一个歌词样式在「新歌第一遍」和「第二遍」判若两人，看上去就是没修好。
 *
 * 慢基线的意义是给一个**上限**：实时值不许超过它的 1.05 倍。鼓点那 40ms 的冲高
 * 撑不过时间常数，而一句唱腔持续一两秒，慢基线跟得上——只有乐句起伏能过这道闸。
 */
let slowVocal = 0;
let slowMid = 0;
let slowTreble = 0;
let slowBass = 0;
/**
 * 这四条曲线是**坐标**而不是能量，采样时不能按 97 分位归一。
 *
 * 其余曲线都要归一：一首歌的 RMS 从 0.01 到 0.3 都有，不归一则前奏和副歌差十倍，
 * 画面就失去起伏。但音高位置、和弦根音本身就是 0..1 的坐标，一归一就被除坏了 ——
 * 典型症状是「整首歌的画面都卡在中间高度」，因为 top 恒在 0.8 以上。
 */
const RAW_KINDS = new Set<MusicEnvelopeKind>(['vocalVoicing', 'vocalPitch', 'chordRoot', 'chordMinor']);

/** 慢基线是按歌算的：切歌不清零，第一帧就会带着上一首的响度。 */
let slowKey: string | null = null;

/**
 * 「不该跟鼓」的七条曲线。
 *
 * 它们的回退值走慢基线而不是实时频谱，所以单独列出来。这两个对象放在模块级、
 * 每帧改字段 —— 它们每帧都要用，临时对象在 60fps 下就是每秒 60 份垃圾。
 */
type SemanticKey = 'other' | 'vocals' | 'brightness' | 'vocalBody' | 'vocalAir' | 'harmony' | 'pad';
const isolated: Record<SemanticKey, number> = { other: 0, vocals: 0, brightness: 0, vocalBody: 0, vocalAir: 0, harmony: 0, pad: 0 };
const semanticFallback: Record<SemanticKey, number> = { other: 0, vocals: 0, brightness: 0, vocalBody: 0, vocalAir: 0, harmony: 0, pad: 0 };

/**
 * `musicSway` 的状态：这一段见过的峰值（缓慢衰减）与当前的门槛值。
 *
 * 峰值衰减而不是整曲最大：用户拖进度条跳着听时，不可能先知道整首的副歌有多响；
 * 而且一首歌里两段副歌的绝对值也可能差不少。跟着「最近十来秒听到的峰值」走，
 * 门槛才是相对于**此刻这首歌**的，不是相对于某次全曲统计的。
 */
let swayPeak = 0;
let swayLevel = 1;

/**
 * What the beat list lookup is doing for the track on screen, for a setting to show.
 *
 * 智能动感的失败在画面上只有一种表现 —— 特效不动，和「这首歌还没分析」一模一样。
 * 而它至少有四种原因：当前画面没有开着任何一个吃拍点的特效、没有在播的歌、
 * 正在分析、分析失败。前两个根本不会产生任何日志（整条链路没启动），
 * 所以「翻日志找原因」在有日志之前就已经失败了。这个快照让界面直接说出是哪种。
 *
 * 变更频率与加载次数相当（一首歌一次），不是每帧：调用方可以放心订阅。
 */
export interface BeatFxStatus {
    /** The analysis key the clock is on, or null with nothing playing. */
    key: string | null;
    /** 'loading' while the lookup is in flight. */
    source: BeatFxSourceKind | 'loading';
    /** Why there are no beats, when there are none. */
    note: string | null;
    eventCount: number;
}

let status: BeatFxStatus = { key: null, source: 'none', note: null, eventCount: 0 };
const statusListeners = new Set<() => void>();

const publishStatus = (next: BeatFxStatus) => {
    status = next;
    for (const listener of statusListeners) listener();
};

/** The current status; the same object until it changes, so it can be a `useSyncExternalStore` snapshot. */
export const getBeatFxStatus = (): BeatFxStatus => status;

export const subscribeBeatFxStatus = (listener: () => void): (() => void) => {
    statusListeners.add(listener);
    return () => { statusListeners.delete(listener); };
};

/** The 轻拍 / 重拍 strengths (0..2) the envelopes are scaled by from the next step on. */
export const setBeatFxIntensities = (beat: number, downbeat: number) => {
    intensities.beat = beat;
    intensities.downbeat = downbeat;
};

/** The current 轻拍 / 重拍 strengths; one shared object, read it rather than keep it. */
export const getBeatFxIntensities = (): Readonly<{ beat: number; downbeat: number }> => intensities;

/** The live effects on screen and their strengths (beatClockTargets.ts `liveBeatEffects`). */
let liveEffects: Readonly<Record<string, number>> = {};

/**
 * Sets which beat effects play now and how strongly (services/beatFx/beatEffects.ts), from the
 * settings and the picture on screen; a frame loop asks `getBeatEffectStrength` for its own.
 */
export const setBeatFxLiveEffects = (strengths: Readonly<Record<string, number>>) => {
    liveEffects = strengths;
};

/** The strength an effect plays at now, 0..2; 0 while it does not play (off, retired, not on screen). */
export const getBeatEffectStrength = (id: string): number => liveEffects[id] ?? 0;

/** Whether an effect plays now, its strength turned down to 0 included (雾笺: 0 is no rain, not the fallback). */
export const isBeatEffectPlaying = (id: string): boolean => id in liveEffects;

/**
 * How many beats and downbeats the clock has fired since the app started - only ever growing, across
 * tracks and seeks - so a frame loop that remembers last frame's counts sees exactly the ones fired
 * since. One shared object, read it rather than keep it.
 */
export const getBeatFxFiredCounts = (): Readonly<{ beats: number; downbeats: number }> => firedCounts;

/** Switches the clock to a new track; events arrive later via `setBeatFxEvents`. */
export const beginBeatFxTrack = (key: string | null) => {
    // Held only from a track that was ready: its beats in, or itself still inside a hold. Keyed on the
    // events alone, a run of quick skips dropped the frame at the second one.
    const wasReady = isBeatFxReady();
    holdUntil = key && wasReady ? Math.max(holdUntil, performance.now() + READY_HOLD_MS) : 0;
    // Another track: where the last one was heard is not where this one is, and the
    // previous track's pulses must not carry over into its first frames.
    if (key !== trackKey) {
        lastHeard = { key: null, time: 0 };
        resetEffectPulses();
        /*
         * 切歌时把上一首最后一帧的十条曲线与拍点冲击一并归零。
         *
         * 这些是全局 MotionValue，只在 stopBeatFx（效果关掉）时清过；换歌但效果
         * 还开着时它们会一直挂着旧值，直到新歌的曲线装载完成 —— 那几帧画面用的
         * 就是「上一首的数据」。宁可静止一下，也不要沿用别的歌的曲线。
         */
        for (const kind of MUSIC_ENVELOPE_KINDS) musicEnvelopes[kind].set(0);
        state.beatImpact = 0;
        state.downbeatImpact = 0;
        beatImpact.set(0);
        downbeatImpact.set(0);
    }
    trackKey = key;
    state.events = [];
    state.cursor = 0;
    state.lastTime = null;
    state.lastBeat = null;
    state.lastDownbeat = null;
    if (debug) {
        debug.trackKey = key;
        debug.source = key ? 'loading' : 'none';
        debug.note = null;
        debug.eventCount = 0;
    }
    publishStatus({ key, source: key ? 'loading' : 'none', note: null, eventCount: 0 });
};

/**
 * Installs the beat list for `key`, with its dynamics scale; ignored if the track changed while it was
 * loading. Called again for the same track when its accents arrive.
 */
export const setBeatFxEvents = (
    key: string,
    events: BeatFxEvent[],
    source: BeatFxSourceKind,
    note?: string,
    trackScale = 1,
) => {
    if (key !== trackKey) return;
    state.events = events;
    state.trackScale = trackScale;
    beatPeriod = resolveBeatFxBeatPeriod(events);
    holdUntil = 0;
    // Resync on the next step rather than firing everything before the current position.
    state.lastTime = null;
    if (debug) {
        debug.source = source;
        debug.note = note ?? null;
        debug.eventCount = events.length;
    }
    publishStatus({ key, source, note: note ?? null, eventCount: events.length });
};

/**
 * 同一首歌的分段续写：换上更长的表，但**不动时钟的位置**。
 *
 * 与 `setBeatFxEvents` 只差一点：不把 `lastTime` 清空。分段每 40 秒来一次，
 * 每次都重同步会漏掉那一帧正好该响的拍子，而这里本来只是「同一份列表变长了」，
 * 时钟该接着走。安卓原生按块交付用这条（nativeBeats.ts 的 beatAnalysisChunk）。
 */
export const updateBeatFxEvents = (key: string, events: BeatFxEvent[], source: BeatFxSourceKind = 'beat_this') => {
    if (key !== trackKey) return;
    state.events = events;
    beatPeriod = resolveBeatFxBeatPeriod(events);
    holdUntil = 0;
    if (debug) {
        debug.source = source;
        debug.note = null;
        debug.eventCount = events.length;
    }
    publishStatus({ key, source, note: null, eventCount: events.length });
};

/**
 * Whether the playing track's beat list is installed - or a track change is still inside its hold.
 * Until then (analysing, not cached, no model, a GPU that could not take it) a visualizer draws its
 * original frame rather than a beat FX frame with nothing driving it.
 */
export const isBeatFxReady = (): boolean =>
    trackKey !== null && (state.events.length > 0 || (holdUntil > 0 && performance.now() < holdUntil));

/** Whether a deck was being heard at the last step; continuous effects rest while it is not. */
export const isBeatFxHearing = (): boolean => hearing;

/** The installed track's key and the time in it the listener hears (null while nothing plays). */
export const getBeatFxHeard = (): Readonly<{ key: string | null; time: number | null }> => ({ key: trackKey, time: heardAt });

/** Where `key` was last heard playing (s), 0 if it has not been: the playhead 雾笺's vocals start from. */
export const getBeatFxLastHeard = (key: string): number => (lastHeard.key === key ? lastHeard.time : 0);

/** Stops the clock and zeroes both envelopes; called when the FX are switched off. */
export const stopBeatFx = () => {
    clearMusicEnvelopeTarget();
    beginBeatFxTrack(null);
    state.beatImpact = 0;
    state.downbeatImpact = 0;
    beatImpact.set(0);
    downbeatImpact.set(0);
    for (const kind of MUSIC_ENVELOPE_KINDS) musicEnvelopes[kind].set(0);
    // 智能动感关掉 / 静态模式 / 没样式要拍点时，脉冲也一并归零，别留一个半截的
    // 缩放/辉光定在画面上（tickBeatFx 在 wanted=false 时不会再被调用）。
    resetEffectPulses();
    lastStepAt = null;
    hearing = false;
};

/** The last fired plain beat (not a downbeat) of this track, or null. */
export const getBeatFxLastBeat = (): BeatFxEvent | null => state.lastBeat;

/** The last fired downbeat of this track, or null. */
export const getBeatFxLastDownbeat = (): BeatFxEvent | null => state.lastDownbeat;

/**
 * The installed track's whole beat list, sorted by time (empty until it is in). For a picture that
 * schedules ahead of the beat rather than reacting to it - hanabi launches a shell so it bursts on the
 * downbeat - and draws purely from the playback time. Read it rather than keep it: a new track or its
 * accents replace the list.
 */
export const getBeatFxEvents = (): readonly BeatFxEvent[] => state.events;

/** The playing track's typical beat length in seconds (median gap), for effects timed in beats. */
export const getBeatFxBeatPeriod = (): number => beatPeriod;

/** The playing track's dynamics scale (0.45..1); 1 without accents. */
export const getBeatFxTrackScale = (): number => state.trackScale;

/** Alternating ±1 for the camera tilt; flips on every fired beat. */
export const getBeatFxRotationSign = (): number => state.rotationSign;

/**
 * One frame of the beat clock. `audioElement` is the deck being heard, or null when nothing is
 * playing; `context` is the AudioContext it is routed through, used for output latency.
 *
 * `positionSec` is for the routes with no element to read: 安卓的原生播放器与 mpv 都不在
 * WebView 里，那块 `<audio>` 的 currentTime 恒为 0。给了它就照它走（null = 没在放），
 * 没给才去看元素。这个参数不是可选的装饰 —— 少了它，手机上一次拍点都不会触发，
 * 因为 `stepBeatFxClock` 对 null 的处置是「不推进、不触发」，而分析是否成功与它无关。
 */
export const tickBeatFx = (
    audioElement: HTMLMediaElement | null,
    context: BaseAudioContext | null | undefined,
    /** Where the track is now, in seconds, on a route with no `<audio>`; null when nothing plays. */
    positionSec?: number | null,
) => {
    const now = performance.now();
    // 真实帧间隔单独留着：衰减用它会被截断（一帧掉太久不该让包络直接归零），
    // 但「这一帧跨了多久」必须是真的 —— 判断是不是 seek 要的就是它。
    const frameSec = lastStepAt === null ? 0 : (now - lastStepAt) / 1000;
    const dtSec = Math.min(0.1, frameSec);
    lastStepAt = now;

    let heardTime: number | null = null;
    if (positionSec !== undefined) {
        heardTime = positionSec !== null && Number.isFinite(positionSec) ? positionSec : null;
    } else if (audioElement && !audioElement.paused && !audioElement.ended) {
        const live = context as (BaseAudioContext & { outputLatency?: number; baseLatency?: number }) | null | undefined;
        const latency = (Number(live?.outputLatency) || 0) + (Number(live?.baseLatency) || 0);
        // What the listener hears lags what the element has decoded by the output latency.
        heardTime = audioElement.currentTime - latency;
        if (debug) debug.latencyMs = latency * 1000;
    }
    hearing = heardTime !== null;
    heardAt = heardTime;
    if (heardTime !== null) lastHeard = { key: trackKey, time: heardTime };

    stepBeatFxClock(state, heardTime, dtSec, frameSec);
    firedCounts.beats = state.firedBeats;
    firedCounts.downbeats = state.firedDownbeats;
    beatImpact.set(state.beatImpact * intensities.beat);
    downbeatImpact.set(state.downbeatImpact * intensities.downbeat);

    /*
     * 同一个 RAF、同一步：把已分离出的十条音乐曲线交给所有歌词样式。
     *
     * 沿用 motionSignals 里那组每帧 MotionValue，各样式照旧用 useTransform / .get() 读，
     * 不新增帧循环、不新建模块。采的是「听众此刻听到的位置」，拖进度条、暂停、原生播放
     * 全一致；没有分析数据时整组归零，读它的样式自然静止。只在值变化时 set，避免每帧
     * 无谓地唤醒订阅者（后台负载是这条链路一直要守的东西）。
     */
    const envelope = heardTime !== null ? getMusicEnvelope(trackKey) : null;
    /*
     * 曲线还没补到的地方（后半首、或者这一段某一轨本来就静音）用**实时频谱**顶上。
     *
     * 读的是 audioBands 此刻的原值（实时频谱），只用来在这里顶一下，不写回 audioBands，
     * 也就没有正反馈。没有这一层的话，补齐一旦停在 30 秒，剩下的三分多钟画面就彻底不动。
     */
    const liveBass = Math.min(1, audioBands.bass.get() / 255);
    const liveLowMid = Math.min(1, audioBands.lowMid.get() / 255);
    const liveMid = Math.min(1, audioBands.mid.get() / 255);
    const liveVocal = Math.min(1, audioBands.vocal.get() / 255);
    const liveTreble = Math.min(1, audioBands.treble.get() / 255);
    const livePower = Math.min(1, audioPower.get() / 255);
    /*
     * 慢基线（见模块级注释）。时间常数 1.6 秒：比一句唱腔（1~3 秒）短一点，
     * 比一拍（0.4~0.6 秒）长得多 —— 这个位置正好只放乐句过去，不放鼓点。
     */
    if (slowKey !== trackKey) {
        slowKey = trackKey;
        slowVocal = 0;
        slowMid = 0;
        slowTreble = 0;
        slowBass = 0;
    }
    const slowFollow = 1 - Math.exp(-dtSec / 1.6);
    slowVocal += (liveVocal - slowVocal) * slowFollow;
    slowMid += (liveMid - slowMid) * slowFollow;
    slowTreble += (liveTreble - slowTreble) * slowFollow;
    slowBass += (liveBass - slowBass) * slowFollow;
    /*
     * 上限闸：实时值超过慢基线 5% 的那部分，就是鼓。
     *
     * 取 min 而不是把慢基线直接用：一句比上一句更响的时候，实时值会短暂超过慢基线，
     * 这一小截要留着（否则整首歌的歌词都顶在同一个高度）；但鼓的一击会把实时值
     * 顶高好几倍，那一截全部截掉。
     */
    const softVocal = Math.min(liveVocal, slowVocal * 1.05);
    const softMid = Math.min(liveMid, slowMid * 1.05);
    const softTreble = Math.min(liveTreble, slowTreble * 1.05);
    const softBass = Math.min(liveBass, slowBass * 1.05);
    const liveFallback: Record<MusicEnvelopeKind, number> = {
        bass: liveBass,
        vocals: liveVocal,
        other: liveMid,
        energy: livePower,
        bassSub: liveBass,
        vocalAir: liveVocal,
        brightness: liveTreble,
        kick: liveLowMid,
        snare: liveLowMid * 0.7,
        hat: liveTreble * 0.8,
        // 四条语义轨没有实时等价物，用最接近的整混音频段兜底；有分轨曲线时一律以曲线为准。
        drums: liveLowMid,
        vocalBody: liveVocal,
        harmony: liveMid,
        pad: liveBass * 0.6,
        /*
         * 语义层没有实时等价物，回退给 0 而不是「最接近的频段」。
         *
         * 拿 liveVocal 兜底等于把整混音又接回歌词：鼓一响这条就跳，前面所有去鼓的
         * 工作全白做。这三个量在基线阶段就有曲线（原生从混音近似算过一遍），
         * 真正读不到数据的情况几乎没有；宁可让它停，也不要让它跟着鼓抖。
         */
        vocalVoicing: 0,
        vocalPitch: 0,
        chordRoot: 0,
        chordMinor: 0,
    };
    /*
     * 曲线覆盖到这里了吗 —— 这是「值是 0」与「没有数据」唯一能分开的地方。
     *
     * `until` 只在没补完时存在；缺了它表示整首都补完了，任何一秒的 0 都是真的静音。
     * 分不清这两件事，歌词就会在「补到的地方安静、没补到的地方抖」之间反复横跳。
     */
    const covered = envelope !== null && heardTime !== null
        && (envelope.until === undefined || heardTime <= envelope.until);
    /*
     * 语义轨的回退值：全部走慢基线。
     *
     * 对象放在模块级、每帧只改字段：这是每帧都走一次的路径，一帧一个临时对象在
     * 60fps 下就是每秒 60 个，GC 迟早会在某次副歌里露头。
     */
    semanticFallback.other = softMid;
    semanticFallback.vocals = softVocal;
    semanticFallback.brightness = softTreble;
    semanticFallback.vocalBody = softVocal;
    semanticFallback.vocalAir = softVocal;
    semanticFallback.harmony = softMid;
    semanticFallback.pad = softBass * 0.6;

    const frame = {} as Record<MusicEnvelopeKind, number>;
    for (const kind of MUSIC_ENVELOPE_KINDS) {
        // `covered` 已经蕴含「有包络、且此刻在包络范围内」（TS 5.5 起会据此收窄）。
        const sampled = covered && heardTime !== null
            ? sampleMusicEnvelope(envelope, kind, heardTime, !RAW_KINDS.has(kind))
            : 0;
        const key = kind as SemanticKey;
        const semantic = key in isolated;
        /*
         * 只有一件事决定用曲线还是用回退：**这段时间有没有被分析覆盖**。
         *
         * 以前这里写的是「采样值大于 0.001 就用曲线，否则退回实时频谱」。那个阈值是个陷阱：
         * 曲线在静音段、气口、弱拍上正好在 0 附近，采样值就会在 0.001 上下抖。上下一跳，
         * 读到的值就从「曲线 ≈ 0」跳到「实时频谱 ≈ 0.6」再跳回来 —— 60fps 下每秒几十次。
         * 看上去是画面在抽、在振，实际上数据源在一个阈值上反复横跳。这跟分轨质量无关，
         * 是接口语义的问题：**0 和「没有数据」必须分开**，而 `covered` 就是干这个的。
         *
         * 覆盖范围内一律信曲线，哪怕这一帧是 0 —— 那说明这段确实安静。没覆盖才回退。
         */
        const next = semantic
            ? (covered ? sampled : semanticFallback[key])
            : (covered ? sampled : liveFallback[kind]);
        if (semantic) isolated[key] = next;
        frame[kind] = next;
        const signal = musicEnvelopes[kind];
        if (signal.get() !== next) signal.set(next);
    }
    /*
     * 去鼓的「身体」起伏：给海报、水墨、雾这类本来没有节奏感的画面用。
     *
     * 三条源都落在 150Hz 以上 —— 其余乐器、人声、亮度。底鼓的基频（50–100Hz）与它的
     * 主要谐波都进不来，鼓点再重也顶不起这条曲线；它只跟和声厚薄、唱腔进出、高频明暗走。
     *
     * 系数必须**加起来接近 1**，这是个容易踩的坑：`sampleMusicEnvelope` 交出来的已经是
     * 按 97 分位归一过的 0..1（不是原始 RMS），再乘 1.7 就会常年顶在 1 上 —— 曲线变成
     * 一条常量，读它的画面看上去就是「没动」。上一版正是这么写坏的。
     * 现在按权重平均：和声为主，人声其次，亮度只做一点点，典型段落落在 0.4~0.8，
     * 起伏才有空间。
     */
    /*
     * 两条语义总线。权重都按「加起来约等于 1」配 —— 曲线已经按 97 分位归一过，
     * 再乘大于 1 的系数就会常年顶在 1 上，看起来就是「没动」。
     *
     * 人声这条**不再掺 `isolated.vocals`（整轨）**。整轨就是 SCNet 的 vocals 原样，
     * 军鼓漏进来的那点残响全在里面；哪怕只给 8%，每一拍也能把这条总线顶出一条鼓包。
     * 现在只留 vocalBody（已减鼓）+ vocalAir（3k 以上气声，鼓在这个频段只有镲片）。
     */
    /*
     * 语义层三条总线。与 `musicVocals` 的分工：
     *   musicVocals  —— 「唱得多响」，做亮度、厚度、光晕的幅度
     *   musicVoicing —— 「此刻在不在唱」，做位移的**开关**
     *   musicPitch   —— 「唱到多高」，做位移的**方向与高度**
     * 三者合起来才是「跟着旋律走」；只读能量永远只能得到「跟着响度走」。
     */
    if (Math.abs(musicVoicing.get() - frame.vocalVoicing) > 0.002) musicVoicing.set(frame.vocalVoicing);
    if (Math.abs(musicPitch.get() - frame.vocalPitch) > 0.002) musicPitch.set(frame.vocalPitch);
    const lyricLift = (frame.vocalPitch - 0.5) * 2 * Math.max(0, Math.min(1, frame.vocalVoicing));
    if (Math.abs(musicLyricLift.get() - lyricLift) > 0.004) musicLyricLift.set(lyricLift);
    if (Math.abs(musicChordRoot.get() - frame.chordRoot) > 0.002) musicChordRoot.set(frame.chordRoot);
    if (Math.abs(musicChordMinor.get() - frame.chordMinor) > 0.002) musicChordMinor.set(frame.chordMinor);
    /*
     * 整曲调性：一首歌只判一次。
     *
     * `detectKey` 按包络对象缓存（WeakMap），这里每帧调用的开销就是一次 Map 查找。
     * 判不出来（色度全 0：纯音效、或者还没算出任何一块）时保持上一次的值不动 ——
     * 让它回 0 会让画面在「C 大调」和「没调」之间闪。
     */
    const musicalKey = detectKey(envelope);
    if (musicalKey) {
        const keyRoot = musicalKey.root / 12;
        if (Math.abs(musicKeyRoot.get() - keyRoot) > 0.002) musicKeyRoot.set(keyRoot);
        const keyMinor = musicalKey.minor ? 1 : 0;
        if (musicKeyMinor.get() !== keyMinor) musicKeyMinor.set(keyMinor);
    }

    /*
     * 人声总线：厚度为主，气声只留一点，再乘一道发声门控。
     *
     * `vocalAir` 从 0.2 降到 0.1：那是 3kHz 以上，人声轨里这一段的能量很大一部分是
     * 镲片的高频残留 —— 分轨再准也清不掉，因为镲片和齿音在同一频段。
     *
     * 门控用 0.55 + 0.45·voicing 而不是直接乘 voicing：完全相乘会让 YIN 一次误判
     * 就把整句压没，而那正是「画面忽然卡一下」的来源。留一半底，气口只是「收」，
     * 不是「断」。
     */
    const vocalGate = 0.55 + 0.45 * frame.vocalVoicing;
    const vocalRaw = Math.min(1,
        (isolated.vocalBody * 0.9
        + isolated.vocalAir * 0.1) * vocalGate);
    const harmonyRaw = Math.min(1,
        isolated.harmony * 0.66
        + isolated.pad * 0.22
        + isolated.brightness * 0.12);
    // 人声跟句子走：0.26 约 150ms，一句唱腔（1~3 秒）跟得上，40ms 的鼓点跟不上。
    vocalLevel += (vocalRaw - vocalLevel) * 0.26;
    harmonyLevel += (harmonyRaw - harmonyLevel) * 0.26;
    if (Math.abs(musicVocals.get() - vocalLevel) > 0.001) musicVocals.set(vocalLevel);
    if (Math.abs(musicHarmony.get() - harmonyLevel) > 0.001) musicHarmony.set(harmonyLevel);

    const bodyRaw = Math.min(1,
        harmonyRaw * 0.7
        + vocalRaw * 0.2
        + isolated.brightness * 0.1);
    bodyLevel += (bodyRaw - bodyLevel) * 0.35;
    if (Math.abs(musicBody.get() - bodyLevel) > 0.001) musicBody.set(bodyLevel);

    /*
     * 「这一段该动吗」：段落活跃度门槛（musicSway）。
     *
     * 只看 musicBody 不够 —— 安静的前奏和副歌都可能是 0.35，但一个该几乎静止、
     * 一个该放开。所以拿它跟**最近这段的峰值**比，而不是跟固定阈值比：
     *   · 峰值 8 秒衰减 0.12，慢到能跨过一整段间奏，又不至于把前一分钟的副歌一直当基准；
     *   · 门槛落在峰值的 0.5~0.9 之间：低于一半算「这段是安静的」，落在 0；
     *   · 上升 2.6/s、下降 0.7/s —— 进副歌要跟得上第一句，退出要够慢，
     *     否则一个字一个字地闪，比原来还难看。
     *
     * 没有分轨数据时（envelope 为空）不做门槛：那时的 body 是实时频谱，鼓还在里面，
     * 拿它算段落只会把整首歌判成「一直该动」。宁可放开，也不要画面僵住。
     */
    if (envelope && heardTime !== null) {
        swayPeak = Math.max(bodyLevel, swayPeak - dtSec * 0.12);
        const reference = Math.max(swayPeak, 0.24);
        const target = Math.min(1, Math.max(0, (bodyLevel / reference - 0.5) / 0.4));
        swayLevel += (target - swayLevel) * Math.min(1, dtSec * (target > swayLevel ? 2.6 : 0.7));
    } else {
        swayLevel += (1 - swayLevel) * Math.min(1, dtSec * 1.2);
        swayPeak = 0;
    }
    if (Math.abs(musicSway.get() - swayLevel) > 0.002) musicSway.set(swayLevel);

    /*
     * audioBands 保持实时频谱原值：分轨曲线不往里写，免得所有样式被同一条曲线带着抖。
     * 每套样式只读 effectTracks.ts 里自己登记的那条语义轨；整页鼓点震动只留在
     * 花火/商籁/镜台的 beatImpact 原生路径里。
     */
    /*
     * 同一帧推进所有智能动感的脉冲值（effectTracks.ts）：每条效果只读自己那条非鼓点
     * 语义轨的上升沿，触发一次柔和的短脉冲 + 回弹 + 静息归位。这是唯一写入脉冲
     * MotionValue 的地方，不新增 RAF；没在播时归零，免得暂停 / 切后台留一个半截的脉冲。
     *
     * 这里不传拍点冲击、也不叠鼓点：整页鼓点震动只属于花火/商籁/镜台的 beatImpact
     * 原生路径，其余样式一律不跟鼓点，避免「跟着鼓点一闪一闪」的闪光弹和歌词左右抖。
     */
    if (heardTime !== null) {
        stepEffectPulses(frame, now / 1000, dtSec);
    } else {
        resetEffectPulses();
    }
    // 同一个 RAF、同一步：整首补齐的续算泵。切后台 / 没在播 / 已经补齐时它自己短路，
    // 一次都不额外发起分离 —— 不新增循环，也不改后台让路的低负载策略。
    pumpMusicEnvelope(now);

    if (debug) {
        debug.beats = state.firedBeats;
        debug.downbeats = state.firedDownbeats;
        debug.lastT = state.lastFiredT;
        debug.heardT = heardTime;
        debug.beatImpact = state.beatImpact;
        debug.downbeatImpact = state.downbeatImpact;
    }
};
