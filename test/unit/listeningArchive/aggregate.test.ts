import { describe, expect, it } from 'vitest';
import {
    heatCells,
    rankEntries,
    songTrajectory,
    timelineBuckets,
    totals,
} from '../../../src/services/listeningArchive/aggregate';
import { splitSegments } from '../../../src/services/listeningArchive/rules';
import type { ArchivePlay } from '../../../src/services/listeningArchive/types';

// test/unit/listeningArchive/aggregate.test.ts
// 读时聚合：排行分组与排序、时间轴空桶、热力格铺满、单曲轨迹的月度排名与分布。
// 时刻一律按本地时间构造，跑在哪个时区结论都一样。

const at = (year: number, month: number, day: number, hour = 0, minute = 0): number => (
    new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
);

/** 造一行播放：默认同一天、听了 60 秒且计次。 */
const makePlay = (overrides: Partial<ArchivePlay> & { id: string }): ArchivePlay => {
    const startedAt = overrides.startedAt ?? at(2024, 3, 5, 10);
    const endedAt = overrides.endedAt ?? startedAt + 60_000;
    const listenedSeconds = overrides.listenedSeconds ?? 60;
    const totalSeconds = overrides.totalSeconds ?? 200;
    return {
        songKey: 'song\u0001artist',
        songId: 'song-1',
        providerId: 'local',
        title: 'Song',
        artists: ['Artist'],
        albumName: null,
        coverUrl: null,
        startedAt,
        endedAt,
        listenedSeconds,
        totalSeconds,
        counted: true,
        completed: false,
        ...overrides,
        // 覆盖后重新对齐日段，免得用例里的 startedAt 与 segments 不一致。
        segments: overrides.segments ?? splitSegments(startedAt, endedAt, listenedSeconds),
    } as ArchivePlay;
};

describe('rankEntries 歌曲视角', () => {
    it('按 songKey 分组，plays 只算 counted，seconds 累加实测秒数', () => {
        const plays = [
            makePlay({ id: '1', songKey: 'a', title: 'A', startedAt: at(2024, 3, 1, 9), listenedSeconds: 120 }),
            makePlay({ id: '2', songKey: 'a', title: 'A', startedAt: at(2024, 3, 2, 9), listenedSeconds: 30, counted: false }),
            makePlay({ id: '3', songKey: 'b', title: 'B', startedAt: at(2024, 3, 3, 9), listenedSeconds: 300 }),
        ];
        const entries = rankEntries(plays, 'song', 'plays');
        const a = entries.find(entry => entry.key === 'a');
        expect(a).toMatchObject({ plays: 1, seconds: 150, firstHeardAt: at(2024, 3, 1, 9), subtitle: 'Artist' });
        expect(entries[0].key).toBe('b');
        expect(entries[0].plays).toBe(1);
    });

    it('同次数按秒数、再按歌名定序', () => {
        const plays = [
            makePlay({ id: '1', songKey: 'x', title: 'Zeta', listenedSeconds: 100 }),
            makePlay({ id: '2', songKey: 'y', title: 'Alpha', listenedSeconds: 50 }),
            makePlay({ id: '3', songKey: 'z', title: 'Beta', listenedSeconds: 50 }),
        ];
        const entries = rankEntries(plays, 'song', 'plays');
        expect(entries.map(entry => entry.title)).toEqual(['Zeta', 'Alpha', 'Beta']);
    });

    it('newest 按首次听到的时刻倒序', () => {
        const plays = [
            makePlay({ id: '1', songKey: 'old', title: 'Old', startedAt: at(2024, 1, 1, 9) }),
            makePlay({ id: '2', songKey: 'new', title: 'New', startedAt: at(2024, 5, 1, 9) }),
        ];
        expect(rankEntries(plays, 'song', 'newest').map(entry => entry.key)).toEqual(['new', 'old']);
    });

    it('封面取最近一次非空的那张，标题取最近一次播放的写法', () => {
        const plays = [
            makePlay({ id: '1', songKey: 'a', title: 'Song (Live)', coverUrl: 'cover-1', startedAt: at(2024, 3, 1, 9) }),
            makePlay({ id: '2', songKey: 'a', title: 'Song (Live)', coverUrl: 'cover-2', startedAt: at(2024, 3, 5, 9) }),
            makePlay({ id: '3', songKey: 'a', title: 'Song', startedAt: at(2024, 3, 9, 9) }),
        ];
        const [entry] = rankEntries(plays, 'song', 'plays');
        expect(entry.coverUrl).toBe('cover-2');
        expect(entry.title).toBe('Song');
    });
});

