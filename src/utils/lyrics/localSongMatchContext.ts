import type { LocalSong } from '../../types';

// src/utils/lyrics/localSongMatchContext.ts

export interface LocalSongMetadataLyricCandidate {
    source: 'netease' | 'qq';
    songId: number | string;
}

export interface LocalSongLyricMatchContext {
    title: string;
    artist: string;
    album: string;
    durationMs: number;
    metadataCandidate?: LocalSongMetadataLyricCandidate;
}

const stripAudioExtension = (fileName: string): string => (
    fileName.replace(/\.(mp3|flac|m4a|wav|ogg|opus|aac)$/i, '')
);

// Uses the online identity only when the user has chosen online metadata for display.
export const buildLocalSongLyricMatchContext = (song: LocalSong): LocalSongLyricMatchContext => {
    const useOnlineMetadata = song.useOnlineMetadata === true;
    const title = useOnlineMetadata
        ? (song.matchedTitle || song.embeddedTitle || song.title || stripAudioExtension(song.fileName))
        : (song.title || song.embeddedTitle || stripAudioExtension(song.fileName));
    const artist = useOnlineMetadata
        ? (song.matchedArtists || song.artist || song.embeddedArtist || '')
        : (song.artist || song.embeddedArtist || '');
    const album = useOnlineMetadata
        ? (song.matchedAlbumName || song.album || song.embeddedAlbum || '')
        : (song.album || song.embeddedAlbum || '');
    const hasSelectedIdentity = useOnlineMetadata
        && Boolean(song.matchedMetadataSource)
        && song.matchedMetadataSongId !== undefined
        && song.matchedMetadataSongId !== null
        && String(song.matchedMetadataSongId).trim() !== '';

    return {
        title,
        artist,
        album,
        durationMs: song.duration || 0,
        ...(hasSelectedIdentity ? {
            metadataCandidate: {
                source: song.matchedMetadataSource!,
                songId: song.matchedMetadataSongId!,
            },
        } : {}),
    };
};

// An explicit GridView metadata selection is allowed to recover from an older no-auto-match choice.
export const shouldRunLocalSongAutomaticMatch = (song: LocalSong): boolean => (
    !song.noAutoMatch || Boolean(buildLocalSongLyricMatchContext(song).metadataCandidate)
);

// Legacy automatic lyric records have no provider-scoped lyric ID and are refreshed once against the selected metadata.
export const shouldRefreshLocalSongLyricsFromMetadata = (song: LocalSong): boolean => (
    !song.hasManualLyricSelection
    && Boolean(buildLocalSongLyricMatchContext(song).metadataCandidate)
    && Boolean(song.matchedLyrics || song.matchedIsPureMusic)
    && song.matchedLyricsSongId === undefined
);
