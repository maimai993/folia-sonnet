import type { SongResult } from '../../types';
import { mergeBeatFxEvents, type BeatFxEvent } from './clock';
import { getTrackBeatAccents, getTrackBeatGrid } from '../analysis/beatGrid';
import { getDrumHits, loadStoredDrumHits, loadTrackDrumHits, setWantedDrumTrack } from '../analysis/drumHits';
import { loadStoredMusicEnvelope, loadTrackMusicEnvelope, type MusicEnvelope } from '../analysis/musicEnvelope';
import { getVocalEnvelope, loadStoredVocalEnvelope } from '../analysis/vocalEnvelope';
import { loadTrackVocalEnvelope, releaseTrackVocals } from '../analysis/vocalStemRun';
import { getBeatFxHeard, getBeatFxLastHeard, updateBeatFxEvents } from './beatFxLive';
import { beginBeatAnalysisProgress, endBeatAnalysisProgress } from './beatProgress';
import { BEAT_THIS_SAMPLE_RATE, canRunBeatThis } from '../analysis/beatThis';
import { decodeAtRate, readLocalTrackBytes, toMidSide } from '../analysis/trackAudio';
import { decodeTrackAtRate, loadTrackBytes, type TrackBytesSource } from '../analysis/trackBytes';
import { whyNotTheSong } from '../wholeSongCheck';
import { getPlaybackAnalysisTarget } from '../playbackRecovery/representationRegistry';
import { isCacheableAudioResponse } from '../playbackRecovery/mediaCacheGuard';
import { getPrefetchedData, isUrlValid, warmupSongAudio } from '../prefetchService';
import { isNativeModelsAvailable } from '../automix/nativeModels';
import { cacheNativeMediaFromUrl, hasNativeMediaCache, readNativeMediaCacheUrl } from '../mediaCacheStore';
import { getSongResourceCacheKey } from '../onlineMusic/resourceKeys';
import { useAudioSettingsStore } from '../../stores/useAudioSettingsStore';
import { omni } from '../onlineMusic/omni';
import { nativeAudioUrlForRef } from '../nativeLocalMusic';
import { getPlaybackSongKey, getPlaybackSourceRef } from '../../utils/appPlaybackGuards';
import type { PlaybackRepresentation } from '../../types/playbackRecovery';

// src/services/beatFx/beatFxSource.ts
// Where the beat FX get the playing track's beat list from.
//
// analysis/beatGrid.ts answers it: the list stored for this track by an earlier play, or the run of
// it already in flight, or a run now on the track's own bytes. The model is Beat This!'s final0,
// packaged with the app, and the list is automix's too: whichever of the two reaches a track first
// runs it, and the other reads the list.
//
// The bytes are what is already on this machine (analysis/trackAudio.ts): the playback
// representation, the media cache, the local file. An online track is only cached once played to the
// end, so one not cached yet is read once more from the stream URL its playback resolved (the
// prefetch entry for that very song, never another's): its beats arrive a few seconds into its first
// play instead of on its second (the user chose this over waiting, 2026-10-17). Only analysed, not
// cached: the media cache keeps its own rule of fully played tracks. Before playback has resolved
// that URL there are no bytes yet, and `retry` says so. A stream that is not the whole song (a
// preview clip, wholeSongCheck.ts) is not analysed: its beats would be stored as the song's.
//
// The bytes are read once for the beats, the drum hits and automix alike (analysis/trackBytes.ts):
// whichever asks first reads them, the others are handed a copy.
//
// The run is on the renderer's GPU only - the beat FX never ask for the CPU fallback automix may use -
// so a machine whose GPU cannot take it gets no beats - and the visualizer its original picture - rather than a CPU inference competing
// with playback for the length of a track.
//
// The beats come with their accents (analysis/beatAccents.ts) when the list was stored with them. A
// list stored without them (by a CPU run of automix's, or before accents existed) answers at once
// without them - the beat FX as they were - and
// `accented` brings the same beats with accents once they are measured, for the caller to swap in.
//
// The track's drum hits (`loadBeatFxTrackDrums`, analysis/drumHits.ts: htdemucs' drum stem on the
// GPU) are read on their own, from the same bytes, only when a live effect
// on screen plays them (时计's 仿真鼓面), as they cost the track's bytes and seconds of GPU. They no
// longer wait on the beats: a picture that plays only drum hits never runs beat_this.
//
// Under 智能动感模式's `cached` (`storedOnly`) both are read from what is stored and nothing else: no
// bytes read, no decode, no model run - not even the accents of a list stored without them, which
// then plays without, as a CPU-stored list always did. A beat list automix is analysing right now is
// waited for, as it runs either way. A track with nothing stored answers 'none' and is not asked
// again during the play.

