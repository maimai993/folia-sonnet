import { getFromCache, removeFromCache, saveToCache } from './db';

const buildCoverRequestUrl = (coverUrl: string): string => {
    if (typeof window !== 'undefined' && window.electron) return coverUrl;
    try {
        const hostname = new URL(coverUrl).hostname;
        if (hostname === 'y.gtimg.cn') {
            return `/api/lyric-proxy?url=${encodeURIComponent(coverUrl)}`;
        }
    } catch {
        return coverUrl;
    }
    return coverUrl;
};

const fetchCoverBlob = async (coverUrl: string): Promise<Blob> => {
    const response = await fetch(buildCoverRequestUrl(coverUrl), { mode: 'cors' });
    if (response.ok === false) throw new Error(`Cover request failed: ${response.status}`);
    return await response.blob();
};

export async function getCachedCoverUrl(cacheKey: string): Promise<string | null> {
    const cachedCover = await getFromCache<Blob>(cacheKey);
    return cachedCover ? URL.createObjectURL(cachedCover) : null;
}

export async function loadCachedOrFetchCover(cacheKey: string, coverUrl?: string | null): Promise<string | null> {
    if (!coverUrl) return null;

    try {
        const cachedCoverUrl = await getCachedCoverUrl(cacheKey);
        if (cachedCoverUrl) {
            return cachedCoverUrl;
        }

        const coverBlob = await fetchCoverBlob(coverUrl);
        await saveToCache(cacheKey, coverBlob);
        return URL.createObjectURL(coverBlob);
    } catch (error) {
        console.warn('Failed to cache cover:', error);
        return coverUrl;
    }
}

// Replaces the cached online cover used by local-song playback without changing the audio file.
export async function cacheLocalSongOnlineCover(songId: string, coverUrl: string): Promise<boolean> {
    const cacheKey = `cover_local_${songId}`;
    await removeFromCache(cacheKey);
    try {
        await saveToCache(cacheKey, await fetchCoverBlob(coverUrl));
        return true;
    } catch (error) {
        console.warn('[LocalMusic] Failed to cache matched cover:', error);
        return false;
    }
}
