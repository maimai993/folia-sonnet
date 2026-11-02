import Dexie, { type Table } from 'dexie';
import type { LocalSong } from '../types';
import type { LocalLibraryAssignment, LocalLibraryEntity } from '../types/localLibrary';
import type { LocalCoverAsset } from '../types/localCover';
import { migrateLegacyLocalSongRecords } from './localLibraryV8Migration';
import type { ArchivePlay } from './listeningArchive/types';

// src/services/appDatabase.ts
// Owns the complete typed Dexie schema for local songs, entities, and content-addressed cover assets.
// v10 adds `listeningArchivePlays`: the listening archive grows with every play and is user data, not
// a rebuildable cache, so it needs its own table instead of sharing one the storage page clears.

export const APP_DATABASE_NAME = 'KineticPlayerDB';
export const APP_DATABASE_VERSION_CHANGE_EVENT = 'folia-database-version-change';
export const LOCAL_LIBRARY_BOOTSTRAP_MARKER_KEY = 'local_library_entities_bootstrap_v1';
export const LOCAL_LIBRARY_ARTIST_SPLIT_MARKER_KEY = 'local_library_artist_delimiter_split_v1';

export interface StoredCacheEntry<T = unknown> {
  key: string;
  data: T;
  timestamp: number;
}

export interface ThemeRegistryRecord {
  fingerprint: string;
  [key: string]: unknown;
}

export class AppDatabase extends Dexie {
  session!: Table<unknown, string>;
  api_cache!: Table<StoredCacheEntry, string>;
  user_cache!: Table<StoredCacheEntry, string>;
  media_cache!: Table<StoredCacheEntry, string>;
  metadata_cache!: Table<StoredCacheEntry, string>;
  local_music!: Table<LocalSong, string>;
  theme_registry!: Table<ThemeRegistryRecord, string>;
  local_library_entities!: Table<LocalLibraryEntity, string>;
  local_library_assignments!: Table<LocalLibraryAssignment, string>;
  local_cover_assets!: Table<LocalCoverAsset, string>;
  listeningArchivePlays!: Table<ArchivePlay, string>;

  constructor(name = APP_DATABASE_NAME) {
    super(name);

    this.version(0.6).stores({
      session: '',
      api_cache: 'key',
      user_cache: 'key',
      media_cache: 'key',
      metadata_cache: 'key',
      local_music: 'id',
      theme_registry: 'fingerprint',
    });

    this.version(0.7).stores({
      session: '',
      api_cache: 'key',
      user_cache: 'key',
      media_cache: 'key',
      metadata_cache: 'key',
      local_music: 'id',
      theme_registry: 'fingerprint',
      local_library_entities: 'id, kind, *normalizedAliases, mergedInto, needsReview, createdAt',
      local_library_assignments: 'songId, *artistEntityIds, albumEntityId, artistOrigin, albumOrigin',
    });

    this.version(0.8).stores({
      session: '',
      api_cache: 'key',
      user_cache: 'key',
      media_cache: 'key',
      metadata_cache: 'key',
      local_music: 'id',
      theme_registry: 'fingerprint',
      local_library_entities: 'id, kind, *normalizedAliases, mergedInto, needsReview, createdAt',
      local_library_assignments: 'songId, *artistEntityIds, albumEntityId, artistOrigin, albumOrigin',
    }).upgrade(async transaction => {
      const legacySongs = await transaction.table<LocalSong, string>('local_music').toArray();
      const migrated = migrateLegacyLocalSongRecords(legacySongs as Array<LocalSong & Record<string, unknown>>);
      await Promise.all([
        transaction.table('local_music').bulkPut(migrated.songs),
        transaction.table('local_library_entities').clear().then(() => (
          transaction.table('local_library_entities').bulkPut(migrated.entities)
        )),
        transaction.table('local_library_assignments').clear().then(() => (
          transaction.table('local_library_assignments').bulkPut(migrated.assignments)
        )),
      ]);
    });

    this.version(0.9).stores({
      session: '',
      api_cache: 'key',
      user_cache: 'key',
      media_cache: 'key',
      metadata_cache: 'key',
      local_music: 'id, localCoverAssetId',
      theme_registry: 'fingerprint',
      local_library_entities: 'id, kind, *normalizedAliases, mergedInto, needsReview, createdAt',
      local_library_assignments: 'songId, *artistEntityIds, albumEntityId, artistOrigin, albumOrigin',
      local_cover_assets: 'id',
    });

    // A new version number, not `0.10`: `0.10` is the number 0.1, which sorts below the existing 0.9.
    // Only the new table is added; every earlier version keeps the schema it shipped with.
    this.version(10).stores({
      session: '',
      api_cache: 'key',
      user_cache: 'key',
      media_cache: 'key',
      metadata_cache: 'key',
      local_music: 'id, localCoverAssetId',
      theme_registry: 'fingerprint',
      local_library_entities: 'id, kind, *normalizedAliases, mergedInto, needsReview, createdAt',
      local_library_assignments: 'songId, *artistEntityIds, albumEntityId, artistOrigin, albumOrigin',
      local_cover_assets: 'id',
      listeningArchivePlays: 'id, startedAt, songKey, [startedAt+songKey]',
    });

    this.on('versionchange', event => {
      this.close();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(APP_DATABASE_VERSION_CHANGE_EVENT, {
          detail: { oldVersion: event.oldVersion, newVersion: event.newVersion },
        }));
        window.setTimeout(() => window.location.reload(), 0);
      }
    });
  }
}

export const appDatabase = new AppDatabase();
