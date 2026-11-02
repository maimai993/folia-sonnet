import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearArchive, loadArchivePlays, saveArchivePlay } from '../../../src/services/listeningArchive/repository';
import { invalidateArchiveRpcCache, listeningArchiveRpc } from '../../../src/services/listeningArchive/archiveRpc';
import { callBuiltinRpc, hasBuiltinRpc } from '../../../src/mods/builtin/builtinRpc';
import { splitSegments } from '../../../src/services/listeningArchive/rules';
import type { ArchivePlay } from '../../../src/services/listeningArchive/types';

// test/unit/listeningArchive/archiveRpc.test.ts
// 模组那套 rpc 在渲染进程里的回答：查询 / 分页 / 轨迹读到本机归档；导入写进来；导出在无 DOM 的环境里明确报错；
// 模组自己的采样写入是空操作（写入只有原生采集器一处）；`folium.rpc.call` 的路由先问内置表。

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

const call = async <T>(name: string, ...args: unknown[]): Promise<T> => {
    const handler = listeningArchiveRpc[name];
    if (!handler) throw new Error(`no handler: ${name}`);
    return await handler(args) as T;
};

const dayRange = (hour: number) => ({ period: 'day' as const, start: at(2024, 3, 5, 0), end: at(2024, 3, 6, 0), hour });

beforeEach(async () => {
    await clearArchive();
    invalidateArchiveRpcCache();
});

describe('archiveRpc', () => {
    it('query 读到本机归档的汇总与排行', async () => {
        await saveArchivePlay(makePlay({ id: 'a' }));
        const result = await call<{ summary: { plays: number }; songs: Array<{ name: string }> }>(
            'archive.query',
            { period: 'day', start: at(2024, 3, 5, 0), end: at(2024, 3, 6, 0) },
        );

        expect(result.summary.plays).toBe(1);
        expect(result.songs[0].name).toBe('Song');
    });

    it('records 分页，trajectory 给名次', async () => {
        await saveArchivePlay(makePlay({ id: 'a' }));
        const page = await call<{ total: number; items: Array<{ id: string }> }>(
            'archive.records',
            { period: 'day', start: at(2024, 3, 5, 0), end: at(2024, 3, 6, 0), offset: 0, limit: 30 },
        );
        expect(page.total).toBe(1);
        expect(page.items[0].id).toBe('a');

        const query = await call<{ songs: Array<{ key: string }> }>(
            'archive.query',
            { period: 'day', start: at(2024, 3, 5, 0), end: at(2024, 3, 6, 0) },
        );
        const trajectory = await call<{ first: number; ranks: unknown[] }>('archive.trajectory', query.songs[0].key, 'month');
        expect(trajectory.first).toBe(at(2024, 3, 5, 10));
        expect(trajectory.ranks.length).toBeGreaterThan(0);
    });

    it('artworks 的封面直接来自归档行', async () => {
        await saveArchivePlay(makePlay({ id: 'a' }));
        const query = await call<{ songs: Array<{ key: string }> }>(
            'archive.query',
            { period: 'day', start: at(2024, 3, 5, 0), end: at(2024, 3, 6, 0) },
        );
        const artworks = await call<Record<string, { url: string }>>('archive.artworks', [query.songs[0].key]);

        expect(artworks[query.songs[0].key].url).toBe('https://example.com/cover.jpg');
    });

    it('导入写进本机归档，重复导入不翻倍', async () => {
        const backup = JSON.stringify({
            format: 'folia-listening-archive',
            version: 1,
            exportedAt: new Date().toISOString(),
            records: [{
                id: 'imported-1',
                startedAt: at(2024, 3, 5, 8),
                endedAt: at(2024, 3, 5, 8, 3),
                duration: 180,
                song: { id: '9', title: 'Imported', artist: 'X', album: 'Al', source: 'netease' },
                segments: [{ start: at(2024, 3, 5, 8), end: at(2024, 3, 5, 8, 3), seconds: 180, offset: 0 }],
            }],
        });

        expect(await call<{ added: number }>('archive.import', backup)).toEqual({ added: 1, total: 1 });
        expect(await call<{ added: number }>('archive.import', backup)).toEqual({ added: 0, total: 1 });
        expect((await loadArchivePlays()).length).toBe(1);
    });

    it('坏备份只报错，不动本机记录', async () => {
        await expect(call('archive.import', '{oops')).rejects.toThrow('备份');
        await expect(call('archive.import', JSON.stringify({ format: 'other' }))).rejects.toThrow('不是支持的听歌档案备份');
    });

    it('模组自己的采样写入是空操作：写入只由原生采集器负责', async () => {
        expect(await call('archive.record', { id: 'x' })).toEqual({ accepted: false, revision: 0 });
        expect((await loadArchivePlays()).length).toBe(0);
    });

    it('低性能开关读写的是本机设置（node 里没有 localStorage，只验默认值）', async () => {
        expect(await call('archive.settings')).toEqual({ lowPerformance: false });
    });

    it('导出在没有 DOM 的环境里明确说不行', async () => {
        await expect(call('archive.export')).rejects.toThrow('当前环境无法导出文件');
    });

    it('云端那一组明确回不支持', async () => {
        await expect(call('netease.state')).rejects.toThrow('安卓端暂不支持网易云云端档案');
    });

    it('参数不对时抛中文原因，不返回半个结果', async () => {
        await expect(call('archive.query', { period: 'epoch', start: 0, end: 1 })).rejects.toThrow('查询时段无效');
        await expect(call('archive.query', { period: 'day', start: 1, end: 0 })).rejects.toThrow('查询时间范围无效');
        await expect(call('archive.trajectory', '', 'month')).rejects.toThrow('缺少歌曲键');
    });
});

describe('callBuiltinRpc', () => {
    it('内置模组的方法由渲染进程回答', async () => {
        expect(hasBuiltinRpc('listening-archive')).toBe(true);
        expect(await callBuiltinRpc('listening-archive', 'archive.record', [{}]))
            .toEqual({ ok: true, result: { accepted: false, revision: 0 } });
    });

    it('表里没有的方法按失败回话，不悄悄落到主进程', async () => {
        const result = await callBuiltinRpc('listening-archive', 'archive.unknown', []);
        expect(result).toEqual({ ok: false, error: 'builtin-rpc-unknown:archive.unknown' });
    });

    it('不是内置模组时返回 null，调用方接着问主进程', async () => {
        expect(await callBuiltinRpc('vinyl-disc', 'anything', [])).toBeNull();
    });
});
