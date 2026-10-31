import { LyricData, OnlineLyricsState, ReplayGainInfo, SongResult } from '../types';
import { saveToCache } from './db';
import { PrefetchedSongData, isUrlValid, updatePrefetchedAudioUrl } from './prefetchService';
import { isPureMusicLyricText } from '../utils/lyrics/pureMusic';
import { migrateLyricDataRenderHints } from '../utils/lyrics/renderHints';
import { loadOnlineLyricsState, markOnlineLyricsPureMusic, resolveOnlineLyrics, resolveOnlineLyricsPureMusic, saveOnlineLyricsState } from '../utils/onlineLyricsState';
import { autoMatchBestLyric } from '../utils/lyrics/autoMatchBestLyric';
import { getPlatformLyricSource } from '../utils/lyrics/lyricSources';
import { resolveLyricSourcePreference } from '../utils/lyrics/lyricSourcePreference';
import { createSafeObjectUrl } from '../utils/blobGuards';
import type { AudioQualityPreference, MediaId, ProviderAudioSource } from '../types/onlineMusic';
import { omni } from './onlineMusic/omni';
import { autoRetryDelaysMs, logOnlineFailure, onlineFailureOf, type OnlineFailure } from './onlineMusic/failure/onlineFailureCase';
import { noteOnlineRequestCooldown, onlineRequestCooldown } from './onlineMusic/failure/onlineRequestCooldown';
import { getSongResourceCacheKey } from './onlineMusic/resourceKeys';
import { readNativeMediaCacheUrl } from './mediaCacheStore';
import { deleteCachedSongAudio, getCachedSongAudioBlob, getCachedSongReplayGain, getSongCacheWithLegacyMigration } from './onlineMusic/resourceCache';
import { measureSongAudio, notTheSongWhy } from './wholeSongCheck';
import { isCachedSongAudioDistrusted } from './playbackRecovery/mediaCacheGuard';
import { toPlayableAudioUrl } from '../utils/appPlaybackHelpers';
import { getOnlineProviderIdForSong } from '../utils/appPlaybackGuards';
import { getProviderSongMetadata } from './onlineMusic/songMetadata';
import { useLyricSettingsStore } from '../stores/useLyricSettingsStore';
import { useOnlineProviderAccountStore } from '../stores/useOnlineProviderAccountStore';
import { saveLyricCacheSongMetadata } from './lyricExport/lyricCacheMetadata';
import { errorFields } from '../utils/errorText';
import { hasRenderableLyrics } from '../utils/lyrics/validity';
import { getLyricSource, isLyricProviderSource } from '../utils/lyrics/lyricSources';
import type { PlatformLyricSource } from '../utils/lyrics/lyricSources';

// How long playback waits for a stored copy's header to give its play length (`wholeCopy`). Past
// it the copy plays untested: the check must not hold up a song that starts from the cache.
const COPY_CHECK_CEILING_MS = 300;

export type OnlineAudioSourceResult =
    // `preview`: the URL plays a preview clip of the song, as its provider said (omni notes it).
    | { kind: 'ok'; audioSrc: string; blobUrl?: string; replayGain?: ReplayGainInfo; preview?: boolean }
    | { kind: 'unavailable'; failure: OnlineFailure };

export interface LoadOnlineAudioSourceOptions {
    // The media cache's copy is passed over: it is the copy that just failed to play.
    bypassMediaCache?: boolean;
    // Where the platform could not be reached, asks again by itself (`autoRetryDelaysMs`) as long as
    // the play that asks is still the one wanted, and says so before each wait.
    retry?: {
        isCurrent: () => boolean;
        onRetrying?: (shown: OnlineFailure, attempt: number) => void;
        sleep?: (ms: number) => Promise<void>;
    };
}

const sleepBeforeRetry = (ms: number): Promise<void> => new Promise(resolve => {
    globalThis.setTimeout(resolve, ms);
});

