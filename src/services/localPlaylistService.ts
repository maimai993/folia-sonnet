import { LocalPlaylist, LocalSong } from '../types';
import { getFromCache, saveToCache } from './db';

const LOCAL_PLAYLISTS_CACHE_KEY = 'local_playlists';
const FAVORITE_PLAYLIST_NAME = '我喜欢的音乐';

const createPlaylistId = () => `local_playlist_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

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

const normalizePlaylist = (playlist: LocalPlaylist): LocalPlaylist => ({
    ...playlist,
    songIds: dedupeSongIds(Array.isArray(playlist.songIds) ? playlist.songIds : []),
    createdAt: typeof playlist.createdAt === 'number' ? playlist.createdAt : Date.now(),
    updatedAt: typeof playlist.updatedAt === 'number' ? playlist.updatedAt : Date.now(),
});

const persistPlaylists = async (playlists: LocalPlaylist[]) => {
    await saveToCache(LOCAL_PLAYLISTS_CACHE_KEY, playlists.map(normalizePlaylist));
};

export const getLocalPlaylists = async (): Promise<LocalPlaylist[]> => {
    const cached = await getFromCache<LocalPlaylist[]>(LOCAL_PLAYLISTS_CACHE_KEY);
    const playlists = Array.isArray(cached) ? cached.map(normalizePlaylist) : [];

    const favoritePlaylist = playlists.find(playlist => playlist.isFavorite);
    if (!favoritePlaylist) {
        const nextPlaylists = [
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
