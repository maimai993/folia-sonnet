import type { SongResult } from '../types';
import { notifyAudioCached, saveAudioBlob } from './audioCache';
import { saveToCache } from './db';
import { omni } from './onlineMusic/omni';
import { hasProviderKeptSongAudio, keepProviderSongAudio, keepsOwnSongAudio } from './onlineMusic/providerRegistry';
import { hasCachedSongAudio, hasCachedSongCover, saveSongAudioLevel } from './onlineMusic/resourceCache';
import { getSongResourceCacheKey } from './onlineMusic/resourceKeys';
import { getProviderSongMetadata } from './onlineMusic/songMetadata';
import { clearCachedSongAudioDistrust, isCachedSongAudioDistrusted, isCacheableAudioResponse } from './playbackRecovery/mediaCacheGuard';
import { getPlaybackSongKey, getPlaybackSourceRef } from '../utils/appPlaybackGuards';
import { mayStoreSongAudio, whyPreviewClip } from './wholeSongCheck';
import { cacheNativeMediaFromUrl, hasNativeMediaCache } from './mediaCacheStore';
import { cacheLimitBytes } from './audioCache';

// src/services/playedTrackCache.ts

/** How near its end a looping track has to have been, and how near its start it has to be now, seconds. */
const LOOP_WRAP_WINDOW_SECONDS = 1.5;

/**
 * Whether a track on single loop (`<audio loop>`) just wrapped from its end back to its start. A
 * looping element never fires `ended` - it seeks itself back to 0 - so this stands in for it: a
 * track that ran through to its end has been played in full and is cached like one that ended.
 * `previous` and `current` are two successive positions of the same source.
 */
export const hasLoopedToStart = (previous: number, current: number, duration: number): boolean => (
    Number.isFinite(duration)
    && duration > 2 * LOOP_WRAP_WINDOW_SECONDS
    && previous >= duration - LOOP_WRAP_WINDOW_SECONDS
    && current <= LOOP_WRAP_WINDOW_SECONDS
);

/** What a call actually wrote, so a caller can skip refreshing a cache-usage readout for nothing. */
export type PlayedTrackCacheResult = { audio: boolean; cover: boolean };

const NOTHING_WRITTEN: PlayedTrackCacheResult = { audio: false, cover: false };

/*
 * 写失败的歌，本会话内记着，下次有机会时再试（#156）。
 *
 * 写缓存是「播完之后再整份下载一次」。源站一次 5xx / 超时 / CDN 地址过期，这一次写就失败了；
 * 旧代码只打一行 console.error 就收工，这首歌在本会话里再也没有第二次写入机会 ——
 * 用户看到的是「有时候能缓存上，有时候缓存不上」。留个待补记录，下一次播到这首歌时
 * （或者它被完整播放结束时）再写一次，才算把这一下落空补上。
 *
 * 只在会话内有效，和 mediaCacheGuard 的 distrust 标记同一个口径：这是「这次没存成」的
 * 运行期状态，不是用户数据，不该落盘。
 */
const pendingAudioWrites = new Set<string>();

/** 这首歌上次写缓存失败了，本会话内还没补上。 */
export const isCacheWritePending = (song: SongResult): boolean => (
    pendingAudioWrites.has(getSongResourceCacheKey('audio', song))
);

/** 写成功（或被判定为本来就不该存）之后清掉待补记录。 */
const forgetPendingAudioWrite = (song: SongResult): void => {
    pendingAudioWrites.delete(getSongResourceCacheKey('audio', song));
};

/**
 * Stores a fully-played track's audio and cover in the media cache.
 *
 * Takes the song and its source explicitly rather than reading the app's current track, because the
 * automix settle path caches the track that just faded OUT - and by then the app's own state already
 * names the track that arrived. `coverUrl` is the currently-displayed cover (which may carry a user
 * override); left undefined - the automix path - the cover comes from the song's own metadata.
 *
 * The two resources are asked about separately, and that separation is the point. They are pruned
 * under different categories, so "audio still cached, cover already gone" is a state ordinary use
 * reaches; while one early return covered both, such a track could never get its cover back, and a
 * blob-source track could never cache a cover at all. Neither resource's presence says anything
 * about the other's.
 */
