import { LyricData } from '../types';
import { getFromCache, getFromCacheWithMigration, saveToCache } from './db';
import { neteaseApi } from './netease';
import { PrefetchedSongData, isUrlValid } from './prefetchService';
import { isPureMusicLyricText } from '../utils/lyrics/pureMusic';
import { migrateLyricDataRenderHints } from '../utils/lyrics/renderHints';
import { processNeteaseLyrics } from '../utils/lyrics/neteaseProcessing';

const normalizeAudioUrl = (url?: string | null) => {
    if (!url) return null;
    return url.startsWith('http:') ? url.replace('http:', 'https:') : url;
};

export async function loadOnlineSongAudioSource(
    songId: number,
    audioQuality: string,
    prefetched: PrefetchedSongData | null
): Promise<
    | { kind: 'ok'; audioSrc: string; blobUrl?: string }
    | { kind: 'unavailable' }
> {
    const cachedAudioBlob = await getFromCache<Blob>(`audio_${songId}`);
    if (cachedAudioBlob) {
        const blobUrl = URL.createObjectURL(cachedAudioBlob);
        return { kind: 'ok', audioSrc: blobUrl, blobUrl };
    }

    if (prefetched?.audioUrl && prefetched.audioUrl !== 'CACHED_IN_DB' && isUrlValid(prefetched.audioUrlFetchedAt)) {
        return { kind: 'ok', audioSrc: prefetched.audioUrl };
    }

    const urlRes = await neteaseApi.getSongUrl(songId, audioQuality);
    const url = normalizeAudioUrl(urlRes.data?.[0]?.url);
    if (!url) {
        return { kind: 'unavailable' };
    }

    return { kind: 'ok', audioSrc: url };
}

export async function loadOnlineSongLyrics(
    songId: number,
    prefetched: PrefetchedSongData | null,
    callbacks: {
        isCurrent: () => boolean;
        onLyrics: (lyrics: LyricData | null) => void;
        onPureMusicChange?: (isPureMusic: boolean) => void;
        onDone: () => void;
    }
): Promise<void> {
    const { isCurrent, onLyrics, onPureMusicChange, onDone } = callbacks;

    const cachedLyrics = await getFromCacheWithMigration<LyricData>(`lyric_${songId}`, migrateLyricDataRenderHints);
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
        saveToCache(`lyric_${songId}`, prefetched.lyrics);
        onDone();
        return;
    }

    const lyricRes = await neteaseApi.getLyric(songId);
    const processed = await processNeteaseLyrics({
        type: 'netease',
        ...lyricRes
    });
    const parsedLyrics = processed.lyrics;

    if (!isCurrent()) return;
    onPureMusicChange?.(processed.isPureMusic);

    if (!parsedLyrics) {
        onLyrics(null);
        onDone();
        return;
    }

    onLyrics(parsedLyrics);
    saveToCache(`lyric_${songId}`, parsedLyrics);
    onDone();
}
