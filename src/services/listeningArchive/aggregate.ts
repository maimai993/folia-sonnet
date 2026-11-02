import {
    bucketKeyOf,
    bucketRange,
    localDayKey,
    normalizeAlbumName,
    normalizeArtistName,
    splitSegments,
} from './rules';
import type {
    ArchiveBucket,
    ArchiveDayEntry,
    ArchiveGranularity,
    ArchiveHeatCell,
    ArchiveMonthlyRank,
    ArchivePlay,
    ArchiveRankEntry,
    ArchiveRankKind,
    ArchiveRankSort,
    ArchiveSongTrajectory,
    ArchiveSegment,
} from './types';

// src/services/listeningArchive/aggregate.ts
// 听歌档案的读时聚合：排行、时长桶、热力格、单曲轨迹与总计，全部是纯函数，输入只有落库的播放行。

/** 副标题里多个歌手之间的分隔符，界面直接显示这个字符串。 */
const ARTIST_SEPARATOR = ' / ';

/** 单曲轨迹的「最近月度排名」看多少个月（含当月）。 */
const MONTHLY_RANK_MONTHS = 24;

/**
 * 一次播放的日段。采集侧已经把同一口径的结果写进 `segments`，这里优先用它的；
 * 老备份或手写的行没有日段时按同一口径重算，保证聚合结果与 listenedSeconds 对得上。
 */
const segmentsOf = (play: ArchivePlay): ArchiveSegment[] => (
    Array.isArray(play.segments) && play.segments.length > 0
        ? play.segments
        : splitSegments(play.startedAt, play.endedAt, play.listenedSeconds)
);

/** 周一起算的星期序号：0 = 周一 … 6 = 周日。 */
const weekdayIndexOf = (at: number): number => (new Date(at).getDay() + 6) % 7;

const hourIndexOf = (at: number): number => new Date(at).getHours();

const artistsLabel = (artists: string[]): string => artists
    .map(name => name.trim())
    .filter(name => name !== '')
    .join(ARTIST_SEPARATOR);

/**
 * 排行榜：歌曲按 songKey、歌手按归一歌手名（合唱各计一次）、专辑按归一专辑名（取不到不参与）分组。
 * `plays` 只累加 counted 的行，`seconds` 累加实测秒数，`firstHeardAt` 取该组最早开始时刻。
 */
export const rankEntries = (
    plays: ArchivePlay[],
    kind: ArchiveRankKind,
    sort: ArchiveRankSort,
    query?: string,
): ArchiveRankEntry[] => {
    const groups = new Map<string, ArchiveRankEntry>();
    /** 每组最近一次播放的时刻与封面时刻，用来决定显示哪个歌名、取哪张封面。 */
    const latestAt = new Map<string, number>();
    const latestCoverAt = new Map<string, number>();

    const touch = (key: string, title: string, subtitle: string, play: ArchivePlay): ArchiveRankEntry => {
        let entry = groups.get(key);
        if (!entry) {
            entry = {
                key,
                title,
                subtitle,
                coverUrl: null,
                plays: 0,
                seconds: 0,
                firstHeardAt: play.startedAt,
            };
            groups.set(key, entry);
            latestAt.set(key, Number.NEGATIVE_INFINITY);
            latestCoverAt.set(key, Number.NEGATIVE_INFINITY);
        }
        if (play.counted) entry.plays += 1;
        entry.seconds += play.listenedSeconds;
        if (play.startedAt < entry.firstHeardAt) entry.firstHeardAt = play.startedAt;
        // 歌名 / 专辑名保留来源原始写法：取这一组最近一次播放的那份。
        if (play.startedAt >= (latestAt.get(key) ?? Number.NEGATIVE_INFINITY)) {
            latestAt.set(key, play.startedAt);
            entry.title = title;
            entry.subtitle = subtitle;
        }
        // 封面取最近一次非空的那张，后面没有封面的播放不会把它清空。
        if (play.coverUrl && play.startedAt >= (latestCoverAt.get(key) ?? Number.NEGATIVE_INFINITY)) {
            latestCoverAt.set(key, play.startedAt);
            entry.coverUrl = play.coverUrl;
        }
        return entry;
    };

    plays.forEach(play => {
        if (kind === 'song') {
            touch(play.songKey, play.title, artistsLabel(play.artists), play);
            return;
        }
        if (kind === 'album') {
            const albumKey = normalizeAlbumName(play.albumName);
            if (albumKey === null) return;
            // 专辑名保留原始写法，分组键用归一后的。
            touch(albumKey, (play.albumName ?? '').trim(), artistsLabel(play.artists), play);
            return;
        }
        // 歌手视角：合唱歌手各计一次，同一次播放里重复的歌手只算一次。
        const seen = new Set<string>();
        play.artists.forEach(rawName => {
            const artistKey = normalizeArtistName(rawName);
            if (artistKey === '' || seen.has(artistKey)) return;
            seen.add(artistKey);
            touch(artistKey, rawName.trim(), '', play);
        });
    });

    const needle = (query ?? '').trim().toLowerCase();
    const entries = Array.from(groups.values()).filter(entry => needle === ''
        || entry.title.toLowerCase().includes(needle)
        || entry.subtitle.toLowerCase().includes(needle));

    const compare = (a: ArchiveRankEntry, b: ArchiveRankEntry): number => {
        if (sort === 'plays' && b.plays !== a.plays) return b.plays - a.plays;
        if (sort === 'seconds' && b.seconds !== a.seconds) return b.seconds - a.seconds;
        if (sort === 'newest' && b.firstHeardAt !== a.firstHeardAt) return b.firstHeardAt - a.firstHeardAt;
        if (b.seconds !== a.seconds) return b.seconds - a.seconds;
        if (a.title !== b.title) return a.title < b.title ? -1 : 1;
        // 同标题不同分组（比如同名不同歌手）时用分组键定序，排行顺序才是定的。
        if (a.key !== b.key) return a.key < b.key ? -1 : 1;
        return 0;
    };

    return entries.sort(compare).map(entry => ({
        key: entry.key,
        title: entry.title,
        subtitle: entry.subtitle,
        coverUrl: entry.coverUrl,
        plays: entry.plays,
        seconds: entry.seconds,
        firstHeardAt: entry.firstHeardAt,
    }));
};

