/**
 * Song Prefetch Service
 * 
 * Prefetches nearby songs in the queue to enable smooth transitions.
 * Handles URL expiration (1200s TTL) and re-prefetches on queue changes.
 */

import { SongResult, LyricData } from '../types';
import { neteaseApi } from './netease';
import { getFromCache, getFromCacheWithMigration } from './db';
import { migrateLyricDataRenderHints } from '../utils/lyrics/renderHints';
import { processNeteaseLyrics } from '../utils/lyrics/neteaseProcessing';

// Prefetch configuration
const PREFETCH_COUNT_NEXT = 2;  // Prefetch 2 songs ahead
const PREFETCH_COUNT_PREV = 1;  // Prefetch 1 song behind
const URL_TTL_MS = 1200 * 1000; // 1200 seconds = 20 minutes
const MAX_PREFETCH_CACHE_SIZE = 200; // Evict least recently used entries beyond this limit

export interface PrefetchedSongData {
    songId: number;
    audioUrl: string | null;
    audioUrlFetchedAt: number;
    audioUrlQuality: string | null; // Track which quality the URL was fetched for
    lyrics: LyricData | null;
    lyricRaw: {
        mainLrc: string | null;
        yrcLrc: string | null;
        transLrc: string | null;
        isPureMusic: boolean;
    } | null;
    coverUrl: string | null;
}

// In-memory prefetch cache (not persisted to IndexedDB to avoid stale URLs)
const prefetchCache = new Map<number, PrefetchedSongData>();

const touchPrefetchCacheEntry = (songId: number, data: PrefetchedSongData): PrefetchedSongData => {
    prefetchCache.delete(songId);
    prefetchCache.set(songId, data);
    return data;
};

// Track current prefetch operation to cancel on queue change
let currentPrefetchAbortController: AbortController | null = null;
/**
 * Check if a prefetched URL is still valid (not expired)
 */
export const isUrlValid = (fetchedAt: number): boolean => {
    return Date.now() - fetchedAt < URL_TTL_MS;
};

/**
 * Get prefetched data for a song
 * @param songId - The song ID to get prefetched data for
 * @param requiredQuality - The audio quality to validate against (optional)
 */
export const getPrefetchedData = (songId: number, requiredQuality?: string): PrefetchedSongData | null => {
    const cached = prefetchCache.get(songId);
    if (!cached) return null;

    // Check if URL is expired
    if (cached.audioUrl && !isUrlValid(cached.audioUrlFetchedAt)) {
        console.log(`[Prefetch] URL expired for song ${songId}, will refetch`);
        cached.audioUrl = null;
        cached.audioUrlQuality = null;
    }

    // Check if quality matches (if requiredQuality is specified)
    if (cached.audioUrl && requiredQuality && cached.audioUrlQuality !== requiredQuality) {
        console.log(`[Prefetch] Quality mismatch for song ${songId}: cached=${cached.audioUrlQuality}, required=${requiredQuality}`);
        // Don't use cached URL, but keep other data (lyrics, cover)
        cached.audioUrl = null;
        cached.audioUrlQuality = null;
    }

    return touchPrefetchCacheEntry(songId, cached);
};

/**
 * Prefetch a single song's resources
 */