export type BeatFxSourceKind = 'beat_this' | 'none';

export interface BeatFxTrackBeats {
    events: BeatFxEvent[];
    source: BeatFxSourceKind;
    /** Why there are no beats, when there are none. */
    note?: string;
    /** No beats only because the track's bytes are not to be had yet; worth asking again shortly. */
    retry?: boolean;
    /** The track's dynamics scale (0.45..1); 1 without accents. */
    trackScale: number;
    /** The same beats with accents, when these came without; null if they cannot be measured now. */
    accented?: Promise<BeatFxTrackBeats | null>;
}

const memory = new Map<string, Promise<BeatFxTrackBeats>>();

/** 预取里那个还有效的远端地址；没有就 null。 */
const prefetchedStreamUrl = (song: SongResult): string | null => {
    const prefetched = getPrefetchedData(song);
    const url = prefetched?.audioUrl;
    if (!url || url === 'CACHED_IN_DB' || !isUrlValid(prefetched.audioUrlFetchedAt) || !/^https?:/.test(url)) return null;
    return url;
};

/**
 * 分析要用的远端音频地址：预取里那份，**或者向平台现要一个**。
 *
 * 之前这里只看预取 —— 预取没轮到这首歌（刚加入队列、从歌单点进来）、地址过期（几分钟的
 * TTL）、或者平台正在冷却，分析就直接放弃了，界面上是一句
 * 「track not cached yet, and no stream URL resolved」，而歌明明在放、也明明有鼓
 * （真机反馈 2026-11-13）。歌能播不等于 prefetcher 手里有地址：播放层是自己向平台要的。
 *
 * 所以这里自己再要一次（`warmupSongAudio` 会去重、会回写预取，播放也跟着受益）。
 * 一次分析只问一次：同一个 key 的并发调用共享同一个 Promise。
 */
const streamLookups = new Map<string, Promise<{ url: string | null; why?: string }>>();

const resolveStreamUrl = (song: SongResult): Promise<{ url: string | null; why?: string }> => {
    if (getPlaybackSourceRef(song).kind !== 'online') return Promise.resolve({ url: null });
    const known = prefetchedStreamUrl(song);
    if (known) return Promise.resolve({ url: known });

    const lookupKey = getPlaybackSongKey(song);
    const running = streamLookups.get(lookupKey);
    if (running) return running;

    const pending = (async () => {
        // 这首歌由平台自己的播放器播：本 App 从来没有它的音频流，分析无从谈起。
        if (omni.canPlayExternally(song)) {
            return { url: null, why: 'this track is played by its own app, so there is no audio here to analyse' };
        }
        if (getPrefetchedData(song)?.audioUrl === 'CACHED_IN_DB') {
            return { url: null, why: 'the copy in the media cache cannot be read' };
        }
        try {
            const warmed = await warmupSongAudio(song, useAudioSettingsStore.getState().audioQuality);
            if (warmed?.audioUrl && warmed.audioUrl !== 'CACHED_IN_DB') return { url: warmed.audioUrl };
            if (warmed?.audioUrl === 'CACHED_IN_DB') return { url: null, why: 'the copy in the media cache cannot be read' };
            return { url: null, why: 'the platform gave no audio address' };
        } catch (error) {
            console.warn('[BeatFx] asking the platform for the track\'s audio failed', error);
            return { url: null, why: `the platform gave no audio address (${String(error)})` };
        }
    })().finally(() => {
        streamLookups.delete(lookupKey);
    });
    streamLookups.set(lookupKey, pending);
    return pending;
};

