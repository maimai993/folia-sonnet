import { appDatabase } from '../appDatabase';
import { countsAsCompleted, countsAsPlay, splitSegments } from './rules';
import type { ArchiveBackupFile, ArchiveImportResult, ArchivePlay, ArchiveSegment } from './types';

// src/services/listeningArchive/repository.ts
// 听歌档案的存取：增长型播放行只往 listeningArchivePlays 表里加，备份导出与导入合并也在这里。

const ARCHIVE_BACKUP_FORMAT = 'folia-listening-archive';
const ARCHIVE_BACKUP_VERSION = 1;

const playsTable = () => appDatabase.listeningArchivePlays;

/** 存一行播放记录；同一个 id 再存一次是覆盖，不是新增。 */
export const saveArchivePlay = async (play: ArchivePlay): Promise<void> => {
    await playsTable().put(play);
};

/** 批量存；一次播放只写一次，所以批量路径主要给导入和补写用。 */
export const saveArchivePlays = async (plays: ArchivePlay[]): Promise<void> => {
    if (plays.length === 0) return;
    await playsTable().bulkPut(plays);
};

/**
 * 读播放记录，按 startedAt 过滤（走索引，过滤在库里做）。
 * 按开始时刻升序返回：聚合函数与界面都按时间顺序消费，省得各自再排一次。
 */
export const loadArchivePlays = async (range?: { from: number; to: number }): Promise<ArchivePlay[]> => {
    const table = playsTable();
    const rows = range
        ? await table.where('startedAt').between(range.from, range.to, true, true).toArray()
        : await table.toArray();
    return rows.sort((a, b) => (a.startedAt - b.startedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
};

export const countArchivePlays = async (): Promise<number> => await playsTable().count();

/** 清空档案：只清播放行，不动设置和别的表。 */
export const clearArchive = async (): Promise<void> => {
    await playsTable().clear();
};

/** 导出全部原始播放记录，导入端按 id 合并，重复导入不会让次数翻倍。 */
export const exportArchiveBackup = async (): Promise<ArchiveBackupFile> => ({
    format: ARCHIVE_BACKUP_FORMAT,
    version: ARCHIVE_BACKUP_VERSION,
    exportedAt: Date.now(),
    plays: await loadArchivePlays(),
});

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

const readString = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

const readFiniteNumber = (value: unknown, fallback: number): number => (
    typeof value === 'number' && Number.isFinite(value) ? value : fallback
);

const readNullableString = (value: unknown): string | null => (
    typeof value === 'string' && value.trim() !== '' ? value : null
);

const readStringList = (value: unknown): string[] => (
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
);

/** 校验备份信封；格式或版本不对时抛出，由导入入口接住并记日志。 */
const readBackupRows = (file: unknown): unknown[] => {
    if (!isRecord(file)) throw new TypeError('备份文件不是 JSON 对象');
    if (file.format !== ARCHIVE_BACKUP_FORMAT) throw new TypeError(`备份 format 不认识：${String(file.format)}`);
    if (file.version !== ARCHIVE_BACKUP_VERSION) throw new TypeError(`备份 version 不支持：${String(file.version)}`);
    if (!Array.isArray(file.plays)) throw new TypeError('备份缺少 plays 数组');
    return file.plays;
};

const readSegments = (value: unknown): ArchiveSegment[] => {
    if (!Array.isArray(value)) return [];
    return value.flatMap(item => {
        if (!isRecord(item)) return [];
        const day = readString(item.day);
        const startedAt = readFiniteNumber(item.startedAt, Number.NaN);
        if (day === '' || !Number.isFinite(startedAt)) return [];
        return [{ day, seconds: Math.max(readFiniteNumber(item.seconds, 0), 0), startedAt }];
    });
};

/** 校验并补齐一行记录；没有 id 或开始时刻的行算坏行，返回 null。 */
const parseArchivePlay = (row: unknown): ArchivePlay | null => {
    if (!isRecord(row)) return null;
    const id = readString(row.id).trim();
    const startedAt = readFiniteNumber(row.startedAt, Number.NaN);
    if (id === '' || !Number.isFinite(startedAt)) return null;

    const endedAt = Math.max(readFiniteNumber(row.endedAt, startedAt), startedAt);
    const listenedSeconds = Math.max(readFiniteNumber(row.listenedSeconds, 0), 0);
    const totalSeconds = Math.max(readFiniteNumber(row.totalSeconds, 0), 0);
    const storedSegments = readSegments(row.segments);

    return {
        id,
        songKey: readString(row.songKey),
        songId: readString(row.songId),
        providerId: readString(row.providerId),
        title: readString(row.title),
        artists: readStringList(row.artists),
        albumName: readNullableString(row.albumName),
        coverUrl: readNullableString(row.coverUrl),
        startedAt,
        endedAt,
        listenedSeconds,
        totalSeconds,
        // 行上已有的判定照用：当时的口径解释了那一刻的历史；缺的时候按现在的口径补。
        counted: typeof row.counted === 'boolean' ? row.counted : countsAsPlay(listenedSeconds, totalSeconds),
        completed: typeof row.completed === 'boolean' ? row.completed : countsAsCompleted(listenedSeconds, totalSeconds),
        segments: storedSegments.length > 0 ? storedSegments : splitSegments(startedAt, endedAt, listenedSeconds),
    };
};

/**
 * 导入备份：只补本机没有的记录 id，重复导入不增加次数；坏行与重复行计入 skipped。
 * 任何异常都只记日志并返回零新增，不抛给界面。
 */
export const importArchiveBackup = async (file: unknown): Promise<ArchiveImportResult> => {
    try {
        const rows = readBackupRows(file);
        const knownIds = new Set((await playsTable().toCollection().primaryKeys()).map(String));
        const accepted: ArchivePlay[] = [];
        let skipped = 0;

        rows.forEach(row => {
            const play = parseArchivePlay(row);
            if (!play || knownIds.has(play.id)) {
                skipped += 1;
                return;
            }
            knownIds.add(play.id);
            accepted.push(play);
        });

        if (accepted.length === 0) return { added: 0, skipped };
        await saveArchivePlays(accepted);
        return { added: accepted.length, skipped };
    } catch (error) {
        console.warn('[listeningArchive] 导入备份失败，本机记录保持原样', error);
        return { added: 0, skipped: 0 };
    }
};