export async function loadOnlineSongAudioSource(
    song: SongResult,
    audioQuality: AudioQualityPreference,
    prefetched: PrefetchedSongData | null,
    options: LoadOnlineAudioSourceOptions = {},
): Promise<OnlineAudioSourceResult> {
    // The copy in the media cache is taken only where it was fetched at the level the option now
    // means for this song's provider, or at an unknown one. A copy of another level is passed
    // over for a URL of the level asked for: the option decides what plays, cached or not.
    const providerId = getOnlineProviderIdForSong(song) ?? undefined;
    const level = providerId ? omni.resolveAudioQuality(providerId, audioQuality) : undefined;
    // A copy that failed to decode earlier in this session, or that the caller passes over, is not
    // read; a copy that cannot be read is logged and passed over: the platform is asked instead.
    const readCopy = async (atLevel?: AudioQualityPreference): Promise<Blob | null> => {
        if (options.bypassMediaCache || isCachedSongAudioDistrusted(song)) return null;
        try {
            return await getCachedSongAudioBlob(song, atLevel);
        } catch (error) {
            console.warn('[OnlinePlayback] Failed to read the cached audio; asking the provider instead', error);
            return null;
        }
    };
    // A copy proven not to be the song (under half its length) is a clip stored as the song, most
    // likely a preview kept before the writers checked what they store (wholeSongCheck.ts). It is
    // deleted with its level, and the song is asked of its platform as if there were no copy. Only
    // the file measured is deleted: one written since (the end of a play of this song) stays. Any
    // other copy plays, also one whose length cannot be told within the ceiling.
    const wholeCopy = async (blob: Blob | null): Promise<Blob | null> => {
        if (!blob) return null;
        const length = await measureSongAudio(song, blob, COPY_CHECK_CEILING_MS);
        if (length.verdict !== 'clip') return blob;
        let outcome: string;
        try {
            outcome = await deleteCachedSongAudio(song, blob.size) ? 'deleted' : 'left, a newer file is there';
        } catch (error) {
            outcome = `not deleted (${errorFields(error).name})`;
        }
        console.log(`[Cache] Copy of "${song.name}" ${outcome}: it is ${notTheSongWhy(length)}`);
        return null;
    };
    const playCopy = async (copy: Blob | null) => {
        const blob = await wholeCopy(copy);
        if (!blob) return null;
        // Nothing on this path ever asks the provider again, so the stored gain is the only
        // one a cached track can have. Without it every cached track reaches the fader at 0dB.
        let replayGain = song.replayGain ?? prefetched?.replayGain;
        if (!replayGain) {
            replayGain = await getCachedSongReplayGain(song);
            if (replayGain) console.log(`[Cache] ReplayGain recovered for "${song.name}" from the store, not the provider`);
        }
        /*
         * 副本在私有目录里时，播的是它的回环地址，不再包一层 `blob:`。
         *
         * `blob:` 原生播放器吃不下，那首歌就整首回落 <audio>（均衡器照旧有声，
         * 看上去正是「开了原生播放没生效」）。而 `http://127.0.0.1:<port>/media-cache/…`
         * 两边都读得动 —— 原生播放关着的时候也一样用得上这份缓存。
         */
        const cachedUrl = await readNativeMediaCacheUrl(getSongResourceCacheKey('audio', song));
        if (cachedUrl) return { kind: 'ok' as const, audioSrc: cachedUrl, replayGain };
        const blobUrl = createSafeObjectUrl(blob);
        if (!blobUrl) return null;
        return { kind: 'ok' as const, audioSrc: blobUrl, blobUrl, replayGain };
    };
    // Where no URL can be had (offline, a sign-in that has ended, a song taken down), the copy that
    // was passed over for its level is what plays: another level is better than no song.
    const playCopyOfAnyLevel = async () => {
        const played = level ? await playCopy(await readCopy()) : null;
        if (played) console.log(`[Cache] No URL for "${song.name}": its copy of another level plays`);
        return played;
    };

    const fromCopy = await playCopy(await readCopy(level));
    if (fromCopy) return fromCopy;

    if (prefetched?.audioUrl && prefetched.audioUrl !== 'CACHED_IN_DB' && isUrlValid(prefetched.audioUrlFetchedAt)) {
        return {
            kind: 'ok',
            audioSrc: prefetched.audioUrl,
            replayGain: song.replayGain ?? prefetched.replayGain,
            preview: omni.isPreviewAudioSource(prefetched.audioUrl),
        };
    }

    // No address: what went wrong is logged, also where a copy of another level then plays.
    const unavailable = async (failure: OnlineFailure, error?: unknown) => {
        logOnlineFailure(failure, error);
        return await playCopyOfAnyLevel() ?? { kind: 'unavailable' as const, failure };
    };
    const sleep = options.retry?.sleep ?? sleepBeforeRetry;
    for (let attempt = 0; ; attempt += 1) {
        // The platform asked to wait and the wait is not over: it is not asked again before then.
        const cooldown = providerId ? onlineRequestCooldown(providerId, 'play') : null;
        if (cooldown) {
            return await unavailable(onlineFailureOf(
                { operation: 'audio', providerId },
                { detail: { case: 'retry-later', retryAfterMs: cooldown.remainingMs } },
            ));
        }
        // Read before the request: a transport that is refused may drop the session it had, and
        // read after it, a sign-in that ran out would look like one there never was.
        const signedOut = providerId ? useOnlineProviderAccountStore.getState().accounts[providerId]?.status === 'anonymous' : false;
        let source: ProviderAudioSource | null = null;
        let thrown: unknown;
        try {
            source = await omni.getAudioSource(song, audioQuality);
        } catch (error) {
            thrown = error ?? new Error('The audio source request failed');
        }
        const url = thrown === undefined ? toPlayableAudioUrl(source?.url) : null;
        if (url) {
            const replayGain = applyOnlineAudioSourceMetadata(song, source?.replayGain).replayGain;
            updatePrefetchedAudioUrl(song, url, audioQuality, replayGain);
            return { kind: 'ok', audioSrc: url, replayGain, preview: omni.isPreviewAudioSource(url) };
        }
        const failure = thrown === undefined
            // A provider (a mod's) that answers null, or an address that may not be played.
            ? onlineFailureOf({ operation: 'audio', providerId, signedOut }, { detail: { case: 'no-audio' } })
            : onlineFailureOf({ operation: 'audio', providerId, signedOut }, { error: thrown });
        noteOnlineRequestCooldown(failure);

        const delays = autoRetryDelaysMs(failure);
        const retry = options.retry;
        if (retry && attempt < delays.length && retry.isCurrent()) {
            logOnlineFailure(failure, thrown);
            retry.onRetrying?.(failure, attempt + 1);
            await sleep(delays[attempt]);
            if (!retry.isCurrent()) return { kind: 'unavailable', failure };
            continue;
        }
        return await unavailable(failure, thrown);
    }
}