/** An online track's bytes from the stream URL its playback resolved, if there is a live one. */
const readStreamedTrackBytes = async (song: SongResult): Promise<ArrayBuffer | null> => {
    if (getPlaybackSourceRef(song).kind !== 'online') return null;
    const { url, why } = await resolveStreamUrl(song);
    if (!url) {
        if (why) console.info(`[BeatFx] no stream for this track: ${why}`);
        return null;
    }
    try {
        /*
         * ★ 安卓：先让原生把音频落到磁盘，再读本地那份。
         *
         * 不能在这里直接 fetch(url)。整首歌是 5~15MB 的二进制，而 Capacitor 的
         * HTTP 桥有 8MiB 的响应上限（FoliaNativePlugin.DEFAULT_MAX_RESPONSE_BYTES），
         * 超了就是一句 "Native HTTP response exceeds the bridge size limit" ——
         * 仿真鼓面因此在手机上一次都没跑起来过。放宽上限也不行：过桥时
         * byte[] → base64 → 整份 JSON 会放大近 8 倍，20MB 就能撞穿 256MB 堆（#261）。
         *
         * 所以音频根本不过桥：让原生自己拉流、写进它自己的媒体缓存目录，
         * 回来的只是一个回环地址（http://127.0.0.1:<port>/media-cache/<key>），
         * 那个地址是本机直连，不再经过任何 IPC。这也正好是「资源先落本地」的规矩。
         *
         * 失败就返回 null，走原来的 fetch —— 桌面端那条路一直是对的，别动它。
         */
        if (isNativeModelsAvailable() && await hasNativeMediaCache()) {
            const cacheKey = getSongResourceCacheKey('audio', song);
            const stored = await cacheNativeMediaFromUrl(cacheKey, url, MAX_STREAM_CACHE_BYTES, song.durationMs);
            if (stored) {
                const localUrl = await readNativeMediaCacheUrl(cacheKey);
                if (localUrl) {
                    const local = await fetch(localUrl);
                    if (local.ok) {
                        const localBlob = await local.blob();
                        const notTheSong = await whyNotTheSong(song, localUrl, localBlob);
                        if (!notTheSong) return await localBlob.arrayBuffer();
                        console.info(`[BeatFx] not analysing the cached stream: it is ${notTheSong}`);
                        return null;
                    }
                }
            }
        }
        const response = await fetch(url);
        const blob = await response.blob();
        // An error page or a cut-off download decoded would be stored as this track's beats.
        if (!isCacheableAudioResponse(response, blob)) return null;
        // Kept for automix too (trackBytes.ts), whose rule is the whole song only.
        const notTheSong = await whyNotTheSong(song, url, blob);
        if (notTheSong) {
            console.info(`[BeatFx] not analysing the stream: it is ${notTheSong}`);
            return null;
        }
        return await blob.arrayBuffer();
    } catch (error) {
        console.warn('[BeatFx] could not read the stream for beats', error);
        return null;
    }
};
const MAX_TRACKS = 24;

/**
 * 为分析而缓存一首流媒体歌曲时允许的最大字节数。
 *
 * 40MB 覆盖到约 20 分钟的无损单曲；再大的（整场现场）不做缓存，
 * 直接放弃这次分析 —— 鼓面效果不值得为它占掉几十兆磁盘。
 */
const MAX_STREAM_CACHE_BYTES = 40 * 1024 * 1024;

interface TrackBytes {
    bytes: ArrayBuffer | null;
    /** Why there are none, when there are none. */
    note?: string;
    /** Where they came from (trackBytes.ts), for the decode's log line. */
    source: TrackBytesSource;
}

/**
 * The track's bytes as `key` names them: the representation's, or the local copy, or its stream -
 * or another analyser's read of them (trackBytes.ts).
 */
