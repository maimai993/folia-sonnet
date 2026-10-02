import type { SongResult } from '../../../types';
import type { MediaId } from '../../../types/onlineMusic';
import type { OnlineGridViewCollectionDescriptor } from '../contracts/collection';
import { saveToCache } from '../../../services/db';
import { getProviderCacheKey, getProviderCacheWithLegacyMigration } from '../../../services/onlineMusic/providerStorage';

// src/library/core/services/onlineCollectionCache.ts
// 在线集合曲目的本地缓存：键怎么拼、读回来怎么解析、什么时候算有效。原先散在 GridView 里。
//
// 键的前缀 `playlist_tracks_` 不能动：歌词导出靠它找曲目名，缓存分类与清理按它归类，加入歌单
// 后也按这个键作废。歌单的键保持原样；其余类型（专辑、每日推荐……）在 id 前加上类型，
// 否则同一个 provider 下专辑与歌单同 id 时会互相覆盖。专辑没有曲目更新时间，原本就从不命中
// 缓存，换键不丢任何东西。

export const ONLINE_TRACKS_CACHE_SCHEMA_VERSION = 5;

type OnlineTracksCacheIdentity = Pick<OnlineGridViewCollectionDescriptor, 'providerId' | 'type' | 'id'>;

export type OnlineTracksCacheEntry = {
    tracks: SongResult[];
    snapshotTime: number;
    schemaVersion: number;
};

type StoredOnlineTracks = { tracks: SongResult[]; snapshotTime: number; schemaVersion?: number } | SongResult[];

export const isCloudDriveCollection = (collection: Pick<OnlineTracksCacheIdentity, 'type' | 'id'>): boolean => (
    collection.type === 'cloud' || Number(collection.id) === -100
);

/** 缓存键的 provider 内部分（不含 provider 命名空间）。 */
export const resolveOnlineTracksCacheSuffix = (
    collection: Pick<OnlineTracksCacheIdentity, 'type' | 'id'>,
    currentUserId?: MediaId | null,
): string => {
    if (isCloudDriveCollection(collection)) {
        return `playlist_tracks_cloud_${currentUserId ?? 'anonymous'}`;
    }
    return collection.type === 'playlist'
        ? `playlist_tracks_${collection.id}`
        : `playlist_tracks_${collection.type}_${collection.id}`;
};

export const resolveOnlineTracksCacheKey = (
    collection: OnlineTracksCacheIdentity,
    currentUserId?: MediaId | null,
): string => getProviderCacheKey(collection.providerId, resolveOnlineTracksCacheSuffix(collection, currentUserId));

/** 缓存快照对应的集合版本：曲目更新时间，没有就用集合更新时间；都没有为 0（永不命中）。 */
export const resolveOnlineTracksTargetTime = (
    collection: Pick<OnlineGridViewCollectionDescriptor, 'tracksUpdatedAt' | 'updatedAt'>,
): number => collection.tracksUpdatedAt || collection.updatedAt || 0;

/** 解析存储里的值；旧版本直接存的数组视为没有快照时间。 */
export const parseCachedOnlineTracks = (stored: StoredOnlineTracks | null | undefined): OnlineTracksCacheEntry => {
    if (Array.isArray(stored)) {
        return { tracks: stored, snapshotTime: 0, schemaVersion: 0 };
    }
    if (stored && stored.tracks) {
        return { tracks: stored.tracks, snapshotTime: stored.snapshotTime, schemaVersion: stored.schemaVersion ?? 0 };
    }
    return { tracks: [], snapshotTime: 0, schemaVersion: 0 };
};

/** 只有快照时间与集合版本对得上、且结构版本是当前版本时，缓存才能直接用。 */
export const isOnlineTracksCacheValid = (entry: OnlineTracksCacheEntry, targetTime: number): boolean => (
    entry.tracks.length > 0
    && targetTime > 0
    && entry.snapshotTime === targetTime
    && entry.schemaVersion === ONLINE_TRACKS_CACHE_SCHEMA_VERSION
);

export const readOnlineTracksCache = async (
    collection: OnlineTracksCacheIdentity,
    currentUserId?: MediaId | null,
): Promise<OnlineTracksCacheEntry> => {
    const suffix = resolveOnlineTracksCacheSuffix(collection, currentUserId);
    const stored = await getProviderCacheWithLegacyMigration<StoredOnlineTracks>(collection.providerId, suffix, [suffix]);
    return parseCachedOnlineTracks(stored);
};

/** 写一份快照。`snapshotTime` 与集合版本不一致的写入（例如本地删歌后）会让下次打开重新拉取。 */
export const writeOnlineTracksCache = (cacheKey: string, tracks: SongResult[], snapshotTime: number): Promise<void> => (
    saveToCache(cacheKey, { tracks, snapshotTime, schemaVersion: ONLINE_TRACKS_CACHE_SCHEMA_VERSION })
);