/**
 * 时间轴：桶由 `bucketRange` 铺满（含空桶）。
 * 秒数按日段落到所属桶；次数按「一次有效播放归入这次播放的开始时刻」计入，且只算 counted 的行。
 */
export const timelineBuckets = (
    plays: ArchivePlay[],
    granularity: ArchiveGranularity,
    from: number,
    to: number,
): ArchiveBucket[] => {
    const buckets: ArchiveBucket[] = bucketRange(from, to, granularity)
        .map(bucket => ({ key: bucket.key, start: bucket.start, seconds: 0, plays: 0 }));
    const byKey = new Map(buckets.map(bucket => [bucket.key, bucket]));

    plays.forEach(play => {
        if (play.counted) {
            const bucket = byKey.get(bucketKeyOf(play.startedAt, granularity));
            if (bucket) bucket.plays += 1;
        }
        segmentsOf(play).forEach(segment => {
            // 落在范围外的日段自然找不到桶，直接丢掉。
            const bucket = byKey.get(bucketKeyOf(segment.startedAt, granularity));
            if (bucket) bucket.seconds += segment.seconds;
        });
    });

    return buckets;
};

/** 7×24 全铺的声浪热力格；每个日段的秒数归到该段起点所在的星期与小时。 */
export const heatCells = (plays: ArchivePlay[], from: number, to: number): ArchiveHeatCell[] => {
    const cells: ArchiveHeatCell[] = [];
    for (let weekday = 0; weekday < 7; weekday += 1) {
        for (let hour = 0; hour < 24; hour += 1) cells.push({ weekday, hour, seconds: 0 });
    }

    plays.forEach(play => {
        segmentsOf(play).forEach(segment => {
            if (segment.startedAt < from || segment.startedAt > to) return;
            cells[weekdayIndexOf(segment.startedAt) * 24 + hourIndexOf(segment.startedAt)].seconds += segment.seconds;
        });
    });

    return cells;
};

/**
 * 最近 24 个月里这一首的月度排名。排名是在**所有歌曲**之间按当月秒数排出来的，
 * 所以这里收全部播放行，而不只是这一首的；并列时按 songKey 定序，名次各占一位。
 */
