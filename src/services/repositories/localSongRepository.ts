import type { LocalSong } from '../../types';
import { isBlob } from '../../utils/blobGuards';
import { getLocalSongAlbumContextKey } from '../../utils/localLibraryNames';
import { migrateLocalSongsRenderHints, migrateMatchedLyricsCarrierRenderHints } from '../../utils/lyrics/storageMigration';
import { appDatabase } from '../appDatabase';

// src/services/repositories/localSongRepository.ts
// Stores sanitized local-song records while retaining the existing read-time lyric migrations.

export const sanitizeLocalSongForStorage = (song: LocalSong): LocalSong => {
  const normalizedSong = migrateMatchedLyricsCarrierRenderHints(song).value ?? song;
  const { fileHandle, embeddedCover: _legacyCover, albumContextKey: _staleKey, ...persistedSong } = normalizedSong as LocalSong & {
    embeddedCover?: unknown;
  };
  // Recomputed on every write: the imported album or the path may have changed since the key was read.
  // A record missing those fields still saves, only without the key (as the v1 upgrade treats it).
  let albumContextKey: string | undefined;
  try {
    albumContextKey = getLocalSongAlbumContextKey(persistedSong);
  } catch {
    albumContextKey = undefined;
  }
  return albumContextKey ? { ...persistedSong, albumContextKey } : persistedSong;
};

const normalizeLocalSongFromStorage = (song: LocalSong): { value: LocalSong; changed: boolean } => {
  const legacySong = song as LocalSong & { embeddedCover?: unknown };
  if (legacySong.embeddedCover === undefined) return { value: song, changed: false };
  const { embeddedCover, ...normalizedSong } = legacySong;
  // A valid legacy Blob remains in IndexedDB until the background migrator commits external storage.
  return { value: normalizedSong, changed: !isBlob(embeddedCover) };
};

export const putLocalSong = async (song: LocalSong): Promise<void> => {
  await appDatabase.local_music.put(sanitizeLocalSongForStorage(song));
};

export const putLocalSongs = async (songs: LocalSong[]): Promise<void> => {
  if (songs.length > 0) {
    await appDatabase.local_music.bulkPut(songs.map(sanitizeLocalSongForStorage));
  }
};

const LOCAL_SONG_MAINTENANCE_CHUNK = 64;

const yieldToMainThread = (): Promise<void> => (
  new Promise(resolve => setTimeout(resolve, 0))
);

// 读时归一化（清掉遗留封面）+ 歌词 render hint 迁移，改动的记录在后台写回。
// 全程按块切片并让出主线程：曲库一大，逐条归一化会把 IndexedDB 的 onsuccess 回调本身
// 变成长任务，本地页（以及启动时的播放恢复）就此卡住 —— 表现就是「本地打不开」。
const migrateStoredLocalSongs = async (storedSongs: LocalSong[]): Promise<LocalSong[]> => {
  // 让 IndexedDB 的 onsuccess 回调先收尾；单条读取没有这个负担，不必凭空多跳一次宏任务。
  if (storedSongs.length > LOCAL_SONG_MAINTENANCE_CHUNK) {
    await yieldToMainThread();
  }

  const normalizedSongs: LocalSong[] = [];
  const sanitizedSongs: LocalSong[] = [];
  for (let index = 0; index < storedSongs.length; index += 1) {
    const normalized = normalizeLocalSongFromStorage(storedSongs[index]);
    normalizedSongs.push(normalized.value);
    if (normalized.changed) sanitizedSongs.push(normalized.value);
    if ((index + 1) % LOCAL_SONG_MAINTENANCE_CHUNK === 0) {
      await yieldToMainThread();
    }
  }
  if (sanitizedSongs.length > 0) {
    void putLocalSongs(sanitizedSongs).catch(error => {
      console.warn('[DB] Failed to write back sanitized local song covers', error);
    });
  }

  // 迁移同样按块切：整库一次算完在几千首的量级上是秒级的主线程占用。
  const migratedSongs: LocalSong[] = [];
  const migratedChangedSongs: LocalSong[] = [];
  for (let index = 0; index < normalizedSongs.length; index += LOCAL_SONG_MAINTENANCE_CHUNK) {
    const migration = migrateLocalSongsRenderHints(
      normalizedSongs.slice(index, index + LOCAL_SONG_MAINTENANCE_CHUNK),
    );
    migratedSongs.push(...migration.value);
    migratedChangedSongs.push(...migration.changedSongs);
    if (index + LOCAL_SONG_MAINTENANCE_CHUNK < normalizedSongs.length) {
      await yieldToMainThread();
    }
  }
  if (migratedChangedSongs.length > 0) {
    void putLocalSongs(migratedChangedSongs).catch(error => {
      console.warn('[DB] Failed to write back migrated local song lyrics', error);
    });
  }
  return migratedSongs;
};

export const readLocalSongs = async (): Promise<LocalSong[]> => (
  migrateStoredLocalSongs(await appDatabase.local_music.toArray())
);

// 按主键读一条记录，读时迁移与 readLocalSongs 一致；播放和匹配路径只关心一首歌时用它，不读整张表。
export const readLocalSong = async (id: string): Promise<LocalSong | undefined> => {
  const storedSong = await appDatabase.local_music.get(id);
  return storedSong ? (await migrateStoredLocalSongs([storedSong]))[0] : undefined;
};

export const removeLocalSong = async (id: string): Promise<void> => {
  await appDatabase.local_music.delete(id);
};

export const removeLocalSongs = async (ids: string[]): Promise<void> => {
  if (ids.length > 0) {
    await appDatabase.local_music.bulkDelete(ids);
  }
};

