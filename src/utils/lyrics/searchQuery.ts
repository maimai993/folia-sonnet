// src/utils/lyrics/searchQuery.ts
// Shared helpers for constructing lyric search queries from song metadata.

const MAX_ALBUM_QUERY_LENGTH = 48;

// Keeps long anime/single album names useful for provider search by dropping catalog notes and credits first.
const normalizeAlbumForLyricSearch = (album?: string | null): string | null => {
    const trimmedAlbum = album?.trim();
    if (!trimmedAlbum) {
        return null;
    }

    if (trimmedAlbum.length <= MAX_ALBUM_QUERY_LENGTH) {
        return trimmedAlbum;
    }

    const compactAlbum = trimmedAlbum
        .replace(/\s*※.*$/u, '')
        .replace(/\s*(歌|歌唱|アーティスト|Artist)\s*[:：]?\s*.+$/iu, '')
        .trim();

    if (compactAlbum.length <= MAX_ALBUM_QUERY_LENGTH) {
        return compactAlbum;
    }

    return compactAlbum.slice(0, MAX_ALBUM_QUERY_LENGTH).trim();
};

export const buildLyricSearchQuery = (
    title?: string | null,
    artist?: string | null,
    album?: string | null
): string => {
    return [title?.trim(), artist?.trim(), normalizeAlbumForLyricSearch(album)]
        .map(part => part?.trim())
        .filter((part): part is string => Boolean(part))
        .join(' - ');
};

export const buildKugouLyricSearchQuery = (keyword: string): string => {
    const trimmedKeyword = keyword.trim();
    if (!trimmedKeyword) {
        return trimmedKeyword;
    }

    const structuredTitle = trimmedKeyword.split(/\s+-\s+/u)[0]?.trim();
    return structuredTitle || trimmedKeyword;
};
