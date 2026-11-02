import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appDatabase } from '../../../src/services/appDatabase';
import {
    clearArchive,
    countArchivePlays,
    exportArchiveBackup,
    importArchiveBackup,
    loadArchivePlays,
    saveArchivePlay,
    saveArchivePlays,
} from '../../../src/services/listeningArchive/repository';
import type { ArchivePlay } from '../../../src/services/listeningArchive/types';

// test/unit/listeningArchive/repository.test.ts
// 存取：增长表的写入 / 范围读取 / 清空，以及备份导出与按 id 合并导入（坏行与重复行只跳过不抛）。
// 用 fake-indexeddb 顶掉浏览器自带实现，跑的是真的 Dexie 与真的表结构。

const at = (year: number, month: number, day: number, hour = 0, minute = 0): number => (
    new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
);

const makePlay = (overrides: Partial<ArchivePlay> & { id: string }): ArchivePlay => ({
    songKey: 'song\u0001artist',
    songId: 'song-1',
    providerId: 'local',
    title: 'Song',
    artists: ['Artist'],
    albumName: null,
    coverUrl: null,
    startedAt: at(2024, 3, 5, 10),
    endedAt: at(2024, 3, 5, 11),
    listenedSeconds: 60,
    totalSeconds: 200,
    counted: true,
    completed: false,
    segments: [],
    ...overrides,
});

describe('听歌档案的存取', () => {
    beforeEach(async () => {
        await appDatabase.delete();
        await appDatabase.open();
    });

    afterEach(async () => {
        await appDatabase.delete();
    });

    it('存一行、读回来，表的索引照 schema 建好', async () => {
        const play = makePlay({ id: 'p1' });
        await saveArchivePlay(play);
        expect(await countArchivePlays()).toBe(1);
        expect(await loadArchivePlays()).toEqual([play]);
        expect(appDatabase.listeningArchivePlays.schema.indexes.map(index => index.name))
            .toEqual(expect.arrayContaining(['startedAt', 'songKey', '[startedAt+songKey]']));
    });

    it('同一个 id 再存一次是覆盖，不是新增', async () => {
        await saveArchivePlay(makePlay({ id: 'p1', listenedSeconds: 60 }));
        await saveArchivePlay(makePlay({ id: 'p1', listenedSeconds: 90 }));
        expect(await countArchivePlays()).toBe(1);
        expect((await loadArchivePlays())[0].listenedSeconds).toBe(90);
    });

    it('批量存空数组什么都不做', async () => {
        await saveArchivePlays([]);
        expect(await countArchivePlays()).toBe(0);
    });

    it('按 startedAt 范围过滤，按开始时刻升序返回', async () => {
        await saveArchivePlays([
            makePlay({ id: 'late', startedAt: at(2024, 3, 9, 9) }),
            makePlay({ id: 'early', startedAt: at(2024, 3, 1, 9) }),
            makePlay({ id: 'middle', startedAt: at(2024, 3, 5, 9) }),
        ]);
        expect((await loadArchivePlays()).map(play => play.id)).toEqual(['early', 'middle', 'late']);
        expect((await loadArchivePlays({ from: at(2024, 3, 2), to: at(2024, 3, 8) })).map(play => play.id))
            .toEqual(['middle']);
        // 边界是闭区间。
        expect((await loadArchivePlays({ from: at(2024, 3, 5, 9), to: at(2024, 3, 5, 9) })).map(play => play.id))
            .toEqual(['middle']);
    });

    it('清空只清播放行', async () => {
        await saveArchivePlays([makePlay({ id: 'p1' }), makePlay({ id: 'p2' })]);
        await clearArchive();
        expect(await countArchivePlays()).toBe(0);
        expect(await loadArchivePlays()).toEqual([]);
    });
});

