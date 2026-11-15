import type { CollectionSyncPage } from './onlineCollectionSync.service';

// src/library/core/collection/resource/collectionTrackSnapshot.service.ts
// Preserve upstream pagination separately from the number of visible, deduplicated tracks.

/**
 * 7 → 8：在线歌单的曲目顺序修过一次（手机上按 trackIds 归位，与电脑同序），但整份曲目是
 * 存在本地缓存里的，快照时间对得上就一直命中 —— 于是装了新版仍然是缓存里那份**旧顺序**，
 * 看着就像「修了没生效 / 还是反的」。顶一版让所有旧快照作废，下次打开重新拉一次。
 *
 * 改动这个数会把所有在线集合的曲目缓存清空一次（只是重拉，不丢用户数据）。
 */
export const COLLECTION_TRACK_SNAPSHOT_SCHEMA_VERSION = 8;
// 8：补页以前会被集合描述里过期的曲目数提前截断（只剩首页 150 首），并把截断的结果记成读完了；
// 换版本让这些快照一次作废，打开时重新读。

export type CollectionTrackSnapshot<T> = {
    schemaVersion: number;
    snapshotTime: number;
    tracks: T[];
    nextOffset: number;
    hasMore: boolean;
    total?: number;
};

export const createCollectionTrackSnapshot = <T>(
    page: CollectionSyncPage<T>,
    snapshotTime: number,
): CollectionTrackSnapshot<T> => ({
    schemaVersion: COLLECTION_TRACK_SNAPSHOT_SCHEMA_VERSION,
    snapshotTime,
    tracks: page.items,
    nextOffset: page.nextOffset,
    hasMore: page.hasMore,
    total: page.total,
});

// Old schemas inferred progress from the row count and cannot safely resume sparse pages.
export const readCollectionTrackSnapshot = <T>(
    cached: unknown,
    targetTime: number,
): CollectionTrackSnapshot<T> | null => {
    if (!cached || typeof cached !== 'object' || targetTime <= 0) return null;
    const snapshot = cached as CollectionTrackSnapshot<T>;
    if (snapshot.schemaVersion !== COLLECTION_TRACK_SNAPSHOT_SCHEMA_VERSION || snapshot.snapshotTime !== targetTime
        || !Array.isArray(snapshot.tracks) || typeof snapshot.hasMore !== 'boolean'
        || !Number.isSafeInteger(snapshot.nextOffset) || snapshot.nextOffset < snapshot.tracks.length
        || (snapshot.hasMore && snapshot.nextOffset === 0)) return null;
    return snapshot;
};
