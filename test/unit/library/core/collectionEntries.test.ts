import { describe, expect, it } from 'vitest';
import {
    buildDuplicateOccurrences,
    entryKeyAt,
    findEntryIndex,
    formatEntryKey,
} from '@/library/core/model/collectionEntries';
import { createLazyGridItems } from '@/components/folia-grid/lazyGridItems';
import { getPlaybackSongKey } from '@/utils/appPlaybackGuards';
import type { SongResult } from '@/types';

// test/unit/library/core/collectionEntries.test.ts
// 条目键必须与网格卡片 id 完全一致：焦点、恢复记录和删除动画都按这个键对上号，
// 换一个 renderer 也要能认出同一个条目。

const online = (id: string): SongResult => ({
    id,
    name: id,
    artists: [],
    album: { id: 0, name: '' },
    durationMs: 1,
    sourceRef: { kind: 'online', providerId: 'netease', mediaId: id },
} as SongResult);

const TRACKS = [online('a'), online('b'), online('a'), online('c'), online('a')];

describe('collection entries', () => {
    const { occurrences } = buildDuplicateOccurrences(TRACKS, null);

    it('numbers repeated songs by occurrence', () => {
        expect(TRACKS.map((_, index) => entryKeyAt(TRACKS, occurrences, index))).toEqual([
            formatEntryKey(getPlaybackSongKey(TRACKS[0]), 0),
            formatEntryKey(getPlaybackSongKey(TRACKS[1]), 0),
            formatEntryKey(getPlaybackSongKey(TRACKS[0]), 1),
            formatEntryKey(getPlaybackSongKey(TRACKS[3]), 0),
            formatEntryKey(getPlaybackSongKey(TRACKS[0]), 2),
        ]);
        expect(entryKeyAt(TRACKS, occurrences, 99)).toBeNull();
    });

    it('produces exactly the grid card ids', () => {
        const items = createLazyGridItems(TRACKS, occurrences);
        TRACKS.forEach((_, index) => {
            expect(entryKeyAt(TRACKS, occurrences, index)).toBe(items[index].id);
        });
    });

    it('finds an entry by key, including a later duplicate, and misses cleanly', () => {
        expect(findEntryIndex(TRACKS, occurrences, formatEntryKey(getPlaybackSongKey(TRACKS[0]), 2))).toBe(4);
        expect(findEntryIndex(TRACKS, occurrences, 'online:netease:zzz-0')).toBe(-1);
    });
});
