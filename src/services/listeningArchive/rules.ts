import type { ArchiveGranularity, ArchiveSegment } from './types';

// src/services/listeningArchive/rules.ts
// 听歌档案的口径纯函数：计次阈值、设备本地时间分桶（周一起算）、歌曲 / 歌手 / 专辑归一化，以及跨午夜的时长拆分。

/** 一次播放至少听满这么多秒才计一次；曲目比 60 秒还短时按一半算，见 requiredSecondsForCount。 */
export const MIN_COUNTED_SECONDS = 30;

/** 听满曲目时长的这个比例按「听完整首」记。 */
export const COMPLETED_RATIO = 0.9;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 折线图一年最多 366 个日桶；这个上限只是防死循环的护栏（日粒度约 54 年）。 */
const MAX_BUCKETS = 20000;

/** 歌曲键里歌名与歌手集合之间的分隔符，用不会出现在歌名里的控制字符。 */
const KEY_SEPARATOR = '\u0001';

/** 同一首歌多个歌手之间的分隔符。 */
const ARTIST_SEPARATOR = ',';

const WHITESPACE = /\s+/g;

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** 归一化文本：去首尾空格、连续空白折叠成一个空格、转小写。 */
const normalizeText = (value: string): string => value.trim().replace(WHITESPACE, ' ').toLowerCase();

/** `YYYY-MM-DD`，设备本地日；不用 UTC，跨午夜拆分与「按天看」都跟设备时钟走。 */
export const localDayKey = (at: number): string => {
    const date = new Date(at);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
};

/** 那一刻所在周的周一本地零点（毫秒）：一周从周一开始，周日是这一周的最后一天。 */
export const weekStart = (at: number): number => {
    const date = new Date(at);
    date.setHours(0, 0, 0, 0);
    // getDay() 里 0 是周日，挪成 0 是周一。
    date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    return date.getTime();
};

/** 本地年月日换成的「日序号」，用 UTC 算，避开夏令时里一天不是 86400000 毫秒。 */
const dayNumberOf = (year: number, month: number, day: number): number => (
    Math.floor(Date.UTC(year, month, day) / DAY_MS)
);

/** 周一起算的星期序号：0 = 周一 … 6 = 周日（1970-01-01 是周四，日序号 + 3 正好落在周一为 0 的轴上）。 */
const mondayIndex = (dayNumber: number): number => ((dayNumber + 3) % 7 + 7) % 7;

/**
 * ISO 周号：含该年第一个周四的那一周算第 1 周，跨年的那几天归入周四所在的那一年。
 * 例：2021-01-01 是 2020-W53，2024-12-30 是 2025-W01。
 */
const isoWeekOf = (at: number): { year: number; week: number } => {
    const date = new Date(at);
    const dayNumber = dayNumberOf(date.getFullYear(), date.getMonth(), date.getDate());
    const thursday = dayNumber - mondayIndex(dayNumber) + 3;
    const isoYear = new Date(thursday * DAY_MS).getUTCFullYear();
    const jan4 = dayNumberOf(isoYear, 0, 4);
    const weekOneThursday = jan4 - mondayIndex(jan4) + 3;
    return { year: isoYear, week: (thursday - weekOneThursday) / 7 + 1 };
};

/** 桶键：day=`YYYY-MM-DD`、week=`YYYY-Www`（ISO 周号）、month=`YYYY-MM`、year=`YYYY`。 */
export const bucketKeyOf = (at: number, granularity: ArchiveGranularity): string => {
    if (granularity === 'day') return localDayKey(at);
    if (granularity === 'week') {
        const { year, week } = isoWeekOf(at);
        return `${year}-W${pad2(week)}`;
    }
    if (granularity === 'month') {
        const date = new Date(at);
        return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
    }
    return String(new Date(at).getFullYear());
};

/** 那一刻所在桶的起点（本地时间毫秒）。 */
export const bucketStart = (at: number, granularity: ArchiveGranularity): number => {
    if (granularity === 'day') {
        const date = new Date(at);
        date.setHours(0, 0, 0, 0);
        return date.getTime();
    }
    if (granularity === 'week') return weekStart(at);
    const date = new Date(at);
    if (granularity === 'month') return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
    return new Date(date.getFullYear(), 0, 1).getTime();
};

/** 下一个桶的起点：按本地日历进位（不用加 30 天这种近似），跨夏令时也落在本地零点上。 */
const nextBucketStart = (start: number, granularity: ArchiveGranularity): number => {
    const date = new Date(start);
    if (granularity === 'day') date.setDate(date.getDate() + 1);
    else if (granularity === 'week') date.setDate(date.getDate() + 7);
    else if (granularity === 'month') date.setMonth(date.getMonth() + 1);
    else date.setFullYear(date.getFullYear() + 1);
    return date.getTime();
};

/**
 * 从 from 所在的桶铺到 to 所在的桶（含两端）。没有记录的桶也在这里出现，
 * 折线图可以直接按数组画，不用自己补空洞。
 */
