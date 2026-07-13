import type { LocalSong } from '../types';
import type { LocalLibraryAssignment } from '../types/localLibrary';
import {
  cleanLocalLibraryName,
  getAlbumImportContextKey,
  getImportedAlbumName,
  getImportedArtistNames,
  getMatchedArtistNames,
  normalizeLocalLibraryName,
  splitLocalLibraryArtistNames,
} from '../utils/localLibraryNames';
import {
  appDatabase,
  LOCAL_LIBRARY_ARTIST_SPLIT_MARKER_KEY,
  LOCAL_LIBRARY_BOOTSTRAP_MARKER_KEY,
  type StoredCacheEntry,
} from './appDatabase';
import { createLocalLibraryAssignment, resolveEntityNames } from './localLibraryCatalogInternals';
import { sanitizeLocalSongForStorage } from './repositories/localSongRepository';

// src/services/localLibraryImportCatalog.ts
// Handles import/rescan assignment and the idempotent legacy bootstrap transaction.

const assignImportedSongsInTransaction = async (
  songs: LocalSong[],
  preserveNonImportAssignments: boolean,
): Promise<void> => {
  if (songs.length === 0) return;
  const [entities, assignments, allSongs] = await Promise.all([
    appDatabase.local_library_entities.toArray(),
    appDatabase.local_library_assignments.toArray(),
    appDatabase.local_music.toArray(),
  ]);
  const assignmentBySongId = new Map(assignments.map(assignment => [assignment.songId, assignment]));
  const songById = new Map([...allSongs, ...songs].map(song => [song.id, song]));
  const albumContext = new Map<string, string>();

  assignments.forEach(assignment => {
    if (!assignment.albumEntityId) return;
    const song = songById.get(assignment.songId);
    const albumName = song && getImportedAlbumName(song);
    if (song && albumName) albumContext.set(getAlbumImportContextKey(song, albumName), assignment.albumEntityId);
  });

  const nextAssignments: LocalLibraryAssignment[] = [];
  songs.forEach(song => {
    const current = assignmentBySongId.get(song.id);
    const preserveArtist = Boolean(preserveNonImportAssignments && current && current.artistOrigin !== 'import');
    const preserveAlbum = Boolean(preserveNonImportAssignments && current && current.albumOrigin !== 'import');
    const albumName = getImportedAlbumName(song);
    let albumId = preserveAlbum ? current?.albumEntityId : undefined;
    if (!preserveAlbum && albumName) {
      const contextKey = getAlbumImportContextKey(song, albumName);
      const normalizedArtistNames = new Set(getImportedArtistNames(song).map(normalizeLocalLibraryName));
      const artistOverlapAlbumIds = assignments.flatMap(assignment => {
        if (!assignment.albumEntityId) return [];
        const overlaps = assignment.artistEntityIds.some(entityId => {
          const entity = entities.find(item => item.id === entityId);
          return entity?.normalizedAliases.some(alias => normalizedArtistNames.has(alias));
        });
        return overlaps ? [assignment.albumEntityId] : [];
      });
      const uniqueOverlapAlbumIds = Array.from(new Set(artistOverlapAlbumIds));
      const preferredId = albumContext.get(contextKey)
        || current?.albumEntityId
        || (uniqueOverlapAlbumIds.length === 1 ? uniqueOverlapAlbumIds[0] : undefined);
      albumId = resolveEntityNames(entities, 'album', [albumName], preferredId ? [preferredId] : [])[0];
      if (albumId) albumContext.set(contextKey, albumId);
    }
    const albumArtistContext = albumId
      ? [...assignments, ...nextAssignments]
          .filter(assignment => assignment.albumEntityId === albumId)
          .flatMap(assignment => assignment.artistEntityIds)
      : [];
    const artistIds = preserveArtist
      ? current?.artistEntityIds || []
      : resolveEntityNames(
          entities,
          'artist',
          getImportedArtistNames(song),
          current?.artistEntityIds.length ? current.artistEntityIds : albumArtistContext,
        );
    nextAssignments.push({
      songId: song.id,
      artistEntityIds: artistIds,
      artistOrigin: preserveArtist ? current?.artistOrigin || 'import' : 'import',
      albumEntityId: albumId,
      albumOrigin: preserveAlbum ? current?.albumOrigin || 'import' : 'import',
      updatedAt: Date.now(),
    });
  });

  await Promise.all([
    appDatabase.local_music.bulkPut(songs.map(sanitizeLocalSongForStorage)),
    appDatabase.local_library_entities.bulkPut(entities),
    appDatabase.local_library_assignments.bulkPut(nextAssignments),
  ]);
};

