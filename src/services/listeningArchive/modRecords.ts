import { countsAsCompleted, countsAsPlay, normalizeSongKey, splitSegments } from './rules';
import type { ArchivePlay } from './types';
import type { ModRecord, ModSegment, ModSong } from './modAnalytics';

// src/services/listeningArchive/modRecords.ts
// 「听歌档案」模组的记录与本机归档行之间的换算。
//
// 本机的库只有一种行（ArchivePlay，按设备本地日拆段），模组那边是它自己的形状（一次播放带一串
// 带时区的收听段）。历史是这个应用的（原生采集器写的），界面是模组的，所以换算只做读取方向为主：
//   - toModRecord：一行本机记录 → 模组的一次播放。段按分日段还原墙钟区间，秒数照抄，时区偏移取那一刻的。
//     这样模组的热力图 / 时间桶拿到的是真实的星期与小时，不会被压到零点。
//   - toArchivePlay：模组备份里的一行 → 本机记录（导入用）。
// 模组自己的采样不会写库：写入只有原生采集器一处（archiveRpc 里说明了原因）。

/** 本机一行 → 模组的一次播放。 */
export const toModRecord = (play: ArchivePlay): ModRecord => {
    // 时刻坏掉的行（写到一半、外部写坏）退回 0，宁可把它排到最后也不要整页算出 NaN 时间。
    const startedAt = Number.isFinite(play.startedAt) ? play.startedAt : 0;
    const endedAt = Number.isFinite(play.endedAt) ? Math.max(play.endedAt, startedAt) : startedAt;
    const song: ModSong = {
        id: play.songId === '' ? null : play.songId,
        title: play.title,
        artist: play.artists.join(' / '),
        album: play.albumName,
        source: play.providerId === '' ? null : play.providerId,
    };
    const segments = toModSegments({ ...play, startedAt, endedAt });
    return {
        id: play.id,
        revision: 1,
        closed: true,
        startedAt,
        endedAt,
        duration: play.totalSeconds,
        song,
        segments,
    };
};

/**
 * 分日段 → 模组的收听段：每一段的墙钟区间从它自己的起点到下一段的起点（最后一段到结束），
 * 秒数据实照抄；时区偏移按那一刻取，跨夏令时也还是本地钟点。
 */
const toModSegments = (play: ArchivePlay): ModSegment[] => {
    if (play.segments.length === 0) {
        const end = Math.max(play.endedAt, play.startedAt + 1);
        return [{
            start: play.startedAt,
            end,
            seconds: Math.max(play.listenedSeconds, 0),
            offset: new Date(play.startedAt).getTimezoneOffset(),
        }];
    }
    return play.segments.map((segment, index) => {
        const next = play.segments[index + 1];
        // 段起点缺失或坏掉（老行、外部写坏的行）时退回整条记录的起点：一行坏数据不该把整页算成 NaN 时间。
        const start = Number.isFinite(segment.startedAt) ? segment.startedAt : play.startedAt;
        const nextStart = next && Number.isFinite(next.startedAt) ? next.startedAt : play.endedAt;
        // 起点相同（同一刻两段）或末段没有结束时刻时，给一个非零的区间，免得除法出 Infinity。
        const end = Math.max(nextStart, start + 1);
        return {
            start,
            end,
            seconds: Math.max(segment.seconds, 0),
            offset: new Date(start).getTimezoneOffset(),
        };
    });
};

const readString = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback);

const readNumber = (value: unknown, fallback: number): number => (
    typeof value === 'number' && Number.isFinite(value) ? value : fallback
);

const readNullableString = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

const isObject = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

/**
 * 模组备份里的一行 → 本机记录。缺 id 或开始时刻的行算坏行，返回 null；
 * 段按本机口径重算（splitSegments），不从备份里照抄：一段的区间与秒数必须自洽。
 */
export const toArchivePlay = (row: unknown): ArchivePlay | null => {
    if (!isObject(row)) return null;
    const id = readString(row.id, '').trim();
    const startedAt = readNumber(row.startedAt, Number.NaN);
    if (id === '' || !Number.isFinite(startedAt)) return null;
    const song = isObject(row.song) ? row.song : {};
    const title = readString(song.title, '').trim();
    if (title === '') return null;
    const artists = readString(song.artist, '')
        .split(' / ')
        .map(name => name.trim())
        .filter(name => name !== '');
    const endedAt = Math.max(readNumber(row.endedAt, startedAt), startedAt);
    const segments = Array.isArray(row.segments) ? row.segments : [];
    const listenedSeconds = segments.reduce<number>((sum, segment) => (
        isObject(segment) ? sum + Math.max(readNumber(segment.seconds, 0), 0) : sum
    ), 0);
    const totalSeconds = Math.max(readNumber(row.duration, 0), 0);
    return {
        id,
        songKey: normalizeSongKey({ title, artists }),
        songId: readString(song.id, ''),
        providerId: readString(song.source, ''),
        title,
        artists,
        albumName: readNullableString(song.album),
        coverUrl: null,
        startedAt,
        endedAt,
        listenedSeconds,
        totalSeconds,
        counted: countsAsPlay(listenedSeconds, totalSeconds),
        completed: countsAsCompleted(listenedSeconds, totalSeconds),
        segments: splitSegments(startedAt, endedAt, listenedSeconds),
    };
};