const prefetchSong = async (
    song: SongResult,
    audioQuality: string,
    signal: AbortSignal
): Promise<void> => {
    if (signal.aborted) return;

    // Prefetch currently only supports Netease songs.
    if ((song as any).isLocal || (song as any).localData || (song as any).isNavidrome) {
        console.log(`[Prefetch] Skipping non-Netease song: ${song.name}`);
        return;
    }

    const songId = song.id;

    // Check if already prefetched with valid URL
    const existing = prefetchCache.get(songId);
    if (existing && existing.audioUrl && isUrlValid(existing.audioUrlFetchedAt) && (existing.lyrics || existing.lyricRaw?.isPureMusic)) {
        console.log(`[Prefetch] Already cached: ${song.name}`);
        touchPrefetchCacheEntry(songId, existing);
        return;
    }

    console.log(`[Prefetch] Starting prefetch for: ${song.name} (quality: ${audioQuality})`);

    const data: PrefetchedSongData = {
        songId,
        audioUrl: existing?.audioUrl && existing.audioUrlQuality === audioQuality && isUrlValid(existing.audioUrlFetchedAt) ? existing.audioUrl : null,
        audioUrlFetchedAt: existing?.audioUrlFetchedAt || 0,
        audioUrlQuality: existing?.audioUrlQuality || null,
        lyrics: existing?.lyrics || null,
        lyricRaw: existing?.lyricRaw || null,
        coverUrl: existing?.coverUrl || null,
    };

    // Prefetch audio URL (if not cached or expired)
    if (!data.audioUrl) {
        try {
            // Check IndexedDB cache first
            const cachedAudio = await getFromCache<Blob>(`audio_${songId}`);
            if (cachedAudio) {
                console.log(`[Prefetch] Audio in IndexedDB for: ${song.name}`);
                data.audioUrl = 'CACHED_IN_DB';
                data.audioUrlFetchedAt = Date.now();
            } else if (!signal.aborted) {
                const urlRes = await neteaseApi.getSongUrl(songId, audioQuality);
                let url = urlRes.data?.[0]?.url;
                if (url) {
                    if (url.startsWith('http:')) url = url.replace('http:', 'https:');
                    data.audioUrl = url;
                    data.audioUrlFetchedAt = Date.now();
                    data.audioUrlQuality = audioQuality;
                    console.log(`[Prefetch] Got audio URL for: ${song.name} (quality: ${audioQuality})`);
                }
            }
        } catch (e) {
            console.warn(`[Prefetch] Failed to get audio URL for ${song.name}:`, e);
        }
    }

    // Prefetch lyrics (if not cached)
    if (!data.lyrics) {
        try {
            // Check IndexedDB cache first
            const cachedLyrics = await getFromCacheWithMigration<LyricData>(`lyric_${songId}`, migrateLyricDataRenderHints);
            if (cachedLyrics) {
                console.log(`[Prefetch] Lyrics in IndexedDB for: ${song.name}`);
                data.lyrics = cachedLyrics;
            } else if (!signal.aborted) {
                const lyricRes = await neteaseApi.getLyric(songId);
                const processed = await processNeteaseLyrics({
                    type: 'netease',
                    ...lyricRes
                });
                data.lyricRaw = {
                    mainLrc: processed.mainLrc,
                    yrcLrc: processed.yrcLrc,
                    transLrc: processed.transLrc,
                    isPureMusic: processed.isPureMusic
                };
                data.lyrics = processed.lyrics;

                if (data.lyrics) {
                    console.log(`[Prefetch] Parsed lyrics for: ${song.name}`);
                }
            }
        } catch (e) {
            console.warn(`[Prefetch] Failed to get lyrics for ${song.name}:`, e);
        }
    }

    // Prefetch cover URL (just store the URL, don't download)
    if (!data.coverUrl) {
        const coverUrl = song.al?.picUrl || song.album?.picUrl;
        if (coverUrl) {
            data.coverUrl = coverUrl.startsWith('http:') ? coverUrl.replace('http:', 'https:') : coverUrl;
        }
    }

    prefetchCache.delete(songId);

    // Evict least recently used entries if cache exceeds limit
    while (prefetchCache.size >= MAX_PREFETCH_CACHE_SIZE) {
        const oldestKey = prefetchCache.keys().next().value;
        if (oldestKey !== undefined) {
            prefetchCache.delete(oldestKey);
        } else {
            break;
        }
    }

    prefetchCache.set(songId, data);
};

/**
 * Prefetch nearby songs based on current song and queue
 */
export const prefetchNearbySongs = async (
    currentSongId: number,
    queue: SongResult[],
    audioQuality: string
): Promise<void> => {
    // Cancel any ongoing prefetch
    if (currentPrefetchAbortController) {
        currentPrefetchAbortController.abort();
    }
    currentPrefetchAbortController = new AbortController();
    const signal = currentPrefetchAbortController.signal;

    // Find current song index in queue
    const currentIndex = queue.findIndex(s => s.id === currentSongId);
    if (currentIndex === -1) {
        console.log('[Prefetch] Current song not in queue, skipping prefetch');
        return;
    }

    // Determine songs to prefetch
    const songsToPrefetch: SongResult[] = [];

    // Previous songs
    for (let i = 1; i <= PREFETCH_COUNT_PREV; i++) {
        const idx = currentIndex - i;
        if (idx >= 0) {
            songsToPrefetch.push(queue[idx]);
        }
    }

    // Next songs
    for (let i = 1; i <= PREFETCH_COUNT_NEXT; i++) {
        const idx = currentIndex + i;
        if (idx < queue.length) {
            songsToPrefetch.push(queue[idx]);
        }
    }

    console.log(`[Prefetch] Will prefetch ${songsToPrefetch.length} songs near index ${currentIndex}`);

    // Prefetch using requestIdleCallback for non-blocking execution
    const prefetchWithIdle = (songs: SongResult[], index: number) => {
        if (signal.aborted || index >= songs.length) return;

        const song = songs[index];

        if ('requestIdleCallback' in window) {
            requestIdleCallback(
                async () => {
                    if (signal.aborted) return;
                    await prefetchSong(song, audioQuality, signal);
                    prefetchWithIdle(songs, index + 1);
                },
                { timeout: 5000 }
            );
        } else {
            // Fallback for browsers without requestIdleCallback
            setTimeout(async () => {
                if (signal.aborted) return;
                await prefetchSong(song, audioQuality, signal);
                prefetchWithIdle(songs, index + 1);
            }, 100);
        }
    };

    prefetchWithIdle(songsToPrefetch, 0);
};

/**
 * Clear prefetch cache for songs not in the current queue
 * Call this after queue shuffle to free memory
 */
export const cleanupPrefetchCache = (currentQueue: SongResult[]): void => {
    const queueIds = new Set(currentQueue.map(s => s.id));

    for (const songId of prefetchCache.keys()) {
        if (!queueIds.has(songId)) {
            prefetchCache.delete(songId);
        }
    }

    console.log(`[Prefetch] Cleanup complete, cache size: ${prefetchCache.size}`);
};

/**
 * Force re-prefetch (e.g., after queue shuffle)
 */
export const invalidateAndRefetch = async (
    currentSongId: number,
    queue: SongResult[],
    audioQuality: string
): Promise<void> => {
    console.log('[Prefetch] Queue changed, invalidating and re-prefetching');
    cleanupPrefetchCache(queue);
    await prefetchNearbySongs(currentSongId, queue, audioQuality);
};
