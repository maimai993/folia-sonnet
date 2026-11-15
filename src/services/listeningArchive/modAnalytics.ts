// src/services/listeningArchive/modAnalytics.ts
// 「听歌档案」模组那套聚合的移植。模组的界面（public/mods/builtin/listening-archive/client.mjs）
// 并不自己算数：它把范围交给主进程的 analytics.cjs（一个 worker），拿回现成的排行、时间桶、热力与轨迹。
// 安卓没有主进程，于是这一份是那个 worker 的算法逐条搬过来的渲染进程版本，函数名、口径、返回字段
// 都与源一致（源文件：D:\folia\mod\listening-archive\analytics.cjs），差别只有两处：
//   - 记录来自本机的播放归档表（ArchivePlay），由 adapter 换成模组的记录形状；
//   - 不做 worker 那边 12 条的参数缓存，读一次算一次（模组界面只在换范围 / 点刷新时问）。
// 改这里之前先看那个文件：口径（30 秒计一次、90% 算听完、周一起算、跨午夜按比例拆）是档案的历史，
// 不能只按「看起来更合理」调。

/** 模组记录的歌曲部分。`artist` 是「 / 」连起来的一串，与模组给 host 的 DTO 一致。 */
export interface ModSong {
    id: string | null;
    title: string;
    artist: string;
    album: string | null;
    source: string | null;
}

/** 一段收听：`start`–`end` 是墙钟区间，`seconds` 是其中真的听了多久，`offset` 是当时的时区偏移（分钟）。 */
export interface ModSegment {
    start: number;
    end: number;
    seconds: number;
    offset: number;
}

/** 一次播放，模组视⻆的那一行。 */
export interface ModRecord {
    id: string;
    revision: number;
    closed: boolean;
    startedAt: number;
    endedAt: number;
    duration: number;
    song: ModSong;
    segments: ModSegment[];
}

export type ModPeriod = 'day' | 'week' | 'month' | 'year';

/** 排行里的一个分组。 */
export interface ModRankRow {
    key: string;
    name: string;
    subtitle: string;
    plays: number;
    seconds: number;
    songKeys: string[];
    share: number;
}

/** 汇总数字。 */
export interface ModSummary {
    seconds: number;
    plays: number;
    songs: number;
    artists: number;
    albums: number;
    newSongs: number;
    newShare: number;
    topShare: number;
}

/** 时间轴上的一个桶。 */
export interface ModBucket {
    key: string;
    label: string;
    start: number;
    end: number;
    seconds: number;
    plays: number;
    songs: number;
}

export interface ModFilter {
    weekday?: number;
    hour?: number;
    songKey?: string;
    albumKey?: string;
    artistKey?: string;
}

/** 模组问 `archive.query` / `archive.records` 时的范围。 */
export interface ModRange {
    period: ModPeriod;
    start: number;
    end: number;
    filter?: ModFilter;
}

export interface ModRecordQuery extends ModRange {
    offset?: number;
    limit?: number;
}

/** `archive.query` 的整份回话。 */
export interface ModQueryResult {
    revision: number;
    summary: ModSummary;
    buckets: ModBucket[];
    heat: ModBucket[];
    habits: number[];
    songs: ModRankRow[];
    artists: ModRankRow[];
    albums: ModRankRow[];
    firstRecorded: number | null;
    recordCount: number;
}

/** `archive.records` 的一行。 */
export interface ModRecordRow {
    id: string;
    song: ModSong;
    songKey: string;
    startedAt: number;
    seconds: number;
    actual: number;
    counted: boolean;
    completed: boolean;
    closed: boolean;
}

export interface ModRecordPage {
    items: ModRecordRow[];
    total: number;
    offset: number;
}

/** `archive.trajectory` 的回话：一首歌从第一次听到现在。 */
export interface ModTrajectory {
    first: number | null;
    last: number | null;
    summary: ModSummary;
    ranks: Array<{ label: string; rank: number | null }>;
    habits: number[];
}

const UNKNOWN_ALBUM = '未知专辑';
const UNKNOWN_ARTIST = '未知歌手';
const WEEKDAYS = 7;
const HOURS = 24;
const HABIT_CELLS = WEEKDAYS * HOURS;

/** 模组的归一化：NFC、去首尾空白、折叠空白、小写。 */
export const modNormalize = (value: string): string => value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

/** 歌手列表：按「 / 」拆开、去空、按归一后的名字去重（保留第一次出现的写法）。 */
export const modArtists = (song: ModSong): string[] => {
    const seen = new Map<string, string>();
    for (const part of song.artist.split(' / ')) {
        const name = part.trim();
        if (!name) continue;
        const key = modNormalize(name);
        if (!seen.has(key)) seen.set(key, name);
    }
    return [...seen.values()];
};