const readTrackBytes = async (song: SongResult, key: string, representation: PlaybackRepresentation | null): Promise<TrackBytes> => {
    let note: string | undefined;
    const { bytes, source } = await loadTrackBytes(key, async () => {
        const found = await readLocalTrackBytes(song, { representation });
        let read = found && 'bytes' in found ? found.bytes : null;
        // A representation's bytes are what the key names; an online track's stream is read only
        // when there is none.
        if (!read && !representation) read = await readStreamedTrackBytes(song);
        if (!read) note = found && 'skipped' in found ? found.skipped : undefined;
        return read;
    });
    if (bytes) return { bytes, source };
    return { bytes: null, note: note ?? 'track not cached yet, and no stream URL resolved', source };
};

/**
 * 这首歌的音频地址，交给**原生**解码（drumHits.ts 的混音频带）。
 *
 * 和 `readStreamedTrackBytes` 前半段是同一件事：在线曲目先让原生把音频落到媒体缓存里，
 * 回来的只是一个回环地址。区别是这里不 fetch 成 ArrayBuffer —— 原生解码器自己去读那个
 * 地址，整曲 PCM 一个字节都不过桥（8MiB 的桥上过不去，见那边的注释）。
 *
 * 已经缓存过就直接返回地址，几毫秒。本地曲目返回 null：它们的路径在 Web 层拿不到，
 * 仍旧走 WebView 那条解码路（fast enough for a file already on the phone's flash）。
 */
const resolveNativeAudioUrl = async (song: SongResult): Promise<string | null> => {
    if (!isNativeModelsAvailable()) return null;
    if (getPlaybackSourceRef(song).kind !== 'online') return null;
    const { url } = await resolveStreamUrl(song);
    if (!url) return null;
    if (!(await hasNativeMediaCache())) return null;
    try {
        const cacheKey = getSongResourceCacheKey('audio', song);
        const stored = await cacheNativeMediaFromUrl(cacheKey, url, MAX_STREAM_CACHE_BYTES, song.durationMs);
        if (!stored) return null;
        return await readNativeMediaCacheUrl(cacheKey);
    } catch (error) {
        console.warn('[BeatFx] could not prepare the audio for native drum bands', error);
        return null;
    }
};

/**
 * 给一次查找加截止时间。
 *
 * 这条链路上有几处等的是「原生某一步回来」：取音频（在线曲目要把整首落到本地缓存）、
 * 解码、推理。取音频那一端没有连接超时，一个不回包的直链能让它挂到天荒地老 ——
 * 而界面上唯一的显示是「正在分析」，于是看起来就是永远分析不出来（真机反馈 2026-11-13）。
 * 到点就当作没有结果：状态落到 `none` 并写出原因，下次播放还能重试，
 * 而不是一句不变的话挂在那里。
 */
const BEAT_LOOKUP_TIMEOUT_MS = 200_000;

const withDeadline = <T>(work: Promise<T>, ms: number, what: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(`${what}超过 ${Math.round(ms / 1000)} 秒没有结果`));
        }, ms);
        work.then(
            (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(error);
            },
        );
    });