export const bucketRange = (from: number, to: number, granularity: ArchiveGranularity): Array<{ key: string; start: number }> => {
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return [];
    const buckets: Array<{ key: string; start: number }> = [];
    const lastStart = bucketStart(to, granularity);
    let start = bucketStart(from, granularity);
    while (start <= lastStart && buckets.length < MAX_BUCKETS) {
        buckets.push({ key: bucketKeyOf(start, granularity), start });
        start = nextBucketStart(start, granularity);
    }
    return buckets;
};

/** 歌手名归一化：去首尾空格、折叠空白、转小写。 */
export const normalizeArtistName = (name: string): string => normalizeText(name);

/** 专辑名归一化；没有专辑、或者归一后是空串都返回 null（不参与专辑排行）。 */
export const normalizeAlbumName = (name: string | null): string | null => {
    if (typeof name !== 'string') return null;
    const normalized = normalizeText(name);
    return normalized === '' ? null : normalized;
};

/**
 * 歌曲键 = 归一歌名 + 排序去重后的归一歌手集合，形如 `歌名\u0001歌手A,歌手B`。
 * 忽略大小写、多余空格与歌手顺序；排序按 UTF-16 码元，跨设备结果一致。
 */
export const normalizeSongKey = (input: { title: string; artists: string[] }): string => {
    const title = normalizeText(input.title);
    const artists = Array.from(new Set(
        input.artists.map(normalizeArtistName).filter(name => name !== ''),
    )).sort();
    return `${title}${KEY_SEPARATOR}${artists.join(ARTIST_SEPARATOR)}`;
};

/**
 * 计一次需要的秒数：`min(30, 曲目时长 / 2)`。
 * 时长未知（0 或负数）时按 30 秒门槛，不按「一半」推算出 0 秒。
 */
export const requiredSecondsForCount = (totalSeconds: number): number => {
    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return MIN_COUNTED_SECONDS;
    return Math.min(MIN_COUNTED_SECONDS, totalSeconds / 2);
};

/** 够不够算「听了一次」：只认采集侧实测的秒数，暂停、拖动、回退都不在 listenedSeconds 里。 */
export const countsAsPlay = (listenedSeconds: number, totalSeconds: number): boolean => (
    Number.isFinite(listenedSeconds) && listenedSeconds >= requiredSecondsForCount(totalSeconds)
);

/** 够不够算「听完整首」：达到曲目时长的 90%；时长未知一律不算（不推算整首）。 */
export const countsAsCompleted = (listenedSeconds: number, totalSeconds: number): boolean => {
    if (!Number.isFinite(listenedSeconds) || !Number.isFinite(totalSeconds) || totalSeconds <= 0) return false;
    // 加一点点容差，免得 0.9 * 时长 的浮点误差把刚好听满 90% 判成没听满。
    return listenedSeconds + 1e-9 >= totalSeconds * COMPLETED_RATIO;
};

/** 那一刻之后最近的本地零点。 */
const nextLocalMidnight = (at: number): number => {
    const date = new Date(at);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + 1);
    return date.getTime();
};

/**
 * 把一次播放按本地午夜切成日段，秒数按各段的时长占比分配；
 * 跨了 n 天就出 n 段，末段吸收舍入误差，保证各段之和恒等于 listenedSeconds。
 */
export const splitSegments = (startedAt: number, endedAt: number, listenedSeconds: number): ArchiveSegment[] => {
    const safeStart = Number.isFinite(startedAt) ? startedAt : 0;
    const safeEnd = Number.isFinite(endedAt) ? Math.max(endedAt, safeStart) : safeStart;
    const total = Number.isFinite(listenedSeconds) && listenedSeconds > 0 ? listenedSeconds : 0;

    const pieces: Array<{ day: string; startedAt: number; endedAt: number }> = [];
    let cursor = safeStart;
    while (cursor < safeEnd) {
        const pieceEnd = Math.min(nextLocalMidnight(cursor), safeEnd);
        pieces.push({ day: localDayKey(cursor), startedAt: cursor, endedAt: pieceEnd });
        cursor = pieceEnd;
    }
    // 开始与结束在同一刻（或数据倒挂）时也要有一行，界面不至于显示成「没有记录」。
    if (pieces.length === 0) pieces.push({ day: localDayKey(safeStart), startedAt: safeStart, endedAt: safeEnd });

    const span = safeEnd - safeStart;
    let assigned = 0;
    return pieces.map((piece, index) => {
        const isLast = index === pieces.length - 1;
        // 前面各段向下取整，末段补差：既保证总和等于 total，也不会出现负数。
        const seconds = isLast
            ? total - assigned
            : span > 0 ? Math.floor((total * (piece.endedAt - piece.startedAt)) / span) : 0;
        assigned += seconds;
        return { day: piece.day, seconds, startedAt: piece.startedAt };
    });
};