/** 歌曲键：归一歌名 + 排序后的归一歌手集合，模组里用它分组排行与单曲轨迹。 */
export const modSongKey = (song: ModSong): string => JSON.stringify([
    modNormalize(song.title),
    modArtists(song).map(modNormalize).sort(),
]);

/** 专辑键：归一专辑名 + 第一位歌手。 */
export const modAlbumKey = (song: ModSong): string => JSON.stringify([
    modNormalize(song.album || UNKNOWN_ALBUM),
    modNormalize(modArtists(song)[0] || UNKNOWN_ARTIST),
]);

/** 实际听了多少秒（各段之和）。 */
const actualSeconds = (record: ModRecord): number => record.segments.reduce((sum, segment) => sum + segment.seconds, 0);

/** 听满 90% 算听完整首；时长未知一律不算。 */
const isCompleted = (record: ModRecord): boolean => record.duration > 0 && actualSeconds(record) >= record.duration * 0.9;

/** 听够 30 秒（短歌按一半）算听了一次。 */
const isCounted = (record: ModRecord): boolean => (
    actualSeconds(record) >= (record.duration > 0 ? Math.min(30, record.duration / 2) : 30)
);

/** 计入「听了多久」的秒数：听完的按曲目时长算，没听完的按实际听的时间。 */
const countedSeconds = (record: ModRecord): number => (
    isCompleted(record) ? Math.max(record.duration, actualSeconds(record)) : actualSeconds(record)
);

/** 时刻 → 设备本地日 / 小时 / 周一起算的星期。`offset` 是那一刻的时区偏移（分钟）。 */
const localParts = (at: number, offset: number): { day: string; hour: number; weekday: number } => {
    const local = new Date(at - offset * 60000);
    return {
        day: local.toISOString().slice(0, 10),
        hour: local.getUTCHours(),
        weekday: (local.getUTCDay() + 6) % 7,
    };
};

/** 某个时刻所在的这一段（日 / 周 / 月 / 年）的起止。 */
export const modPeriodRange = (period: ModPeriod, at: number): ModRange => {
    const start = new Date(at);
    start.setHours(0, 0, 0, 0);
    if (period === 'week') start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    if (period === 'month') start.setDate(1);
    if (period === 'year') start.setMonth(0, 1);
    const end = new Date(start);
    if (period === 'day') end.setDate(end.getDate() + 1);
    if (period === 'week') end.setDate(end.getDate() + 7);
    if (period === 'month') end.setMonth(end.getMonth() + 1);
    if (period === 'year') end.setFullYear(end.getFullYear() + 1);
    return { period, start: +start, end: +end };
};

const emptySummary = (): ModSummary => ({
    seconds: 0,
    plays: 0,
    songs: 0,
    artists: 0,
    albums: 0,
    newSongs: 0,
    newShare: 0,
    topShare: 0,
});

const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * 把一段范围铺成桶：按小时（日视图，或周视图的「按天」那一版）、按天（周 / 月）、按月（年）。
 * `perDay` 是模组那边的第二个参数，周视图的桶有两种画法。
 */
const buildBuckets = (range: ModRange, perDay = false): ModBucket[] => {
    const buckets: ModBucket[] = [];
    let cursor = range.start;
    while (cursor < range.end) {
        const from = new Date(cursor);
        const next = new Date(cursor);
        const hourly = range.period === 'day' || (perDay && range.period === 'week');
        if (hourly) next.setHours(next.getHours() + 1);
        else if (range.period === 'year' && !perDay) next.setMonth(next.getMonth() + 1);
        else next.setDate(next.getDate() + 1);
        const end = Math.min(range.end, +next);
        buckets.push({
            key: String(cursor),
            label: hourly
                ? `${pad2(from.getHours())}:00`
                : range.period === 'year' && !perDay
                    ? `${from.getMonth() + 1}月`
                    : `${from.getMonth() + 1}/${from.getDate()}`,
            start: cursor,
            end,
            seconds: 0,
            plays: 0,
            songs: 0,
        });
        cursor = end;
    }
    return buckets;
};

/** 这一行落在这个范围 / 筛选里吗。 */
const matchesFilter = (record: ModRecord, filter: ModFilter | undefined): boolean => {
    const artists = modArtists(record.song);
    return (!filter?.songKey || modSongKey(record.song) === filter.songKey)
        && (!filter?.albumKey || modAlbumKey(record.song) === filter.albumKey)
        && (!filter?.artistKey || (artists.length ? artists : [UNKNOWN_ARTIST]).some(name => modNormalize(name) === filter.artistKey));
};

