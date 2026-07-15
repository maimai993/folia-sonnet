import type { LocalSong } from '../types';
import type { LocalLibraryAssignmentOrigin } from '../types/localLibrary';
import { isBlob } from '../utils/blobGuards';
import { applyMatchedMetadata, restoreImportedMetadata } from './localLibraryCatalogService';
import { cacheLocalSongOnlineCover } from './coverCache';
import {
    findAutomaticOnlineMetadataCandidate,
    type OnlineMetadataCandidate,
} from './onlineMetadataSearchService';

// src/services/localSongMetadataMatchService.ts
// Applies metadata-only matches and orchestrates cancellable two-worker folder batches.

export type LocalSongMetadataMatchStatus = 'matched' | 'matched-cover-failed' | 'no-match' | 'skipped' | 'failed';

export interface LocalSongMetadataMatchUpdate {
    songId: string;
    status: LocalSongMetadataMatchStatus;
    candidate?: OnlineMetadataCandidate;
    error?: unknown;
}

export interface BatchLocalSongMetadataMatchResult {
    updates: LocalSongMetadataMatchUpdate[];
    cancelled: boolean;
}

export interface ApplyOnlineMetadataCandidateOptions {
    mode: 'automatic' | 'manual';
    protectOrigins?: LocalLibraryAssignmentOrigin[];
    useOnlineMetadata?: boolean;
    useOnlineCover?: boolean;
}

// Stores one provider candidate while allowing metadata and cover display sources to be chosen independently.
export const applyOnlineMetadataCandidate = async (
    song: LocalSong,
    candidate: OnlineMetadataCandidate,
    options: ApplyOnlineMetadataCandidateOptions,
): Promise<{ song?: LocalSong; coverAttempted: boolean; coverCached: boolean }> => {
    const useOnlineMetadata = options.useOnlineMetadata ?? true;
    const useOnlineCover = options.mode === 'manual'
        ? Boolean(options.useOnlineCover && candidate.coverUrl)
        : Boolean(candidate.coverUrl && !isBlob(song.embeddedCover));
    const selectedIdentityChanged = song.matchedMetadataSource !== candidate.source
        || String(song.matchedMetadataSongId ?? '') !== String(candidate.songId);
    const shouldInvalidateAutomaticLyrics = useOnlineMetadata
        && (selectedIdentityChanged || options.mode === 'manual')
        && !song.hasManualLyricSelection;
    const songPatch: Partial<LocalSong> = {
        matchedMetadataSource: candidate.source,
        matchedMetadataSongId: candidate.songId,
        useOnlineMetadata,
        ...(shouldInvalidateAutomaticLyrics ? {
            matchedLyrics: undefined,
            matchedIsPureMusic: undefined,
            matchedLyricsSongId: undefined,
            matchedLyricsSource: undefined,
            matchedLyricsProviderPlatform: undefined,
        } : {}),
        ...(candidate.album ? { matchedMetadataAlbumId: candidate.album.id } : {}),
        ...(candidate.coverUrl
            ? { matchedCoverUrl: candidate.coverUrl, useOnlineCover }
            : options.mode === 'manual' ? { useOnlineCover: false } : {}),
    };
    if (options.mode === 'manual') {
        if (candidate.title) songPatch.matchedTitle = candidate.title;
        if (candidate.artists.length > 0) {
            songPatch.matchedArtistEntities = candidate.artists;
            songPatch.matchedArtists = candidate.artists.map(artist => artist.name).join(', ');
        }
        if (candidate.album) {
            songPatch.matchedAlbumName = candidate.album.name;
        }
        if (candidate.source === 'netease') {
            if (typeof candidate.songId === 'number') songPatch.matchedSongId = candidate.songId;
            if (typeof candidate.album?.id === 'number') songPatch.matchedAlbumId = candidate.album.id;
        }
    }
    const metadata = {
        source: candidate.source,
        songId: candidate.songId,
        title: candidate.title,
        artists: candidate.artists.length > 0 ? candidate.artists : undefined,
        album: candidate.album,
        coverUrl: candidate.coverUrl,
    };
    let updatedSong: LocalSong | undefined;
    if (useOnlineMetadata) {
        updatedSong = await applyMatchedMetadata(song.id, metadata, {
            songPatch,
            protectOrigins: options.protectOrigins,
        });
    } else {
        await applyMatchedMetadata(song.id, {}, { lyricsOnly: true, songPatch });
        updatedSong = await restoreImportedMetadata(song.id);
    }
    const coverAttempted = Boolean(useOnlineCover && candidate.coverUrl);
    const coverCached = coverAttempted && candidate.coverUrl
        ? await cacheLocalSongOnlineCover(song.id, candidate.coverUrl)
        : false;
    return { song: updatedSong, coverAttempted, coverCached };
};

// Processes at most two songs concurrently and reports every completed item immediately.
export async function batchAutoMatchLocalSongMetadata(
    songs: LocalSong[],
    options: {
        signal?: AbortSignal;
        onUpdate?: (update: LocalSongMetadataMatchUpdate) => void;
        concurrency?: number;
    } = {},
): Promise<BatchLocalSongMetadataMatchResult> {
    const updates: LocalSongMetadataMatchUpdate[] = [];
    let nextIndex = 0;
    const record = (update: LocalSongMetadataMatchUpdate) => {
        updates.push(update);
        options.onUpdate?.(update);
    };
    const worker = async () => {
        while (nextIndex < songs.length && !options.signal?.aborted) {
            const song = songs[nextIndex++];
            if (song.noAutoMatch) {
                record({ songId: song.id, status: 'skipped' });
                continue;
            }
            try {
                const candidate = await findAutomaticOnlineMetadataCandidate(song, options.signal);
                if (options.signal?.aborted) return;
                if (!candidate) {
                    record({ songId: song.id, status: 'no-match' });
                    continue;
                }
                const applied = await applyOnlineMetadataCandidate(song, candidate, {
                    mode: 'automatic',
                    protectOrigins: ['manual', 'split'],
                });
                record({
                    songId: song.id,
                    status: applied.coverAttempted && !applied.coverCached ? 'matched-cover-failed' : 'matched',
                    candidate,
                });
            } catch (error) {
                if ((error as Error).name === 'AbortError') return;
                record({ songId: song.id, status: 'failed', error });
            }
        }
    };
    const workerCount = Math.max(1, Math.min(options.concurrency ?? 2, 2, songs.length || 1));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return { updates, cancelled: Boolean(options.signal?.aborted) };
}