export const assignImportedSongs = async (
  songs: LocalSong[],
  options: { preserveNonImportAssignments?: boolean } = {},
): Promise<void> => {
  await appDatabase.transaction(
    'rw',
    [appDatabase.local_music, appDatabase.local_library_entities, appDatabase.local_library_assignments],
    () => assignImportedSongsInTransaction(songs, options.preserveNonImportAssignments ?? true),
  );
};

const migrateExplicitlySeparatedArtistsInTransaction = async (): Promise<void> => {
  if (await appDatabase.api_cache.get(LOCAL_LIBRARY_ARTIST_SPLIT_MARKER_KEY)) return;
  const [songs, entities, assignments] = await Promise.all([
    appDatabase.local_music.toArray(),
    appDatabase.local_library_entities.toArray(),
    appDatabase.local_library_assignments.toArray(),
  ]);
  const songsById = new Map(songs.map(song => [song.id, song]));
  const changedAssignments = assignments.flatMap(assignment => {
    if (assignment.artistOrigin === 'split') return [];
    const song = songsById.get(assignment.songId);
    if (!song) return [];
    const names = assignment.artistOrigin === 'manual'
      ? (song.manualArtistNames || []).flatMap(splitLocalLibraryArtistNames)
      : assignment.artistOrigin === 'matched'
        ? getMatchedArtistNames(song)
        : getImportedArtistNames(song);
    if (names.length < 2) return [];
    const artistEntityIds = resolveEntityNames(entities, 'artist', names, assignment.artistEntityIds);
    if (
      artistEntityIds.length === assignment.artistEntityIds.length &&
      artistEntityIds.every((id, index) => id === assignment.artistEntityIds[index])
    ) return [];
    return [{ ...assignment, artistEntityIds, updatedAt: Date.now() }];
  });

  await Promise.all([
    appDatabase.local_library_entities.bulkPut(entities),
    appDatabase.local_library_assignments.bulkPut(changedAssignments),
    appDatabase.api_cache.put({
      key: LOCAL_LIBRARY_ARTIST_SPLIT_MARKER_KEY,
      data: { completedAt: Date.now() },
      timestamp: Date.now(),
    } satisfies StoredCacheEntry),
  ]);
};

// Bootstraps legacy records after open; any failure rolls back the marker and entity writes.
export const ensureLocalLibraryInitialized = async (): Promise<void> => {
  await appDatabase.transaction(
    'rw',
    [appDatabase.local_music, appDatabase.local_library_entities, appDatabase.local_library_assignments, appDatabase.api_cache],
    async () => {
      if (!(await appDatabase.api_cache.get(LOCAL_LIBRARY_BOOTSTRAP_MARKER_KEY))) {
        if (await appDatabase.local_library_assignments.count() > 0) {
          await appDatabase.api_cache.put({
            key: LOCAL_LIBRARY_BOOTSTRAP_MARKER_KEY,
            data: { completedAt: Date.now(), recovered: true },
            timestamp: Date.now(),
          });
        } else {
          const songs = await appDatabase.local_music.toArray();
          await assignImportedSongsInTransaction(songs, false);
          const entities = await appDatabase.local_library_entities.toArray();
          const assignments = new Map((await appDatabase.local_library_assignments.toArray()).map(item => [item.songId, item]));
          const matchedAssignments: LocalLibraryAssignment[] = [];
          songs.filter(song => song.useOnlineMetadata === true).forEach(song => {
            const current = assignments.get(song.id);
            const artistIds = resolveEntityNames(entities, 'artist', getMatchedArtistNames(song), current?.artistEntityIds);
            const albumName = cleanLocalLibraryName(song.matchedAlbumName);
            const albumId = albumName
              ? resolveEntityNames(entities, 'album', [albumName], current?.albumEntityId ? [current.albumEntityId] : [])[0]
              : undefined;
            matchedAssignments.push(createLocalLibraryAssignment(song.id, artistIds, albumId, 'matched'));
          });
          await Promise.all([
            appDatabase.local_library_entities.bulkPut(entities),
            appDatabase.local_library_assignments.bulkPut(matchedAssignments),
            appDatabase.api_cache.put({
              key: LOCAL_LIBRARY_BOOTSTRAP_MARKER_KEY,
              data: { completedAt: Date.now() },
              timestamp: Date.now(),
            } satisfies StoredCacheEntry),
          ]);
        }
      }
      await migrateExplicitlySeparatedArtistsInTransaction();
    },
  );
};