/** 这一段落在范围内、且过得了星期 / 小时筛选的秒数。 */
const secondsInRange = (record: ModRecord, range: ModRange): number => {
    let seconds = 0;
    for (const segment of record.segments) {
        const from = Math.max(segment.start, range.start);
        const to = Math.min(segment.end, range.end);
        if (to <= from) continue;
        const parts = localParts(segment.start, segment.offset);
        if (range.filter?.weekday !== undefined && range.filter.weekday !== parts.weekday) continue;
        if (range.filter?.hour !== undefined && range.filter.hour !== parts.hour) continue;
        seconds += segment.seconds * (to - from) / (segment.end - segment.start);
    }
    const actual = actualSeconds(record);
    return actual > 0 ? seconds * countedSeconds(record) / actual : 0;
};

/** 这一行算不算「在这个范围里听了一次」。 */
const countedInRange = (record: ModRecord, range: ModRange): boolean => {
    const parts = localParts(record.startedAt, new Date(record.startedAt).getTimezoneOffset());
    return isCounted(record)
        && record.startedAt >= range.start
        && record.startedAt < range.end
        && (range.filter?.weekday === undefined || range.filter.weekday === parts.weekday)
        && (range.filter?.hour === undefined || range.filter.hour === parts.hour);
};

interface Tally {
    key: string;
    name: string;
    subtitle: string;
    plays: number;
    seconds: number;
    songKeys: string[];
    share: number;
}

const tally = (
    rows: Map<string, Tally>,
    key: string,
    name: string,
    subtitle: string,
    seconds: number,
    plays: number,
    songKey: string,
): void => {
    const row = rows.get(key) ?? { key, name, subtitle, plays: 0, seconds: 0, songKeys: [], share: 0 };
    row.seconds += seconds;
    row.plays += plays;
    if (!row.songKeys.includes(songKey)) row.songKeys.push(songKey);
    rows.set(key, row);
};

const ranked = (rows: Map<string, Tally>, totalSeconds: number): ModRankRow[] => (
    [...rows.values()]
        .map(row => ({ ...row, share: totalSeconds ? row.seconds / totalSeconds : 0 }))
        .sort((left, right) => right.plays - left.plays || right.seconds - left.seconds || left.name.localeCompare(right.name))
);

/** 一段范围里每天 / 每小时的分布叠加。 */
const accumulateBuckets = (buckets: ModBucket[], record: ModRecord, range: ModRange): void => {
    for (const bucket of buckets) {
        if (record.endedAt < bucket.start || record.startedAt >= bucket.end) continue;
        const window: ModRange = { ...range, start: bucket.start, end: bucket.end };
        bucket.seconds += secondsInRange(record, window);
        bucket.plays += Number(countedInRange(record, window));
    }
};

/** `archive.query`：一段范围里的汇总、时间桶、热力、排行。 */
export const queryArchive = (records: readonly ModRecord[], range: ModRange, revision = 0): ModQueryResult => {
    const summary = emptySummary();
    const buckets = buildBuckets(range);
    const heat = buildBuckets(range, true);
    const habits: number[] = Array.from({ length: HABIT_CELLS }, () => 0);
    const songs = new Map<string, Tally>();
    const artists = new Map<string, Tally>();
    const albums = new Map<string, Tally>();
    const firstRecorded = new Map<string, number>();

    for (const record of records) {
        if (actualSeconds(record) <= 0) continue;
        const key = modSongKey(record.song);
        firstRecorded.set(key, Math.min(firstRecorded.get(key) ?? Number.POSITIVE_INFINITY, record.startedAt));
    }

    for (const record of records) {
        if (!matchesFilter(record, range.filter) || record.endedAt < range.start || record.startedAt >= range.end) continue;
        const seconds = secondsInRange(record, range);
        const plays = Number(countedInRange(record, range));
        if (seconds <= 0 && !plays) continue;
        const songKey = modSongKey(record.song);
        const artistNames = modArtists(record.song);
        summary.seconds += seconds;
        summary.plays += plays;
        tally(songs, songKey, record.song.title || '未命名歌曲', record.song.artist || UNKNOWN_ARTIST, seconds, plays, songKey);
        for (const name of artistNames.length ? artistNames : [UNKNOWN_ARTIST]) {
            tally(artists, modNormalize(name), name, '', seconds, plays, songKey);
        }
        tally(albums, modAlbumKey(record.song), record.song.album || UNKNOWN_ALBUM, artistNames[0] || UNKNOWN_ARTIST, seconds, plays, songKey);
        accumulateBuckets(buckets, record, range);
        accumulateBuckets(heat, record, range);
        const actual = actualSeconds(record);
        const weight = actual ? countedSeconds(record) / actual : 1;
        for (const segment of record.segments) {
            const from = Math.max(segment.start, range.start);
            const to = Math.min(segment.end, range.end);
            if (to <= from) continue;
            const parts = localParts(segment.start, segment.offset);
            if (range.filter?.weekday !== undefined && range.filter.weekday !== parts.weekday) continue;
            if (range.filter?.hour !== undefined && range.filter.hour !== parts.hour) continue;
            habits[parts.weekday * HOURS + parts.hour] += segment.seconds * (to - from) / (segment.end - segment.start) * weight;
        }
    }

    const songRows = ranked(songs, summary.seconds);
    summary.songs = songs.size;
    summary.artists = artists.size;
    summary.albums = albums.size;
    summary.newSongs = songRows.filter(row => {
        const first = firstRecorded.get(row.key) ?? 0;
        return first >= range.start && (firstRecorded.get(row.key) ?? Number.POSITIVE_INFINITY) < range.end;
    }).length;
    summary.newShare = songRows.length ? summary.newSongs / songRows.length : 0;
    summary.topShare = songRows.reduce((top, row) => Math.max(top, row.share), 0);

    return {
        revision,
        summary,
        buckets,
        heat,
        habits,
        songs: songRows,
        artists: ranked(artists, summary.seconds),
        albums: ranked(albums, summary.seconds),
        firstRecorded: firstRecorded.size ? Math.min(...firstRecorded.values()) : null,
        recordCount: records.length,
    };
};