export const applyOnlineAudioSourceMetadata = (
    song: SongResult,
    replayGain?: ReplayGainInfo,
): SongResult => replayGain
    ? { ...song, replayGain: { ...song.replayGain, ...replayGain } }
    : song;


/*
 * 原平台没给词时去别的来源找一条。
 *
 * 在线歌曲以前只问自己那个平台：原平台回空（封控、未登录、该曲没有词）就一路空到底，界面上
 * 就是「匹配不上歌词」。这里把已有的跨来源匹配（`autoMatchBestLyric`，本地歌曲那条路一直在用）
 * 接进在线这首歌的自动匹配：按设置里的来源优先顺序问一遍、逐字优先于逐行、低于评分阈值
 * 宁可不显示。`providerCandidate` 把刚拿到的那份原平台结果带进去，省一次重复请求，也让它
 * 的合唱标记能借给赢家。
 */
const matchLyricsFromOtherSources = async (
    song: SongResult,
    processed: { lyrics: LyricData | null; isPureMusic: boolean },
): Promise<LyricData | null> => {
    const settings = useLyricSettingsStore.getState();
    if (!settings.autoUseBestLyric) return null;
    const rawProvider = (song.sourceRef as { providerId?: string } | undefined)?.providerId;
    const providerId = isLyricProviderSource(rawProvider) && getLyricSource(rawProvider).platform
        ? rawProvider as PlatformLyricSource
        : undefined;
    const preferred = isLyricProviderSource(settings.preferredAlternativeLyricSource)
        ? settings.preferredAlternativeLyricSource
        : undefined;
    const artist = Array.isArray(song.artists) ? song.artists.map(item => item.name).filter(Boolean).join(' / ') : '';
    try {
        const match = await autoMatchBestLyric(song.name, artist, Number(song.durationMs ?? 0), {
            ...(song.album?.name ? { album: song.album.name } : {}),
            ...(preferred ? { preferredSource: preferred } : {}),
            ...(providerId
                ? {
                    providerCandidate: {
                        providerId,
                        song,
                        lyricsResult: {
                            lyrics: processed.lyrics,
                            isPureMusic: processed.isPureMusic,
                            chorusRanges: [],
                        },
                    },
                }
                : {}),
        });
        if (!match || !('lyrics' in match) || !match.lyrics) return null;
        console.info('[Lyrics] borrowed lyrics from another source:', match.source);
        return match.lyrics;
    } catch (error) {
        console.warn('[Lyrics] borrowing lyrics from other sources failed:', error);
        return null;
    }
};

