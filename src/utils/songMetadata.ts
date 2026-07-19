import type { SongResult } from '../types';

// src/utils/songMetadata.ts

export const getSongAlbumCoverUrl = (song?: Pick<SongResult, 'album'> | null): string | undefined => {
    const coverUrl = song?.album?.coverUrl || song?.album?.picUrl;
    return typeof coverUrl === 'string' && coverUrl ? coverUrl : undefined;
};