/** `archive.records`：一段范围里的逐次播放，最近的在前。 */
export const listArchiveRecords = (records: readonly ModRecord[], query: ModRecordQuery): ModRecordPage => {
    const items = records
        .filter(record => matchesFilter(record, query.filter) && secondsInRange(record, query) > 0)
        .sort((left, right) => right.startedAt - left.startedAt)
        .map(record => ({
            id: record.id,
            song: record.song,
            songKey: modSongKey(record.song),
            startedAt: record.startedAt,
            seconds: secondsInRange(record, query),
            actual: actualSeconds(record),
            counted: isCounted(record),
            completed: isCompleted(record),
            closed: record.closed,
        }));
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.min(100, Math.max(1, query.limit ?? 40));
    return { items: items.slice(offset, offset + limit), total: items.length, offset };
};

/** 一首歌在整段时间里的汇总与习惯分布。 */
const songSummary = (
    records: readonly ModRecord[],
    songKey: string,
    firstHeardAt: number | null,
): { summary: ModSummary; habits: number[] } => {
    const rows = records.filter(record => modSongKey(record.song) === songKey);
    const habits: number[] = Array.from({ length: HABIT_CELLS }, () => 0);
    const summary = emptySummary();
    const artistNames = new Set<string>();
    const albumKeys = new Set<string>();
    for (const record of rows) {
        const actual = actualSeconds(record);
        summary.seconds += countedSeconds(record);
        summary.plays += Number(isCounted(record));
        modArtists(record.song).forEach(name => artistNames.add(modNormalize(name)));
        albumKeys.add(modAlbumKey(record.song));
        for (const segment of record.segments) {
            const parts = localParts(segment.start, segment.offset);
            habits[parts.weekday * HOURS + parts.hour] += segment.seconds * (actual ? countedSeconds(record) / actual : 1);
        }
    }
    summary.songs = firstHeardAt === null ? 0 : 1;
    summary.artists = artistNames.size;
    summary.albums = albumKeys.size;
    return { summary, habits };
};

/** `archive.trajectory`：一首歌第一次听到现在，按月给出名次。 */
export const songTrajectory = (records: readonly ModRecord[], songKey: string, period: ModPeriod): ModTrajectory => {
    const rows = records.filter(record => modSongKey(record.song) === songKey && actualSeconds(record) > 0);
    const first = rows.length ? rows.reduce((earliest, record) => Math.min(earliest, record.startedAt), Number.POSITIVE_INFINITY) : null;
    const last = rows.length ? rows.reduce((latest, record) => Math.max(latest, record.endedAt), 0) : null;
    const summary = songSummary(records, songKey, first);
    const ranks: Array<{ label: string; rank: number | null }> = [];
    const windows: ModRange[] = [];
    const now = last || Date.now();
    let cursor = modPeriodRange(period, now);
    // 从最近一段往回铺，铺到第一次听到为止；一次都没有时只给最近这一段。
    for (let index = 0; index < 24 && (first === null ? index === 0 : cursor.end > first); index += 1) {
        windows.unshift(cursor);
        cursor = modPeriodRange(period, cursor.start - 1);
    }
    for (const window of windows) {
        const inWindow = records.filter(record => record.endedAt >= window.start && record.startedAt < window.end);
        const rank = queryArchive(inWindow, window).songs.findIndex(row => row.key === songKey);
        ranks.push({
            label: new Date(window.start).toLocaleDateString('zh-CN', { year: '2-digit', month: 'numeric' }),
            rank: rank < 0 ? null : rank + 1,
        });
    }
    return { first, last, summary: summary.summary, ranks, habits: summary.habits };
};
