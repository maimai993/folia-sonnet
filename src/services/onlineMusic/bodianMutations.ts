import type { OnlineMutationProvider, MediaId, ProviderCollection } from '../../types/onlineMusic';
import type { SongResult } from '../../types';
import { OnlineProviderError } from '../../types/onlineMusic';
import { getPlaybackSourceRef } from '../../utils/appPlaybackGuards';
import { requestBodian } from './bodianTransport';
import { clearBodianLibraryCache } from './bodianLibrary';

// src/services/onlineMusic/bodianMutations.ts

function songId(song: MediaId | SongResult): string {
    if (typeof song !== 'object') return String(song);
    const source = getPlaybackSourceRef(song);
    if (source?.kind !== 'online' || source.providerId !== 'bodian') {
        throw new OnlineProviderError('unsupported', 'Song does not belong to Bodian', 'bodian');
    }
    return String(source.mediaId);
}

function playlistId(playlist: MediaId | ProviderCollection): string {
    if (typeof playlist !== 'object') return String(playlist);
    if (playlist.providerId !== 'bodian' || playlist.type !== 'playlist' || !playlist.isOwned) {
        throw new OnlineProviderError('unsupported', 'Playlist is not an owned Bodian playlist', 'bodian');
    }
    return String(playlist.id);
}

// The account library marks the built-in list explicitly. Do not use its display name as
// an identity check: users are allowed to create a playlist with the same name.
function isBodianLikedPlaylist(playlist: ProviderCollection): boolean {
    return playlist.isLiked === true;
}

const likeSong = async (song: MediaId | SongResult, liked: boolean): Promise<void> => {
    try { await requestBodian('like_song', { id: songId(song), liked }); }
    finally { clearBodianLibraryCache(); }
};

export const bodianMutations: OnlineMutationProvider = {
    canAddToPlaylist: playlist => playlist.providerId === 'bodian' && playlist.type === 'playlist' && playlist.isOwned === true,
    likeSong,
    async updatePlaylistTracks(operation, playlist, tracks) {
        if (!tracks.length) return;
        // Bodian's built-in 我喜欢 list is backed by the like endpoint; the generic playlist
        // mutation endpoint rejects that list even though it is returned with user playlists.
        if (typeof playlist === 'object' && isBodianLikedPlaylist(playlist)) {
            for (const track of tracks) await likeSong(track, operation === 'add');
            return;
        }
        if (tracks.length > 100) throw new OnlineProviderError('unsupported', 'Select at most 100 tracks per operation', 'bodian');
        const id = playlistId(playlist);
        const trackIds = tracks.map(songId).join(',');
        try { await requestBodian(operation === 'add' ? 'playlist_tracks_add' : 'playlist_tracks_del', { id, trackIds }); }
        finally { clearBodianLibraryCache(); }
    },
};
