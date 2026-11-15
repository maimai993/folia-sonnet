import { describe, expect, it } from 'vitest';
import { splitSegments } from '../../../src/services/listeningArchive/rules';
import { toArchivePlay, toModRecord } from '../../../src/services/listeningArchive/modRecords';
import {
    listArchiveRecords,
    modPeriodRange,
    modSongKey,
    queryArchive,
    songTrajectory,
} from '../../../src/services/listeningArchive/modAnalytics';
import type { ArchivePlay } from '../../../src/services/listeningArchive/types';

// test/unit/listeningArchive/modAnalytics.test.ts
// 模组那套聚合的移植：记录换算、汇总 / 时间桶 / 热力、逐次播放分页、单曲轨迹。
// 口径与 analytics.cjs 一致，所以这里钉的是「换个地方算还是那个数」，不是新的规则。

const at = (year: number, month: number, day: number, hour = 0, minute = 0): number => (
    new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
);

const makePlay = (overrides: Partial<ArchivePlay> & { id: string }): ArchivePlay => {
    const startedAt = overrides.startedAt ?? at(2024, 3, 5, 10);
    const endedAt = overrides.endedAt ?? startedAt + 4 * 60 * 1000;
    const listenedSeconds = overrides.listenedSeconds ?? 240;
    return {
        songKey: 'song\u0001artist',
        songId: 'song-1',
        providerId: 'local',
        title: 'Song',
        artists: ['Artist'],
        albumName: 'Album',
        coverUrl: 'https://example.com/cover.jpg',
        startedAt,
        endedAt,
        listenedSeconds,
        totalSeconds: 240,
        counted: true,
        completed: true,
        segments: splitSegments(startedAt, endedAt, listenedSeconds),
        ...overrides,
    };
};

describe('toModRecord', () => {
    it('把一行本机记录换成模组的一次播放：段保留真实墙钟区间和时区偏移', () => {
        const play = makePlay({ id: 'a', startedAt: at(2024, 3, 5, 10, 12), endedAt: at(2024, 3, 5, 10, 16) });
        const record = toModRecord(play);

        expect(record.id).toBe('a');
        expect(record.closed).toBe(true);
        expect(record.duration).toBe(240);
        expect(record.song).toEqual({
            id: 'song-1',
            title: 'Song',
            artist: 'Artist',
            album: 'Album',
            source: 'local',
        });
        expect(record.segments).toHaveLength(1);
        expect(record.segments[0]).toMatchObject({
            start: play.startedAt,
            end: play.endedAt,
            seconds: 240,
            offset: new Date(play.startedAt).getTimezoneOffset(),
        });
    });

    it('没有段的行也给一段非零区间，免得后面的比例运算出 Infinity', () => {
        const play = makePlay({ id: 'b', startedAt: at(2024, 3, 5, 9), endedAt: at(2024, 3, 5, 9), segments: [] });
        const record = toModRecord(play);

        expect(record.segments).toHaveLength(1);
        expect(record.segments[0].end).toBeGreaterThan(record.segments[0].start);
    });

    it('歌手按「 / 」拼回模组要的那一个字符串', () => {
        const play = makePlay({ id: 'c', artists: ['A', 'B'] });
        expect(toModRecord(play).song.artist).toBe('A / B');
    });

    it('坏掉的时刻只影响那一行：段起点、起止时刻不成 NaN，整页不会被一行坏数据拖死', () => {
        const play = makePlay({ id: 'd', segments: [{ day: '2024-03-05', startedAt: Number.NaN, seconds: 60 }] });
        const record = toModRecord(play);

        expect(Number.isFinite(record.startedAt)).toBe(true);
        expect(Number.isFinite(record.endedAt)).toBe(true);
        expect(record.segments.every(segment => (
            Number.isFinite(segment.start)
            && Number.isFinite(segment.end)
            && Number.isFinite(segment.offset)
        ))).toBe(true);
        expect(record.segments[0].seconds).toBe(60);
    });
});

describe('toArchivePlay', () => {
    it('模组备份里的一行能换回本机记录，段按本机口径重算', () => {
        const play = toArchivePlay({
            id: 'imported-1',
            startedAt: at(2024, 3, 5, 8),
            endedAt: at(2024, 3, 5, 8, 3),
            duration: 180,
            song: { id: '9', title: 'Imported', artist: 'X / Y', album: 'Al', source: 'netease' },
            segments: [{ start: at(2024, 3, 5, 8), end: at(2024, 3, 5, 8, 3), seconds: 180, offset: 0 }],
        });

        expect(play).not.toBeNull();
        expect(play?.artists).toEqual(['X', 'Y']);
        expect(play?.listenedSeconds).toBe(180);
        expect(play?.completed).toBe(true);
        expect(play?.segments.reduce((sum, segment) => sum + segment.seconds, 0)).toBe(180);
    });

    it('缺 id / 缺歌名的行算坏行', () => {
        expect(toArchivePlay({ startedAt: 1, song: { title: 't' } })).toBeNull();
        expect(toArchivePlay({ id: 'x', startedAt: 1, song: { title: '' } })).toBeNull();
        expect(toArchivePlay('nope')).toBeNull();
    });
});