const resolveTrackBeats = async (
    song: SongResult,
    key: string,
    representation: PlaybackRepresentation | null,
    storedOnly: boolean,
): Promise<BeatFxTrackBeats> => {
    let note = storedOnly ? 'none stored (智能动感模式 uses stored results only)' : 'beat_this returned no beats (no usable GPU, or a failed run)';
    let retry = false;
    let grid: Awaited<ReturnType<typeof getTrackBeatGrid>>;
    const readBytes = async () => {
        const read = await readTrackBytes(song, key, representation);
        if (!read.bytes) {
            // 这首歌的音频拿不到（平台没给地址、缓存里也没有、或由平台自己的播放器播）：
            // 说出真正的原因，别再让用户对着 "track not cached yet" 猜。
            note = read.note
                ? read.note
                : getPlaybackSourceRef(song).kind === 'online'
                    ? '拿不到这首歌的音频：平台没有给出地址，缓存里也没有'
                    : '拿不到这首歌的音频文件';
            retry = true;
        }
        return read;
    };
    const readMid = async () => {
        /*
         * 没有 WebGPU 就不解码 —— 除了安卓：那边的原生推理要的是一段 PCM 的退路，
         * 而它本来就不靠 GPU（权重和推理都在原生侧）。这条判断写在这里会把原生
         * 这条唯一的退路也一起挡掉，真机上就是「设置里开着，画面上什么都不动」。
         */
        if (!isNativeModelsAvailable() && (typeof navigator === 'undefined' || !('gpu' in navigator))) {
            note = 'no WebGPU in this renderer';
            return null;
        }
        const read = await readBytes();
        if (!read.bytes) return null;
        const buffer = await decodeTrackAtRate(key, BEAT_THIS_SAMPLE_RATE, read.bytes, decodeAtRate, 'beats', read.source);
        if (!buffer) {
            note = 'decode failed';
            return null;
        }
        return toMidSide(buffer).mid;
    };
    /*
     * 安卓原生推理的音频地址：给地址，整首歌就不过桥。
     *
     * 本地曲目走原生那台 127.0.0.1 的音频服务；在线曲目先落到原生媒体缓存，再给
     * 那份的回环地址 —— 直接把裸的远端地址交过去，很多平台会因为缺 Referer/Cookie 拒绝。
     * 都拿不到时返回 null，调用方退回「JS 解码 + 传样本」。
     */
    const nativeSourceUrl = async (): Promise<string | null> => {
        if (!isNativeModelsAvailable()) return null;
        const ref = (song as { nativeAudioRef?: string }).nativeAudioRef;
        if (ref) {
            const localUrl = await nativeAudioUrlForRef(ref);
            if (localUrl) return localUrl;
            console.warn('[BeatFx] native: local audio server has no port, cannot hand the track over by url');
        }
        /*
         * 已经在原生媒体缓存里的先问一句。
         *
         * 这一条是「装了包还是没效果」的根因：prefetcher 对已经缓存过的曲子会把
         * audioUrl 报成 'CACHED_IN_DB'（prefetchService.ts 里的哨兵值），下面的远端
         * 分支见到它就 return null —— 于是整首歌退回「JS 解码 + 传样本」，而那条路
         * 只放 45 秒以内的音频（桥的 8MiB），一首四分钟的歌必然放弃：分析从没跑过，
         * 智能动感自然一动不动。缓存里的那份本来就有回环地址，直接给它。
         */
        const cacheKey = getSongResourceCacheKey('audio', song);
        const cachedUrl = await readNativeMediaCacheUrl(cacheKey);
        if (cachedUrl) return cachedUrl;
        const { url, why } = await resolveStreamUrl(song);
        if (!url) {
            console.warn(`[BeatFx] native: no audio source for this track (${why ?? 'no stream URL'})`);
            return null;
        }
        if (!await hasNativeMediaCache()) return null;
        const stored = await cacheNativeMediaFromUrl(cacheKey, url, MAX_STREAM_CACHE_BYTES, song.durationMs);
        if (!stored) {
            console.warn('[BeatFx] native: could not cache the stream for analysis');
            return null;
        }
        return readNativeMediaCacheUrl(cacheKey);
    };
    beginBeatAnalysisProgress();
    try {
        // The picture on screen waits on these: ahead of automix's background profiles on the GPU.
        grid = await withDeadline(
            getTrackBeatGrid(key, readMid, {
                storedOnly,
                urgency: 'onScreen',
                nativeSourceUrl,
                onPartial: (partialBeats, seconds) => {
                    /*
                     * 安卓原生按块交付：第一块（前 45 秒）一两秒就到，先让画面动起来。
                     *
                     * 用户按下的那一刻起，整曲要二十秒以上才算完 —— 等它，等于前半分钟
                     * 什么反应都没有。这里拿到就先装上，后面的块逐次替换，表只会变长。
                     */
                    if (key !== getBeatFxHeard().key) return;
                    const times = partialBeats.map(beat => beat.time);
                    if (!times.length) return;
                    const downbeats = partialBeats.filter(beat => beat.downbeat).map(beat => beat.time);
                    updateBeatFxEvents(key, mergeBeatFxEvents(times, downbeats));
                    console.info(`[BeatFx] partial beats: ${times.length} up to ${seconds.toFixed(0)}s (key=${key})`);
                },
            }),
            BEAT_LOOKUP_TIMEOUT_MS,
            '节拍分析',
        );
    } catch (error) {
        // A throw here (a cache read, a worker, a GPU device lost mid-run) is "no beats" like any
        // other: answered, so the caller's frame falls back, and not remembered, so a later play retries.
        return { events: [], source: 'none', note: `beat lookup failed: ${String(error)}`, trackScale: 1 };
    } finally {
        endBeatAnalysisProgress();
    }
    if (grid?.beats.length) {
        const found = grid;
        if (found.accents || storedOnly) {
            return {
                events: mergeBeatFxEvents(found.beats, found.downbeats, found.accents),
                source: 'beat_this',
                trackScale: found.accents?.trackScale ?? 1,
            };
        }
        // Measured on a worker after the fact; a failure only leaves the beats as they are.
        const accented = getTrackBeatAccents(key, found, readMid)
            .then((accents): BeatFxTrackBeats | null => (accents
                ? {
                    events: mergeBeatFxEvents(found.beats, found.downbeats, accents),
                    source: 'beat_this',
                    trackScale: accents.trackScale,
                }
                : null))
            .catch(() => null);
        return { events: mergeBeatFxEvents(found.beats, found.downbeats), source: 'beat_this', trackScale: 1, accented };
    }
    if (!storedOnly && !canRunBeatThis()) {
        return {
            events: [],
            source: 'none',
            // 安卓这条路不该再落到这里：原生分支在 canRunBeatThis 之前就返回了。真到了，
            // 说明原生那一步没给出结果，日志里的 [BeatGrid] 那几行才是原因。
            note: isNativeModelsAvailable() ? 'native beat analysis produced no beats (see [BeatGrid] log)' : 'not the desktop app',
            trackScale: 1,
        };
    }
    return { events: [], source: 'none', note, trackScale: 1, ...(retry ? { retry } : {}) };
};

