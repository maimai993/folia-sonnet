import { useCallback } from 'react';
import type { SongResult } from '../../../types';
import { useLibraryStore } from '../../../stores/useLibraryStore';
import { useLocalFavoriteSongIdsStore } from '../../../stores/useLocalFavoriteSongIdsStore';
import { isLocalPlaybackSong } from '../../../utils/appPlaybackGuards';
import { resolveSongLiked } from '../../../utils/resolveSongLiked';

// src/library/core/bindings/useSongLikedResolver.ts
//
// 「喜欢程度」排序要的判别式。本地是「我喜欢的」歌单，Navidrome 是 starred 集合，在线是 provider
// 的已喜欢列表——三套各睡各的，这里合成一个，判定仍交给 resolveSongLiked（它已经是那三套的唯一真源）。

export const useSongLikedResolver = (): ((track: SongResult) => boolean) => {
    const localFavoriteSongIds = useLocalFavoriteSongIdsStore(state => state.songIds);
    const starredNavidromeSongIds = useLibraryStore(state => state.starredNavidromeSongIds);

    return useCallback((track: SongResult): boolean => (
        resolveSongLiked(track, {
            isLocalSongLiked: song => {
                if (!isLocalPlaybackSong(song)) return false;
                return localFavoriteSongIds.has(song.localRef.songId);
            },
            starredNavidromeSongIds,
        })
    ), [localFavoriteSongIds, starredNavidromeSongIds]);
};