export async function loadOnlineSongLyrics(
    song: SongResult,
    prefetched: PrefetchedSongData | null,
    userId: MediaId | null | undefined,
    callbacks: {
        isCurrent: () => boolean;
        onLyrics: (lyrics: LyricData | null) => void;
        onPureMusicChange?: (isPureMusic: boolean) => void;
        onStateChange?: (state: OnlineLyricsState | null) => void;
        onAutoMatchStart?: () => void;
        onDone: () => void;
    }
): Promise<void> {
    const { isCurrent, onLyrics, onPureMusicChange, onStateChange, onAutoMatchStart, onDone } = callbacks;
    const lyricCacheKey = getSongResourceCacheKey('lyric', song);
    const onlineLyricsState = await loadOnlineLyricsState(song);
  const initialSettingsLyricSettings = useLyricSettingsStore.getState();

    if (!isCurrent()) return;
    onStateChange?.(onlineLyricsState);

    const cachedLyrics = await getSongCacheWithLegacyMigration<LyricData>('lyric', song, migrateLyricDataRenderHints);
    if (!isCurrent()) return;
    const preferredCachedLyrics = resolveOnlineLyrics(onlineLyricsState, cachedLyrics);
    const hasAuthoritativeLyricsSelection = onlineLyricsState?.lyricsSource === 'imported'
        || Boolean(onlineLyricsState?.hasOnlineOverride);
    if (preferredCachedLyrics && (hasAuthoritativeLyricsSelection || !initialSettingsLyricSettings.autoUseBestLyric)) {
        const cachedText = preferredCachedLyrics.lines.map(line => line.fullText).join('\n');
        onPureMusicChange?.(resolveOnlineLyricsPureMusic(onlineLyricsState, cachedText));
        onLyrics(preferredCachedLyrics);
        onDone();
        return;
    }

    if (prefetched?.lyricRaw?.isPureMusic && !prefetched.lyrics
        && (hasAuthoritativeLyricsSelection || !initialSettingsLyricSettings.autoUseBestLyric)) {
        onPureMusicChange?.(true);
        onLyrics(null);
        onDone();
        return;
    }

    if (prefetched?.lyrics) {
        const preferredPrefetchedLyrics = resolveOnlineLyrics(onlineLyricsState, prefetched.lyrics);
        const effectiveLyrics = preferredPrefetchedLyrics ?? prefetched.lyrics;

  const settingsLyricSettings = useLyricSettingsStore.getState();
        const shouldAutoMatch = settingsLyricSettings.autoUseBestLyric && !onlineLyricsState?.hasOnlineOverride;

        if (!shouldAutoMatch) {
            const effectiveText = effectiveLyrics?.lines.map(line => line.fullText).join('\n') ?? '';
            onPureMusicChange?.(
                onlineLyricsState?.lyricsSource === 'online' && typeof onlineLyricsState.matchedIsPureMusic === 'boolean'
                    ? onlineLyricsState.matchedIsPureMusic
                    : (prefetched.lyricRaw?.isPureMusic || isPureMusicLyricText(effectiveText) || isPureMusicLyricText(prefetched.lyricRaw?.mainLrc))
            );
            onLyrics(effectiveLyrics);
            saveToCache(lyricCacheKey, prefetched.lyrics);
            saveLyricCacheSongMetadata(song);
            onDone();
            return;
        }
    }

    const processed = prefetched?.lyrics
        ? {
            mainLrc: prefetched.lyricRaw?.mainLrc ?? null,
            yrcLrc: prefetched.lyricRaw?.yrcLrc ?? null,
            transLrc: prefetched.lyricRaw?.transLrc ?? null,
            isPureMusic: prefetched.lyricRaw?.isPureMusic ?? false,
            lyrics: prefetched.lyrics,
            chorusRanges: [],
          }
        : await (async () => {
            const result = await omni.getLyrics(song, { userId });
            return {
                mainLrc: result.mainText ?? null,
                yrcLrc: result.wordByWordText ?? null,
                transLrc: result.translationText ?? null,
                isPureMusic: result.isPureMusic,
                lyrics: result.lyrics,
                chorusRanges: result.chorusRanges || [],
            };
        })();
    const parsedLyrics = processed.lyrics;

    if (!isCurrent()) return;

    // 原平台没词：去所有来源找一条（自动匹配开关关着就不找）。
    const borrowedLyrics = hasRenderableLyrics(parsedLyrics) ? null : await matchLyricsFromOtherSources(song, processed);
    /*
     * 借来的词不能被「原平台那份是空的」这个状态盖掉：`resolveOnlineLyrics` 在状态说
     * 「来源是在线、但没有词」时会返回 null，于是借到的词白借（真机：日志里已经
     * `Keeping <source> line-by-line lyrics as fallback`，界面上却没有词，得手动匹配）。
     */
    let resolvedLyrics = borrowedLyrics
        ? (resolveOnlineLyrics(onlineLyricsState, borrowedLyrics) ?? borrowedLyrics)
        : resolveOnlineLyrics(onlineLyricsState, parsedLyrics);
    let finalState = onlineLyricsState;

  const settingsLyricSettings = useLyricSettingsStore.getState();
    const shouldAutoMatch = settingsLyricSettings.autoUseBestLyric && !onlineLyricsState?.hasOnlineOverride;

    if (shouldAutoMatch) {
        // The lyrics in hand are already displayable, so hand them over and report done BEFORE the
        // search below. `onDone` is what releases the audio: playback waits on it, and this search
        // asks every provider for a better lyric file - seconds when it finds none, which is
        // exactly what an instrumental interlude does. Holding the audio for an OPTIONAL upgrade
        // is what turned a song change into several seconds of silence, and with blended changes
        // the outgoing track has already ended by then, so the silence is all the listener gets.
        // A better match, if one turns up, replaces these below.
        if (resolvedLyrics) onLyrics(resolvedLyrics);
        onDone();

        try {
            onAutoMatchStart?.();
            const metadata = getProviderSongMetadata(song);
            const artistName = metadata.artists.map(a => a.name).join(', ');
            const ownProviderId = song.sourceRef?.kind === 'online' ? song.sourceRef.providerId : null;
            const ownLyricSource = getPlatformLyricSource(ownProviderId);
            const bestMatch = await autoMatchBestLyric(song.name, artistName, metadata.durationMs, {
                album: metadata.album?.name,
                preferredSource: resolveLyricSourcePreference(settingsLyricSettings, song),
                alternateArtist: () => omni.getAlternateArtistName(song),
                providerCandidate: ownLyricSource
                    ? {
                        providerId: ownLyricSource.id,
                        song,
                        lyricsResult: {
                            lyrics: parsedLyrics,
                            mainText: processed.mainLrc,
                            wordByWordText: processed.yrcLrc,
                            translationText: processed.transLrc,
                            isPureMusic: processed.isPureMusic,
                            chorusRanges: processed.chorusRanges,
                        },
                    }
                    : undefined
            });
            if (bestMatch && 'lyrics' in bestMatch && bestMatch.source !== ownProviderId) {
                const overrideState: OnlineLyricsState = {
                    lyricsSource: 'online',
                    matchedSongId: bestMatch.id,
                    hasOnlineOverride: true,
                    onlineOverrideLyrics: bestMatch.lyrics,
                    matchedLyricsSource: bestMatch.source,
                    matchedLyricsProviderPlatform: bestMatch.matchedLyricsProviderPlatform,
                };
                await saveOnlineLyricsState(song, overrideState);
                resolvedLyrics = bestMatch.lyrics;
                finalState = overrideState;
                onStateChange?.(overrideState);
            } else if (bestMatch?.isPureMusic) {
                // Checked against `true`, not with `in`: a MATCH object also carries
                // `isPureMusic: false`, so `'isPureMusic' in bestMatch` was true for it too - and
                // a best match from the track's own provider (which fails the branch above) then
                // landed here and had its perfectly good lyrics thrown away as instrumental.
                const pureMusic = markOnlineLyricsPureMusic(onlineLyricsState);
                await saveOnlineLyricsState(song, pureMusic);
                resolvedLyrics = null;
                finalState = pureMusic;
                onStateChange?.(pureMusic);
            }
        } catch (error) {
            console.warn('[OnlinePlayback] Failed to auto-match best lyric:', error);
        }
    }

    if (!isCurrent()) return;

    const resolvedText = resolvedLyrics?.lines.map(line => line.fullText).join('\n') ?? '';
    onPureMusicChange?.(
        finalState?.lyricsSource === 'online' && typeof finalState.matchedIsPureMusic === 'boolean'
            ? finalState.matchedIsPureMusic
            : (resolvedLyrics ? isPureMusicLyricText(resolvedText) : processed.isPureMusic)
    );

    if (!resolvedLyrics) {
        onLyrics(null);
        onDone();
        return;
    }

    onLyrics(resolvedLyrics);
    saveToCache(lyricCacheKey, resolvedLyrics);
    saveLyricCacheSongMetadata(song);
    onDone();
}