/**
 * The beat list for a track and the analysis key it belongs to, computed once per session and shared
 * by concurrent callers. The key and the representation whose bytes are read are resolved together,
 * so a transcode registering mid-analysis cannot file one's beats under the other's key. `storedOnly`
 * (智能动感模式's `cached`) is remembered apart: its answer may lack the accents an `on` lookup adds.
 */
export const loadBeatFxTrackBeats = (song: SongResult, { storedOnly = false } = {}): { key: string; beats: Promise<BeatFxTrackBeats> } => {
    const { key, representation } = getPlaybackAnalysisTarget(song);
    const remembered = storedOnly ? `stored:${key}` : key;
    const existing = memory.get(remembered);
    if (existing) return { key, beats: existing };
    const pending = resolveTrackBeats(song, key, representation, storedOnly);
    memory.set(remembered, pending);
    while (memory.size > MAX_TRACKS) {
        const oldest = memory.keys().next().value;
        if (oldest === undefined) break;
        memory.delete(oldest);
    }
    // A failed lookup is not remembered, so a later play (e.g. once the track is cached) retries.
    void pending.then((result) => {
        if (result.source === 'none' && memory.get(remembered) === pending) memory.delete(remembered);
    });
    return { key, beats: pending };
};

/** How a drum hit lookup ended: hits to play, none for this track, or no bytes yet (ask again). */
export type BeatFxTrackDrums = 'hits' | 'none' | 'retry';

/**
 * Starts reading a track's drum hits (analysis/drumHits.ts) - from the cache, or separated now on the
 * GPU - for a live effect that plays them, under the same analysis key as its beats. 'hits' once
 * `getDrumHits` answers for the key; 'none' for a drumless track, no htdemucs_gpu or no WebGPU;
 * 'retry' when the bytes are not to be had yet (an online track whose stream URL playback has not
 * resolved). The track asked for is the one a separation may run for; the caller says when it is
 * left (`setWantedDrumTrack(null)`) - on a track change or the switch going off, not a picture switch.
 * (Since the analysis service's 2b, a picture switch too: the separation stops and keeps where it was,
 * DrumResume in drumHits.ts; from the PR #750 review.)
 * `storedOnly` (智能动感模式's `cached`): the cache alone, 'hits' or 'none', and no track is wanted.
 * `vocals`: the vocal envelope is read too (analysis/vocalStemRun.ts, a task on the same stem run as
 * the drum hits), and 'hits' once either is in (`getVocalEnvelope` answers for the key). Without it, a
 * voice still being read for the track is let go there (雾笺 back to 时计): the drums carry on.
 */
