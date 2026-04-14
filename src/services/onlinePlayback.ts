import { LyricData, SongResult } from '../types';
import { getFromCache, getFromCacheWithMigration, saveToCache } from './db';
import { getOnlineSongCacheKey, isCloudSong, neteaseApi } from './netease';
import { PrefetchedSongData, isUrlValid } from './prefetchService';
import { isPureMusicLyricText } from '../utils/lyrics/pureMusic';
import { migrateLyricDataRenderHints } from '../utils/lyrics/renderHints';
import { processNeteaseLyrics } from '../utils/lyrics/neteaseProcessing';

const normalizeAudioUrl = (url?: string | null) => {
    if (!url) return null;
    return url.startsWith('http:') ? url.replace('http:', 'https:') : url;
};

export async function loadOnlineSongAudioSource(
    song: SongResult,
    audioQuality: string,
    prefetched: PrefetchedSongData | null
): Promise<
    | { kind: 'ok'; audioSrc: string; blobUrl?: string }
    | { kind: 'unavailable' }
> {
    const audioCacheKey = getOnlineSongCacheKey('audio', song);
    const cachedAudioBlob = await getFromCache<Blob>(audioCacheKey);
    if (cachedAudioBlob) {
        const blobUrl = URL.createObjectURL(cachedAudioBlob);
        return { kind: 'ok', audioSrc: blobUrl, blobUrl };
    }

    if (prefetched?.audioUrl && prefetched.audioUrl !== 'CACHED_IN_DB' && isUrlValid(prefetched.audioUrlFetchedAt)) {
        return { kind: 'ok', audioSrc: prefetched.audioUrl };
    }

    const urlRes = await neteaseApi.getSongUrl(song.id, audioQuality);
    const url = normalizeAudioUrl(urlRes.data?.[0]?.url);
    if (!url) {
        return { kind: 'unavailable' };
    }

    return { kind: 'ok', audioSrc: url };
}

export async function loadOnlineSongLyrics(
    song: SongResult,
    prefetched: PrefetchedSongData | null,
    userId: number | null | undefined,
    callbacks: {
        isCurrent: () => boolean;
        onLyrics: (lyrics: LyricData | null) => void;
        onPureMusicChange?: (isPureMusic: boolean) => void;
        onDone: () => void;
    }
): Promise<void> {
    const { isCurrent, onLyrics, onPureMusicChange, onDone } = callbacks;
    const lyricCacheKey = getOnlineSongCacheKey('lyric', song);

    const cachedLyrics = await getFromCacheWithMigration<LyricData>(lyricCacheKey, migrateLyricDataRenderHints);
    if (!isCurrent()) return;
    if (cachedLyrics) {
        const cachedText = cachedLyrics.lines.map(line => line.fullText).join('\n');
        onPureMusicChange?.(isPureMusicLyricText(cachedText));
        onLyrics(cachedLyrics);
        onDone();
        return;
    }

    if (prefetched?.lyricRaw?.isPureMusic && !prefetched.lyrics) {
        onPureMusicChange?.(true);
        onLyrics(null);
        onDone();
        return;
    }

    if (prefetched?.lyrics) {
        const prefetchedText = prefetched.lyrics.lines.map(line => line.fullText).join('\n');
        onPureMusicChange?.(prefetched.lyricRaw?.isPureMusic || isPureMusicLyricText(prefetchedText) || isPureMusicLyricText(prefetched.lyricRaw?.mainLrc));
        onLyrics(prefetched.lyrics);
        saveToCache(lyricCacheKey, prefetched.lyrics);
        onDone();
        return;
    }

    const lyricRes = isCloudSong(song) && userId
        ? await neteaseApi.getCloudLyric(userId, song.id)
        : await neteaseApi.getLyric(song.id);
    const processed = await processNeteaseLyrics(neteaseApi.getProcessedLyricPayload(lyricRes));
    const parsedLyrics = processed.lyrics;

    if (!isCurrent()) return;
    onPureMusicChange?.(processed.isPureMusic);

    if (!parsedLyrics) {
        onLyrics(null);
        onDone();
        return;
    }

    onLyrics(parsedLyrics);
    saveToCache(lyricCacheKey, parsedLyrics);
    onDone();
}
