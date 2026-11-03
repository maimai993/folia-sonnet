import { removeFromCache, saveToCache } from '../../../services/db';
import type { SongResult, UnifiedSong } from '../../../types';
import { isStagePlaybackSong, normalizePlaybackSongSource } from '../../../utils/appPlaybackGuards';
import { forgetPlaybackPosition } from './playbackPositionCache';

// src/components/app/playback/persistPlaybackCache.ts

const sanitizePlaybackSong = (song: SongResult): SongResult => {
    const unified = normalizePlaybackSongSource(song) as UnifiedSong & { localData?: { id?: string } };
    const localSongId = unified.localRef?.songId || unified.localData?.id;
    if (!localSongId) return unified;
    const { localData: _legacyLocalData, ...snapshot } = unified;
    return { ...snapshot, isLocal: true, localRef: { songId: localSongId } } as UnifiedSong;
};

// Persists local playback as a lightweight songId reference while excluding Stage snapshots.
export const persistPlaybackCache = async (song: SongResult | null, queue: SongResult[]) => {
    if (!song || isStagePlaybackSong(song)) {
        return;
    }

    const sanitizedSong = sanitizePlaybackSong(song);
    const sanitizedQueue = queue
        .filter(queuedSong => !isStagePlaybackSong(queuedSong))
        .map(sanitizePlaybackSong);
    await Promise.all([
        saveToCache('last_song', sanitizedSong),
        saveToCache('last_queue', sanitizedQueue),
    ]);
};

// Forgets the saved song and queue, so the next launch restores nothing: the player was emptied.
export const forgetPlaybackCache = async () => {
    await Promise.all([
        removeFromCache('last_song'),
        removeFromCache('last_queue'),
        // 位置跟着一起清：留着它，下次恢复会拿一条属于「已经不在这台机器上」的那首歌
        // 的记录去比 songKey，虽然对不上就会作废，但没必要让一条死数据一直躺着。
        forgetPlaybackPosition(),
    ]);
};