describe('modSongKey', () => {
    it('忽略大小写、空白和歌手顺序', () => {
        expect(modSongKey({ id: null, title: ' Song  Name ', artist: 'B / A', album: null, source: null }))
            .toBe(modSongKey({ id: null, title: 'song name', artist: 'a / b', album: null, source: null }));
    });
});

describe('queryArchive', () => {
    it('一天的汇总、时间桶与热力都落在那一小时上', () => {
        const play = makePlay({ id: 'a', startedAt: at(2024, 3, 5, 10), endedAt: at(2024, 3, 5, 10, 4) });
        const range = modPeriodRange('day', play.startedAt);
        const result = queryArchive([toModRecord(play)], range);

        expect(result.summary.plays).toBe(1);
        expect(result.summary.songs).toBe(1);
        expect(result.summary.artists).toBe(1);
        expect(result.summary.albums).toBe(1);
        // 听完的按曲目时长算：240 秒。
        expect(Math.round(result.summary.seconds)).toBe(240);
        expect(result.buckets).toHaveLength(24);
        expect(Math.round(result.buckets[10].seconds)).toBe(240);
        expect(Math.round(result.habits[1 * 24 + 10])).toBe(240);
        expect(result.songs[0].plays).toBe(1);
    });

    it('不到 30 秒的一次不算计次，只算时长', () => {
        const startedAt = at(2024, 3, 5, 10);
        const play = makePlay({
            id: 'short',
            startedAt,
            endedAt: startedAt + 10 * 1000,
            listenedSeconds: 10,
            totalSeconds: 200,
        });
        const result = queryArchive([toModRecord(play)], modPeriodRange('day', startedAt));

        expect(result.summary.plays).toBe(0);
        expect(Math.round(result.summary.seconds)).toBe(10);
    });

    it('范围外的一天什么都不算，但 recordCount 照实说本机有多少条', () => {
        const play = makePlay({ id: 'a', startedAt: at(2024, 3, 5, 10) });
        const result = queryArchive([toModRecord(play)], modPeriodRange('day', at(2024, 4, 5, 10)));

        expect(result.summary.seconds).toBe(0);
        expect(result.recordCount).toBe(1);
        expect(result.firstRecorded).toBe(play.startedAt);
    });

    it('按歌手筛选只留那一位歌手的记录', () => {
        const play = makePlay({ id: 'a', startedAt: at(2024, 3, 5, 10), artists: ['Artist'] });
        const range = { ...modPeriodRange('day', play.startedAt), filter: { artistKey: 'artist' } };
        const other = { ...range, filter: { artistKey: 'nobody' } };

        expect(queryArchive([toModRecord(play)], range).summary.plays).toBe(1);
        expect(queryArchive([toModRecord(play)], other).summary.plays).toBe(0);
    });
});

describe('listArchiveRecords', () => {
    it('最近的在前，按 offset/limit 分页，total 是整段的数量', () => {
        const records = [1, 2, 3].map(index => toModRecord(makePlay({
            id: `p${index}`,
            startedAt: at(2024, 3, 5, 10 + index),
            endedAt: at(2024, 3, 5, 10 + index, 4),
        })));
        const query = { ...modPeriodRange('day', at(2024, 3, 5, 10)), offset: 1, limit: 1 };
        const page = listArchiveRecords(records, query);

        expect(page.total).toBe(3);
        expect(page.offset).toBe(1);
        expect(page.items).toHaveLength(1);
        expect(page.items[0].id).toBe('p2');
        expect(page.items[0].counted).toBe(true);
    });
});

describe('songTrajectory', () => {
    it('给出第一次 / 最近一次、按月名次与习惯分布', () => {
        const first = makePlay({ id: 'a', startedAt: at(2024, 3, 5, 10) });
        const second = makePlay({ id: 'b', startedAt: at(2024, 4, 6, 21), endedAt: at(2024, 4, 6, 21, 4) });
        const third = makePlay({ id: 'd', startedAt: at(2024, 4, 6, 22), endedAt: at(2024, 4, 6, 22, 4) });
        const other = makePlay({
            id: 'c',
            startedAt: at(2024, 4, 7, 8),
            endedAt: at(2024, 4, 7, 8, 4),
            title: 'Other',
            songKey: 'other\u0001artist',
        });
        const records = [first, second, third, other].map(toModRecord);
        const trajectory = songTrajectory(records, modSongKey(records[0].song), 'month');

        expect(trajectory.first).toBe(first.startedAt);
        expect(trajectory.last).toBe(third.endedAt);
        expect(trajectory.summary.plays).toBe(3);
        expect(trajectory.ranks.length).toBeGreaterThan(0);
        // 最近一个月（4 月）里它排第一：两天三条，另一首只有一天一条。
        expect(trajectory.ranks[trajectory.ranks.length - 1]).toEqual({ label: expect.any(String), rank: 1 });
        expect(Math.round(trajectory.habits[1 * 24 + 10])).toBe(240);
    });
});