describe('备份导出与导入', () => {
    beforeEach(async () => {
        await appDatabase.delete();
        await appDatabase.open();
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await appDatabase.delete();
    });

    it('导出带上格式标识、版本与导出时刻', async () => {
        await saveArchivePlay(makePlay({ id: 'p1' }));
        const backup = await exportArchiveBackup();
        expect(backup.format).toBe('folia-listening-archive');
        expect(backup.version).toBe(1);
        expect(typeof backup.exportedAt).toBe('number');
        expect(backup.plays.map(play => play.id)).toEqual(['p1']);
    });

    it('导入按 id 合并：本机已有的跳过，重复导入不增加次数', async () => {
        await saveArchivePlay(makePlay({ id: 'p1', listenedSeconds: 60 }));
        const backup = {
            format: 'folia-listening-archive',
            version: 1,
            exportedAt: at(2024, 3, 10),
            plays: [makePlay({ id: 'p1', listenedSeconds: 999 }), makePlay({ id: 'p2' })],
        };
        expect(await importArchiveBackup(backup)).toEqual({ added: 1, skipped: 1 });
        expect(await countArchivePlays()).toBe(2);
        // 已有的那行保持原样，导入不覆盖。
        const stored = await appDatabase.listeningArchivePlays.get('p1');
        expect(stored?.listenedSeconds).toBe(60);
        // 再导一次同样的文件，两端都是跳过。
        expect(await importArchiveBackup(backup)).toEqual({ added: 0, skipped: 2 });
        expect(await countArchivePlays()).toBe(2);
    });

    it('同一个文件里重复的 id 只收一次', async () => {
        const backup = {
            format: 'folia-listening-archive',
            version: 1,
            exportedAt: 0,
            plays: [makePlay({ id: 'dup' }), makePlay({ id: 'dup' })],
        };
        expect(await importArchiveBackup(backup)).toEqual({ added: 1, skipped: 1 });
        expect(await countArchivePlays()).toBe(1);
    });

    it('坏行跳过并计数，缺字段的按现在的口径补齐', async () => {
        const backup = {
            format: 'folia-listening-archive',
            version: 1,
            exportedAt: 0,
            plays: [
                { id: 'ok', songKey: 's\u0001a', startedAt: at(2024, 3, 5, 10), endedAt: at(2024, 3, 5, 10, 30), listenedSeconds: 1800, totalSeconds: 3600, title: 'S', artists: ['A'] },
                { id: '', startedAt: 1 },
                { id: 'no-start' },
                'not an object',
                null,
            ],
        };
        expect(await importArchiveBackup(backup)).toEqual({ added: 1, skipped: 4 });
        const [stored] = await loadArchivePlays();
        expect(stored).toMatchObject({
            id: 'ok',
            title: 'S',
            artists: ['A'],
            albumName: null,
            coverUrl: null,
            counted: true,
            completed: false,
            totalSeconds: 3600,
        });
        // 缺日段时按同一口径补出来，总和等于 listenedSeconds。
        expect(stored.segments.reduce((sum, segment) => sum + segment.seconds, 0)).toBe(1800);
        expect(stored.segments).toHaveLength(1);
    });

    it('行上的计次判定照用，不被重新算掉', async () => {
        const backup = {
            format: 'folia-listening-archive',
            version: 1,
            exportedAt: 0,
            plays: [{ id: 'kept', startedAt: at(2024, 3, 5, 10), endedAt: at(2024, 3, 5, 11), listenedSeconds: 600, totalSeconds: 600, counted: false, completed: true }],
        };
        await importArchiveBackup(backup);
        const stored = await appDatabase.listeningArchivePlays.get('kept');
        expect(stored).toMatchObject({ counted: false, completed: true });
    });

    it('格式或版本不对时只记日志、零新增、不抛给界面', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await expect(importArchiveBackup({ format: 'other', version: 1, plays: [] })).resolves.toEqual({ added: 0, skipped: 0 });
        await expect(importArchiveBackup({ format: 'folia-listening-archive', version: 2, plays: [] })).resolves.toEqual({ added: 0, skipped: 0 });
        await expect(importArchiveBackup('nope')).resolves.toEqual({ added: 0, skipped: 0 });
        await expect(importArchiveBackup({ format: 'folia-listening-archive', version: 1 })).resolves.toEqual({ added: 0, skipped: 0 });
        expect(await countArchivePlays()).toBe(0);
        expect(warn).toHaveBeenCalledTimes(4);
        expect(warn.mock.calls[0][0]).toContain('[listeningArchive]');
        // 日志里交的是抛出来的错本身，不是它的 message。
        expect(warn.mock.calls[0][1]).toBeInstanceOf(TypeError);
    });
});
