import { LocalPlaylist, LocalSong } from '../types';
import { getFromCache, saveToCache } from './db';

const LOCAL_PLAYLISTS_CACHE_KEY = 'local_playlists';
const FAVORITE_PLAYLIST_NAME = '我喜欢的音乐';
const UNNAMED_PLAYLIST_NAME = '未命名歌单';

const createPlaylistId = () => `local_playlist_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

type LegacyPlaylistSongRef = string | Pick<LocalSong, 'id'> | null | undefined;
type LegacyLocalPlaylist = Partial<LocalPlaylist> & {
    songs?: LegacyPlaylistSongRef[];
    tracks?: LegacyPlaylistSongRef[];
    trackIds?: string[];
};

const dedupeSongIds = (songIds: string[]) => {
    const seen = new Set<string>();
    const deduped: string[] = [];

    songIds.forEach(songId => {
        if (!songId || seen.has(songId)) {
            return;
        }

        seen.add(songId);
        deduped.push(songId);
    });

    return deduped;
};

const normalizeSongIdRef = (value: LegacyPlaylistSongRef): string | null => {
    if (typeof value === 'string') {
        return value;
    }

    if (value && typeof value === 'object' && typeof value.id === 'string') {
        return value.id;
    }

    return null;
};

// Reads legacy playlist payloads and converts them into the current song-id-only shape.
const resolvePlaylistSongIds = (playlist: LegacyLocalPlaylist): string[] => {
    const candidateCollections: LegacyPlaylistSongRef[][] = [];

    if (Array.isArray(playlist.songIds)) {
        candidateCollections.push(playlist.songIds as LegacyPlaylistSongRef[]);
    }

    if (Array.isArray(playlist.trackIds)) {
        candidateCollections.push(playlist.trackIds);
    }

    if (Array.isArray(playlist.songs)) {
        candidateCollections.push(playlist.songs);
    }

    if (Array.isArray(playlist.tracks)) {
        candidateCollections.push(playlist.tracks);
    }

    for (const collection of candidateCollections) {
        const normalized = dedupeSongIds(
            collection
                .map(normalizeSongIdRef)
                .filter((songId): songId is string => Boolean(songId))
        );

        if (normalized.length > 0) {
            return normalized;
        }
    }

    return [];
};

const normalizePlaylist = (playlist: LegacyLocalPlaylist): LocalPlaylist => ({
    id: typeof playlist.id === 'string' && playlist.id ? playlist.id : createPlaylistId(),
    name: typeof playlist.name === 'string' && playlist.name
        ? playlist.name
        : (playlist.isFavorite ? FAVORITE_PLAYLIST_NAME : UNNAMED_PLAYLIST_NAME),
    songIds: resolvePlaylistSongIds(playlist),
    createdAt: typeof playlist.createdAt === 'number' ? playlist.createdAt : Date.now(),
    updatedAt: typeof playlist.updatedAt === 'number' ? playlist.updatedAt : Date.now(),
    isFavorite: Boolean(playlist.isFavorite),
});

const playlistNeedsNormalization = (playlist: LegacyLocalPlaylist): boolean => {
    if (!Array.isArray(playlist.songIds)) {
        return true;
    }

    if (Array.isArray(playlist.songs) || Array.isArray(playlist.tracks) || Array.isArray(playlist.trackIds)) {
        return true;
    }

    const normalizedSongIds = resolvePlaylistSongIds(playlist);
    if (normalizedSongIds.length !== playlist.songIds.length) {
        return true;
    }

    if (normalizedSongIds.some((songId, index) => songId !== playlist.songIds?.[index])) {
        return true;
    }

    return typeof playlist.createdAt !== 'number' || typeof playlist.updatedAt !== 'number';
};

const persistPlaylists = async (playlists: LocalPlaylist[]) => {
    await saveToCache(LOCAL_PLAYLISTS_CACHE_KEY, playlists.map(normalizePlaylist));
};

export const getLocalPlaylists = async (): Promise<LocalPlaylist[]> => {
    const cached = await getFromCache<LegacyLocalPlaylist[]>(LOCAL_PLAYLISTS_CACHE_KEY);
    const cachedPlaylists = Array.isArray(cached) ? cached : [];
    const playlists = cachedPlaylists.map(normalizePlaylist);
    const shouldPersist = cachedPlaylists.some(playlistNeedsNormalization);

    const favoritePlaylist = playlists.find(playlist => playlist.isFavorite);
    if (!favoritePlaylist) {
        const nextPlaylists: LocalPlaylist[] = [
            {
                id: createPlaylistId(),
                name: FAVORITE_PLAYLIST_NAME,
                songIds: [],
                createdAt: Date.now(),
                updatedAt: Date.now(),
                isFavorite: true,
            },
            ...playlists,
        ];
        await persistPlaylists(nextPlaylists);
        return nextPlaylists;
    }

    if (shouldPersist) {
        await persistPlaylists(playlists);
    }

    return playlists;
};

export const saveLocalPlaylists = async (playlists: LocalPlaylist[]): Promise<LocalPlaylist[]> => {
    const normalized = playlists.map(normalizePlaylist);
    await persistPlaylists(normalized);
    return normalized;
};

export const createLocalPlaylist = async (name: string, songs: LocalSong[] = []): Promise<LocalPlaylist> => {
    const playlists = await getLocalPlaylists();
    const now = Date.now();
    const playlist: LocalPlaylist = {
        id: createPlaylistId(),
        name: name.trim(),
        songIds: dedupeSongIds(songs.map(song => song.id)),
        createdAt: now,
        updatedAt: now,
    };

    await persistPlaylists([...playlists, playlist]);
    return playlist;
};

export const updateLocalPlaylist = async (
    playlistId: string,
    updater: (playlist: LocalPlaylist) => LocalPlaylist
): Promise<LocalPlaylist | null> => {
    const playlists = await getLocalPlaylists();
    let updatedPlaylist: LocalPlaylist | null = null;

    const nextPlaylists = playlists.map(playlist => {
        if (playlist.id !== playlistId) {
            return playlist;
        }

        updatedPlaylist = normalizePlaylist({
            ...updater(playlist),
            updatedAt: Date.now(),
        });
        return updatedPlaylist;
    });

    if (!updatedPlaylist) {
        return null;
    }

    await persistPlaylists(nextPlaylists);
    return updatedPlaylist;
};

export const deleteLocalPlaylist = async (playlistId: string): Promise<void> => {
    const playlists = await getLocalPlaylists();
    const target = playlists.find(playlist => playlist.id === playlistId);
    if (!target || target.isFavorite) {
        return;
    }

    await persistPlaylists(playlists.filter(playlist => playlist.id !== playlistId));
};

export const canDeleteLocalPlaylist = (playlist: LocalPlaylist | null | undefined): boolean => {
    return Boolean(playlist && !playlist.isFavorite);
};

export const addSongsToLocalPlaylist = async (playlistId: string, songs: LocalSong[]): Promise<LocalPlaylist | null> => {
    const songIds = songs.map(song => song.id);
    return updateLocalPlaylist(playlistId, playlist => ({
        ...playlist,
        songIds: dedupeSongIds([...playlist.songIds, ...songIds]),
    }));
};

export const removeSongsFromLocalPlaylist = async (playlistId: string, songIds: string[]): Promise<LocalPlaylist | null> => {
    const removingIds = new Set(songIds);
    return updateLocalPlaylist(playlistId, playlist => ({
        ...playlist,
        songIds: playlist.songIds.filter(songId => !removingIds.has(songId)),
    }));
};

export const reorderLocalPlaylistSongs = async (
    playlistId: string,
    songIds: string[]
): Promise<LocalPlaylist | null> => updateLocalPlaylist(playlistId, playlist => ({
    ...playlist,
    songIds: dedupeSongIds(songIds),
}));

export const getFavoriteLocalPlaylist = async (): Promise<LocalPlaylist> => {
    const playlists = await getLocalPlaylists();
    const favoritePlaylist = playlists.find(playlist => playlist.isFavorite);

    if (!favoritePlaylist) {
        const created = await createLocalPlaylist(FAVORITE_PLAYLIST_NAME);
        return {
            ...created,
            isFavorite: true,
        };
    }

    return favoritePlaylist;
};

export const setLocalSongFavorite = async (song: LocalSong, shouldFavorite: boolean): Promise<LocalPlaylist | null> => {
    const favoritePlaylist = await getFavoriteLocalPlaylist();

    if (shouldFavorite) {
        return addSongsToLocalPlaylist(favoritePlaylist.id, [song]);
    }

    return removeSongsFromLocalPlaylist(favoritePlaylist.id, [song.id]);
};