describe('rankEntries 歌手与专辑视角', () => {
    it('合唱歌手各计一次，同一次播放里重复的歌手只算一次', () => {
        const plays = [
            makePlay({ id: '1', songKey: 'a', artists: ['Jay', 'Fei'], startedAt: at(2024, 3, 1, 9), listenedSeconds: 120 }),
            makePlay({ id: '2', songKey: 'a', artists: ['Jay', 'Jay'], startedAt: at(2024, 3, 2, 9), listenedSeconds: 60 }),
        ];
        const entries = rankEntries(plays, 'artist', 'plays');
        expect(entries.map(entry => [entry.key, entry.plays, entry.seconds])).toEqual([
            ['jay', 2, 180],
            ['fei', 1, 120],
        ]);
        // 歌手视角没有副标题，标题保留来源原始写法。
        expect(entries[0].subtitle).toBe('');
        expect(entries[0].title).toBe('Jay');
    });

    it('专辑按归一后的名字分组，没有专辑名的不参与', () => {
        const plays = [
            makePlay({ id: '1', songKey: 'a', albumName: '  OK   Computer ', startedAt: at(2024, 3, 1, 9) }),
            makePlay({ id: '2', songKey: 'b', albumName: 'ok computer', startedAt: at(2024, 3, 2, 9) }),
            makePlay({ id: '3', songKey: 'c', albumName: null, startedAt: at(2024, 3, 3, 9) }),
            makePlay({ id: '4', songKey: 'd', albumName: '   ', startedAt: at(2024, 3, 4, 9) }),
        ];
        const entries = rankEntries(plays, 'album', 'plays');
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ key: 'ok computer', plays: 2, subtitle: 'Artist' });
    });
});

describe('rankEntries 搜索', () => {
    const plays = [
        makePlay({ id: '1', songKey: 'a', title: 'Hotel California', artists: ['Eagles'] }),
        makePlay({ id: '2', songKey: 'b', title: '晴天', artists: ['周杰伦'] }),
    ];

    it('空查询返回全部，有查询时按主副标题做大小写不敏感的包含匹配', () => {
        expect(rankEntries(plays, 'song', 'plays')).toHaveLength(2);
        expect(rankEntries(plays, 'song', 'plays', '   ')).toHaveLength(2);
        expect(rankEntries(plays, 'song', 'plays', 'HOTEL').map(entry => entry.title)).toEqual(['Hotel California']);
        expect(rankEntries(plays, 'song', 'plays', 'eagles').map(entry => entry.title)).toEqual(['Hotel California']);
        expect(rankEntries(plays, 'song', 'plays', '晴天')).toHaveLength(1);
        expect(rankEntries(plays, 'song', 'plays', '没有这首')).toEqual([]);
    });
});

describe('timelineBuckets', () => {
    it('由 bucketRange 铺满，空桶的秒数与次数都是 0', () => {
        const plays = [makePlay({ id: '1', songKey: 'a', startedAt: at(2024, 3, 5, 22), listenedSeconds: 60 })];
        const buckets = timelineBuckets(plays, 'day', at(2024, 3, 4), at(2024, 3, 7));
        expect(buckets.map(bucket => [bucket.key, bucket.seconds, bucket.plays])).toEqual([
            ['2024-03-04', 0, 0],
            ['2024-03-05', 60, 1],
            ['2024-03-06', 0, 0],
            ['2024-03-07', 0, 0],
        ]);
    });

    it('跨午夜的播放把秒数分到两天，次数落在开始那天', () => {
        const start = at(2024, 3, 5, 23);
        const end = at(2024, 3, 6, 1);
        const plays = [makePlay({ id: '1', songKey: 'a', startedAt: start, endedAt: end, listenedSeconds: 600 })];
        const buckets = timelineBuckets(plays, 'day', at(2024, 3, 5), at(2024, 3, 6));
        expect(buckets.map(bucket => [bucket.key, bucket.seconds, bucket.plays])).toEqual([
            ['2024-03-05', 300, 1],
            ['2024-03-06', 300, 0],
        ]);
    });

    it('周粒度把同一周的几天并进一个桶，范围外的日段丢掉', () => {
        const plays = [
            makePlay({ id: '1', songKey: 'a', startedAt: at(2024, 1, 15, 9), listenedSeconds: 100 }),
            makePlay({ id: '2', songKey: 'a', startedAt: at(2024, 1, 21, 9), listenedSeconds: 50 }),
            makePlay({ id: '3', songKey: 'a', startedAt: at(2024, 2, 1, 9), listenedSeconds: 999 }),
        ];
        const buckets = timelineBuckets(plays, 'week', at(2024, 1, 15), at(2024, 1, 21));
        expect(buckets).toHaveLength(1);
        expect(buckets[0]).toMatchObject({ key: '2024-W03', seconds: 150, plays: 2 });
    });
});