export const cachePlayedTrackAssets = async (
    song: SongResult | null,
    src: string | null,
    coverUrl?: string | null,
): Promise<PlayedTrackCacheResult> => {
    if (!song) return NOTHING_WRITTEN;

    const result: PlayedTrackCacheResult = { audio: false, cover: false };

    // The quality level `src` was fetched at, as noted when the URL was handed out - not the quality
    // option as it stands now, which may have been moved while the song played. "No copy yet" below
    // means no copy of this level: a copy of another one is written over (by a file that is the
    // whole song, see below), and playback, which passed it over to play this URL, finds the new
    // one the next time. Undefined for a URL no provider handed out (a local or Navidrome song),
    // and then any copy counts, as before.
    const level = src ? omni.levelOfAudioSource(src) : undefined;
    // A URL its provider marked as a preview clip is never stored (wholeSongCheck.ts), so it is not
    // downloaded either.
    const previewClip = whyPreviewClip(src);

    // Audio needs a source that can actually be refetched: a blob: URL is this session's own handle
    // to bytes that are either already cached or on disk, so there is nothing to fetch and store.
    if (previewClip) {
        console.log(`[Cache] ${getPlaybackSongKey(song)} not stored, the URL it played from is ${previewClip}`);
        // 这个地址本来就不该存，重试也没有意义：不留待补记录。
        forgetPendingAudioWrite(song);
    } else if (src && !src.startsWith('blob:') && keepsOwnSongAudio(song)) {
        // A provider with a cache of its own keeps the file there; nothing of it is read here.
        if (!await hasProviderKeptSongAudio(song, src) && await keepProviderSongAudio(song, src)) {
            notifyAudioCached(getSongResourceCacheKey('audio', song), src);
            result.audio = true;
            console.log('[Cache] Fully played song kept by its provider:', song.name);
        }
    } else if (src && !src.startsWith('blob:') && (!await hasCachedSongAudio(song, level) || isCachedSongAudioDistrusted(song))) {
        // A copy that failed to decode in this session (mediaCacheGuard.ts) is written over by this
        // download where it passes, though a copy is there.
        //
        // 上一次写失败了（#156）也走这里：这正是「补上一次没写成的」那条路。
        const retrying = isCacheWritePending(song);
        console.log(retrying ? '[Cache] Retrying a fully played song whose write failed earlier:' : '[Cache] Caching fully played song:', song.name);
        try {
            // 安卓优先走原生下载：字节不出网到 Web 再绕回来，WebView 冻结时这条路
            // 照样能存。试听片段的校验在原生做（MediaExtractor 探时长，同一条
            // 「不足歌长一半不存」的规则）；原生没接上（老包 / 非安卓）才回落 Web 抓字节。
            const metadata = getProviderSongMetadata(song);
            /*
             * 原生那条是**快路**，不是唯一的路。
             *
             * 它每次都用 HttpURLConnection 重新拉一遍 URL：源站一次 5xx / 超时就存不下，
             * 而这里要是「原生的路都到头了」直接收工，这首歌就整个会话再也不缓存了 ——
             * 用户看到的是「有的歌存了、有的没存」。所以原生没存成时照样往下走 Web 那条：
             * 后台跑不完最多是白试一次，前台时它是真的能救回来。
             */
            let storedNatively = false;
            if (await hasNativeMediaCache()) {
                const writesOver = await hasCachedSongAudio(song);
                const stored = await cacheNativeMediaFromUrl(
                    getSongResourceCacheKey('audio', song),
                    src,
                    cacheLimitBytes(),
                    metadata.durationMs || 0,
                );
                if (stored) {
                    storedNatively = true;
                    if (writesOver) await saveSongAudioLevel(song, undefined);
                    await saveSongAudioLevel(song, level);
                    clearCachedSongAudioDistrust(song);
                    result.audio = true;
                    notifyAudioCached(getSongResourceCacheKey('audio', song), src);
                    console.log(`[Cache] Audio saved by native download, fetched at ${level ?? 'an unknown level'}`);
                } else {
                    console.log('[Cache] Native download declined to store, falling back to the web path:', song.name);
                }
            }
            if (!storedNatively) {
                const response = await fetch(src);
                // An error page is a body too: without this check it is stored as the track's audio.
                if (!response.ok) throw new Error(`Audio request failed with status ${response.status}`);
                const blob = await response.blob();
                // An error page, a JSON error or a cut-off download is not audio and is never stored: a copy
                // plays before what the provider gives, so a bad one would stand in for the song for good.
                if (!isCacheableAudioResponse(response, blob)) {
                    console.warn('[Cache] Skipped caching a download that does not look like audio:', song.name, {
                        status: response.status,
                        contentType: response.headers?.get('content-type') ?? blob.type,
                        size: blob.size,
                    });
                } else {
                    // What a URL gives may still be less than the song (a clip its provider did not mark),
                    // and playback plays it as it comes. A file under half the song is never stored, and a
                    // copy on disk (of another level) is written over only by a file proven to be the whole
                    // song (wholeSongCheck.ts).
                    const writesOver = await hasCachedSongAudio(song);
                    const check = await mayStoreSongAudio(song, src, blob, writesOver);
                    if (!check.store) {
                        const what = writesOver ? `Copy of ${getPlaybackSongKey(song)} kept` : `${getPlaybackSongKey(song)} not stored`;
                        console.log(`[Cache] ${what}, the file fetched at ${level ?? 'an unknown level'} is ${check.why}`);
                    } else {
                        // The level saved for the copy goes before the audio is written and the new one
                        // comes after it. `saveToCache` swallows its errors: in the other order a level
                        // write that failed left the new file under the old level's name. Now a failure in
                        // between leaves a copy of an unknown level, which plays at any setting.
                        if (writesOver) await saveSongAudioLevel(song, undefined);
                        await saveAudioBlob(getSongResourceCacheKey('audio', song), blob);
                        await saveSongAudioLevel(song, level);
                        clearCachedSongAudioDistrust(song);
                        result.audio = true;
                        console.log(`[Cache] Audio saved, fetched at ${level ?? 'an unknown level'}`);
                    }
                }
            }
        } catch (error) {
            // 这一下没存成：记进本会话的待补，下次播到这首歌时再写一次（#156）。
            // 只记这一次的错，不在这里重试 —— 源站刚失败，立刻重试只会再失败一次。
            pendingAudioWrites.add(getSongResourceCacheKey('audio', song));
            console.error('[Cache] Failed to download audio for cache; it will be retried this session', error);
        }
    }

    // 真的写进去了（原生、Web 或 provider 自带缓存任一条）：待补记录可以撤了。
    if (result.audio) forgetPendingAudioWrite(song);

    const rawCover = coverUrl !== undefined ? coverUrl : getProviderSongMetadata(song).coverUrl;
    const cover = rawCover?.startsWith('http:') ? rawCover.replace('http:', 'https:') : rawCover;
    // Remote covers, and not for local files. A local song's cover already lives under its own
    // `cover_local_<id>` key written by the library path; a matched online cover stored here would
    // land under `cover_local:<id>` instead - close enough to look right, read by nothing. The
    // `https:` test also keeps out the blob: URL the app hands back for an already-cached cover,
    // which the old code refetched and rewrote on every play.
    const isLocal = getPlaybackSourceRef(song).kind === 'local';
    if (!isLocal && cover?.startsWith('https:') && !await hasCachedSongCover(song)) {
        try {
            const response = await fetch(cover, { mode: 'cors' });
            const blob = await response.blob();
            await saveToCache(getSongResourceCacheKey('cover', song), blob);
            result.cover = true;
            console.log('[Cache] Cover saved');
        } catch (error) {
            console.error('[Cache] Failed to download cover for cache', error);
        }
    }

    return result;
};