export const loadBeatFxTrackDrums = (song: SongResult, { storedOnly = false, vocals = false } = {}): { key: string; drums: Promise<BeatFxTrackDrums> } => {
    const { key, representation } = getPlaybackAnalysisTarget(song);
    const found = () => Boolean(getDrumHits(key) || (vocals && getVocalEnvelope(key)));
    if (storedOnly) {
        const drums = Promise.all([loadStoredDrumHits(key), vocals ? loadStoredVocalEnvelope(key) : null])
            .then((): BeatFxTrackDrums => (found() ? 'hits' : 'none'));
        return { key, drums };
    }
    setWantedDrumTrack(key);
    let missing = false;
    const readBytes = async () => {
        const read = await readTrackBytes(song, key, representation);
        if (!read.bytes) missing = true;
        return read.bytes;
    };
    // The voice from where the track was heard when it was asked for (analysis/vocalStemRun.ts), or
    // from earlier if it was sought back before the separation started: what follows the switch is
    // what was asked for, and a run starts seconds later (a stop, a decode).
    const askedAt = getBeatFxLastHeard(key);
    if (!vocals) releaseTrackVocals(key);
    const voice = vocals ? loadTrackVocalEnvelope(key, readBytes, { at: () => Math.min(askedAt, getBeatFxLastHeard(key)), seconds: (song.durationMs || 0) / 1000 }) : null;
    const drums = (async (): Promise<BeatFxTrackDrums> => {
        // 原生的整曲解码先要一个地址（见 `resolveNativeAudioUrl`）；拿不到就走老路。
        const nativeUrl = await resolveNativeAudioUrl(song);
        const [analysis, envelope] = await Promise.all([loadTrackDrumHits(key, readBytes, nativeUrl), voice]);
        return (analysis || envelope) && found() ? 'hits' : missing ? 'retry' : 'none';
    })();
    return { key, drums };
};

/** 画面在读哪首歌的包络；切歌或效果关掉时置空，分离跟着停。 */
let wantedEnvelopeKey: string | null = null;

/** 告诉包络该为哪首歌跑（`null`：谁也不要，停）。 */
export const setWantedEnvelopeTrack = (key: string | null): void => {
    wantedEnvelopeKey = key;
};

/**
 * Starts reading a track's four music envelopes (analysis/musicEnvelope.ts) for the effects that play
 * them - 凝彩's 低频涌动, 人声泛光, 情绪明暗 and 和声错位.
 *
 * They come off the same htdemucs separation the drum hits read (analysis/stemRun.ts): asking for one
 * does not run the model twice. Answers the stored curves at once when they are in (`storedOnly`: only
 * those), and null when there is nothing to read yet - the caller has nothing to wait on, the curves
 * are looked up per frame.
 */
export const loadBeatFxTrackEnvelopes = (
    song: SongResult,
    { storedOnly = false } = {},
): { key: string; envelopes: Promise<MusicEnvelope | null> } => {
    const { key } = getPlaybackAnalysisTarget(song);
    const envelopes = (async (): Promise<MusicEnvelope | null> => {
        const stored = await loadStoredMusicEnvelope(key);
        if (storedOnly || (stored && stored.until === undefined)) return stored;
        setWantedEnvelopeTrack(key);
        // 地址拿不到就没有可分离的东西：库里那份（如果有）照旧交出去。
        const url = await resolveNativeAudioUrl(song);
        if (!url) return stored;
        return await loadTrackMusicEnvelope(key, url, { wanted: () => wantedEnvelopeKey === key }) ?? stored;
    })().catch((error) => {
        console.warn('[BeatFx] music envelopes failed', error);
        return null;
    });
    return { key, envelopes };
};