describe('heatCells', () => {
    it('7×24 全铺，weekday 0 是周一', () => {
        const cells = heatCells([], at(2024, 3, 1), at(2024, 3, 31));
        expect(cells).toHaveLength(168);
        expect(cells.filter(cell => cell.seconds !== 0)).toEqual([]);
        expect(cells[0]).toEqual({ weekday: 0, hour: 0, seconds: 0 });
        expect(cells[167]).toEqual({ weekday: 6, hour: 23, seconds: 0 });
    });

    it('日段的秒数落到该段起点所在的星期与小时', () => {
        // 2024-03-05 是周二，10:00 起听 30 分钟。
        const plays = [makePlay({
            id: '1',
            startedAt: at(2024, 3, 5, 10),
            endedAt: at(2024, 3, 5, 10, 30),
            listenedSeconds: 1800,
        })];
        const cells = heatCells(plays, at(2024, 3, 1), at(2024, 3, 31));
        const hit = cells.filter(cell => cell.seconds > 0);
        expect(hit).toEqual([{ weekday: 1, hour: 10, seconds: 1800 }]);
    });

    it('范围外的段不计入', () => {
        const plays = [makePlay({ id: '1', startedAt: at(2024, 2, 5, 10) })];
        const cells = heatCells(plays, at(2024, 3, 1), at(2024, 3, 31));
        expect(cells.every(cell => cell.seconds === 0)).toBe(true);
    });
});

describe('songTrajectory', () => {
    const now = at(2024, 3, 20, 12);
    const plays = [
        // 这一首：2024-02 与人并列之外只有自己一首；2024-03 输给另一首。
        makePlay({ id: '1', songKey: 'mine', title: 'Mine', albumName: 'Album', coverUrl: null, startedAt: at(2024, 2, 10, 21), listenedSeconds: 200, totalSeconds: 200 }),
        makePlay({ id: '2', songKey: 'mine', title: 'Mine', albumName: 'Album', coverUrl: 'cover-2', startedAt: at(2024, 3, 5, 8), listenedSeconds: 100 }),
        makePlay({ id: '3', songKey: 'mine', title: 'Mine (Live)', albumName: 'Album', coverUrl: null, startedAt: at(2024, 3, 9, 8), listenedSeconds: 50, counted: false }),
        makePlay({ id: '4', songKey: 'other', title: 'Other', startedAt: at(2024, 3, 6, 8), listenedSeconds: 400 }),
    ];

    it('累计次数与时长、首末听到时刻、最近 24 个月排名', () => {
        const trajectory = songTrajectory(plays, 'mine', now);
        expect(trajectory).not.toBeNull();
        const result = trajectory!;
        expect(result.plays).toBe(2);
        expect(result.seconds).toBe(350);
        expect(result.firstHeardAt).toBe(at(2024, 2, 10, 21));
        expect(result.lastHeardAt).toBe(at(2024, 3, 9, 8));
        // 显示用的标题取最近一次播放的写法，封面取最近一次非空的。
        expect(result.title).toBe('Mine (Live)');
        expect(result.coverUrl).toBe('cover-2');
        expect(result.albumName).toBe('Album');

        expect(result.monthly).toHaveLength(24);
        expect(result.monthly[0].month).toBe('2022-04');
        expect(result.monthly[23].month).toBe('2024-03');
        const march = result.monthly.find(entry => entry.month === '2024-03');
        // 2024-03 里 Other 有 400 秒，这一首 150 秒，排第二。
        expect(march).toMatchObject({ rank: 2, plays: 1, seconds: 150 });
        const february = result.monthly.find(entry => entry.month === '2024-02');
        expect(february).toMatchObject({ rank: 1, plays: 1, seconds: 200 });
        // 没有记录的月份 rank 为 null。
        expect(result.monthly.find(entry => entry.month === '2023-06')).toMatchObject({ rank: null, plays: 0, seconds: 0 });
    });

    it('星期与小时分布、按日期的升序时间轴', () => {
        const result = songTrajectory(plays, 'mine', now)!;
        expect(result.weekdaySeconds).toHaveLength(7);
        expect(result.hourlySeconds).toHaveLength(24);
        // 2024-02-10 是周六（index 5），21 点；2024-03-05 周二、2024-03-09 周六的 8 点。
        expect(result.weekdaySeconds[5]).toBeCloseTo(250, 6);
        expect(result.weekdaySeconds[1]).toBeCloseTo(100, 6);
        expect(result.hourlySeconds[21]).toBeCloseTo(200, 6);
        expect(result.hourlySeconds[8]).toBeCloseTo(150, 6);
        expect(result.days).toEqual([
            { day: '2024-02-10', plays: 1, seconds: 200 },
            { day: '2024-03-05', plays: 1, seconds: 100 },
            { day: '2024-03-09', plays: 0, seconds: 50 },
        ]);
    });

    it('没听过的歌返回 null', () => {
        expect(songTrajectory(plays, 'unknown', now)).toBeNull();
        expect(songTrajectory([], 'mine', now)).toBeNull();
    });
});

describe('totals', () => {
    it('次数只算 counted，秒数全算，歌曲数按 songKey 去重', () => {
        const plays = [
            makePlay({ id: '1', songKey: 'a', listenedSeconds: 100 }),
            makePlay({ id: '2', songKey: 'a', listenedSeconds: 20, counted: false }),
            makePlay({ id: '3', songKey: 'b', listenedSeconds: 30 }),
        ];
        expect(totals(plays)).toEqual({ plays: 2, seconds: 150, songs: 2 });
        expect(totals([])).toEqual({ plays: 0, seconds: 0, songs: 0 });
    });
});