const monthlyRanks = (plays: ArchivePlay[], songKey: string, now: number): ArchiveMonthlyRank[] => {
    const months: string[] = [];
    const nowDate = new Date(now);
    for (let back = MONTHLY_RANK_MONTHS - 1; back >= 0; back -= 1) {
        const monthStart = new Date(nowDate.getFullYear(), nowDate.getMonth() - back, 1);
        months.push(bucketKeyOf(monthStart.getTime(), 'month'));
    }
    const monthSet = new Set(months);
    const secondsByMonth = new Map<string, Map<string, number>>();
    const playsByMonth = new Map<string, Map<string, number>>();

    const accumulate = (target: Map<string, Map<string, number>>, month: string, key: string, value: number) => {
        let bucket = target.get(month);
        if (!bucket) {
            bucket = new Map<string, number>();
            target.set(month, bucket);
        }
        bucket.set(key, (bucket.get(key) ?? 0) + value);
    };

    plays.forEach(play => {
        if (play.counted) {
            const month = bucketKeyOf(play.startedAt, 'month');
            if (monthSet.has(month)) accumulate(playsByMonth, month, play.songKey, 1);
        }
        segmentsOf(play).forEach(segment => {
            const month = bucketKeyOf(segment.startedAt, 'month');
            if (monthSet.has(month)) accumulate(secondsByMonth, month, play.songKey, segment.seconds);
        });
    });

    return months.map(month => {
        const seconds = secondsByMonth.get(month)?.get(songKey) ?? 0;
        const plays = playsByMonth.get(month)?.get(songKey) ?? 0;
        if (seconds <= 0) return { month, rank: null, plays, seconds };
        const ordered = Array.from(secondsByMonth.get(month)?.entries() ?? [])
            .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        const position = ordered.findIndex(([key]) => key === songKey);
        return { month, rank: position < 0 ? null : position + 1, plays, seconds };
    });
};

/** 单曲轨迹：累计次数与时长、最近 24 个月排名、星期与小时分布、按日期的时间轴。没听过返回 null。 */
export const songTrajectory = (plays: ArchivePlay[], songKey: string, now: number): ArchiveSongTrajectory | null => {
    const own = plays.filter(play => play.songKey === songKey);
    if (own.length === 0) return null;

    const weekdaySeconds = new Array<number>(7).fill(0);
    const hourlySeconds = new Array<number>(24).fill(0);
    const daySeconds = new Map<string, number>();
    const dayPlays = new Map<string, number>();
    let totalPlays = 0;
    let totalSeconds = 0;
    let firstHeardAt = Number.POSITIVE_INFINITY;
    let lastHeardAt = Number.NEGATIVE_INFINITY;

    own.forEach(play => {
        totalSeconds += play.listenedSeconds;
        firstHeardAt = Math.min(firstHeardAt, play.startedAt);
        lastHeardAt = Math.max(lastHeardAt, play.startedAt);
        if (play.counted) {
            totalPlays += 1;
            const day = localDayKey(play.startedAt);
            dayPlays.set(day, (dayPlays.get(day) ?? 0) + 1);
        }
        segmentsOf(play).forEach(segment => {
            weekdaySeconds[weekdayIndexOf(segment.startedAt)] += segment.seconds;
            hourlySeconds[hourIndexOf(segment.startedAt)] += segment.seconds;
            daySeconds.set(segment.day, (daySeconds.get(segment.day) ?? 0) + segment.seconds);
        });
    });

    // 标题、歌手、专辑取最近一次播放的那份；封面取最近一次非空的。
    const latest = own.reduce((acc, play) => (play.startedAt >= acc.startedAt ? play : acc), own[0]);
    const latestCover = own
        .filter(play => Boolean(play.coverUrl))
        .reduce<ArchivePlay | null>((acc, play) => (acc === null || play.startedAt >= acc.startedAt ? play : acc), null);

    const days: ArchiveDayEntry[] = Array.from(new Set([...daySeconds.keys(), ...dayPlays.keys()]))
        .sort()
        .map(day => ({
            day,
            plays: dayPlays.get(day) ?? 0,
            seconds: daySeconds.get(day) ?? 0,
        }));

    return {
        songKey,
        title: latest.title,
        artists: latest.artists,
        albumName: latest.albumName,
        coverUrl: latestCover?.coverUrl ?? null,
        plays: totalPlays,
        seconds: totalSeconds,
        firstHeardAt,
        lastHeardAt,
        monthly: monthlyRanks(plays, songKey, now),
        weekdaySeconds,
        hourlySeconds,
        days,
    };
};

/** 总计：计次只算 counted 的行；秒数是实测总时长；歌曲数按 songKey 去重（听过没计次的也算听过）。 */
export const totals = (plays: ArchivePlay[]): { plays: number; seconds: number; songs: number } => {
    const songs = new Set<string>();
    let playsCount = 0;
    let seconds = 0;
    plays.forEach(play => {
        if (play.counted) playsCount += 1;
        seconds += play.listenedSeconds;
        songs.add(play.songKey);
    });
    return { plays: playsCount, seconds, songs: songs.size };
};
