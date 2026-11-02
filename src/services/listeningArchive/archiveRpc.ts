import { loadArchivePlays, saveArchivePlays } from './repository';
import { toArchivePlay, toModRecord } from './modRecords';
import {
    listArchiveRecords,
    modSongKey,
    queryArchive,
    songTrajectory,
    type ModPeriod,
    type ModRange,
    type ModRecord,
    type ModRecordQuery,
} from './modAnalytics';
import { useListeningArchiveSettingsStore } from '../../stores/useListeningArchiveSettingsStore';
import { neteaseArchiveRpc } from '../onlineMusic/netease/neteaseArchiveRpc';

// src/services/listeningArchive/archiveRpc.ts
// 「听歌档案」模组在 `folium.rpc.call` 里问的那些方法，安卓端的回答（接线见 src/mods/builtin/builtinRpc.ts）。
// 模组原来把这些方法放在 Electron 主进程的 index.cjs 里：记录写进用户数据目录的 jsonl 文件，聚合跑在
// analytics.cjs 这个 worker 里。安卓没有主进程，所以这里是同一套方法的渲染进程实现，数据只认本机那份
// 归档表（src/services/listeningArchive/repository.ts）——原生采集器一直在往里写，模组界面因此看得见
// 用户之前听过的所有记录，不是从零开始。
//
// 分工是固定的：**写入只有原生采集器一处**。所以 `archive.record`（模组自己的采样回调）只接住不回话，
// 不落库；两个采集器各写一份会让每次播放记两次。
//
// 方法口径与主进程那版逐条对齐（名字、参数、返回字段），差别只在这里做不到的两处：
//   - `archive.artworks` 的封面直接来自归档行的 coverUrl，不再有主进程的封面缓存目录；
//   - `archive.export` 没有「文档目录」可写，走浏览器下载，返回的文件名就是给界面看的那一段。
// 云端档案那一组（账号、排行、报告、时长字段）不写在这里：它按平台分目录，规则和状态都在那个平台的
// 目录里，这一张表只在末尾把它们合进来（见 `listeningArchiveRpc`）。

/** 读一次库的结果留这么久：模组界面在换范围、翻页、点刷新时会连着问好几次。 */
const MEMO_MS = 5000;
const PERIODS: readonly ModPeriod[] = ['day', 'week', 'month', 'year'];

let memo: { at: number; records: ModRecord[] } | null = null;

/** 本机全部归档行，换成模组的记录形状；5 秒内复用同一份。 */
const loadRecords = async (): Promise<ModRecord[]> => {
    if (memo && Date.now() - memo.at < MEMO_MS) return memo.records;
    const plays = await loadArchivePlays();
    const records = plays.map(toModRecord);
    memo = { at: Date.now(), records };
    return records;
};

/** 丢掉缓存的那一份：导入之后、以及别处改了库之后都要重新读。 */
export const invalidateArchiveRpcCache = (): void => {
    memo = null;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

/** 模组传过来的范围：字段对不上就当场拒绝，别让后面算出一堆 NaN。 */
const readRange = (value: unknown): ModRange => {
    if (!isRecord(value)) throw new TypeError('查询范围无效');
    const { period, start, end, filter } = value;
    if (typeof period !== 'string' || !PERIODS.includes(period as ModPeriod)) throw new TypeError('查询时段无效');
    if (typeof start !== 'number' || !Number.isFinite(start) || typeof end !== 'number' || !Number.isFinite(end) || end <= start) {
        throw new TypeError('查询时间范围无效');
    }
    const range: ModRange = { period: period as ModPeriod, start, end };
    if (isRecord(filter)) {
        range.filter = {
            weekday: typeof filter.weekday === 'number' ? filter.weekday : undefined,
            hour: typeof filter.hour === 'number' ? filter.hour : undefined,
            songKey: typeof filter.songKey === 'string' ? filter.songKey : undefined,
            albumKey: typeof filter.albumKey === 'string' ? filter.albumKey : undefined,
            artistKey: typeof filter.artistKey === 'string' ? filter.artistKey : undefined,
        };
    }
    return range;
};

const readRecordQuery = (value: unknown): ModRecordQuery => {
    const range = readRange(value);
    const source = value as Record<string, unknown>;
    return {
        ...range,
        offset: typeof source.offset === 'number' ? source.offset : undefined,
        limit: typeof source.limit === 'number' ? source.limit : undefined,
    };
};

/** 按时刻 / 范围给导出文件起名，与主进程那版一样的可读性。 */
const exportFileName = (): string => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `听歌档案-${stamp}.json`;
};

/** 浏览器里交给下载；安卓 WebView 有没有下载器是设备的事，失败就当没导出并回话说明。 */
const downloadBackup = (text: string, fileName: string): void => {
    if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
        throw new Error('当前环境无法导出文件，请改用导入/导出文本');
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
};

const readBackupRows = (text: string): unknown[] => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new TypeError('备份不是合法的 JSON');
    }
    if (!isRecord(parsed)) throw new TypeError('备份不是 JSON 对象');
    if (parsed.format !== 'folia-listening-archive') throw new TypeError('不是支持的听歌档案备份');
    const rows = Array.isArray(parsed.records) ? parsed.records : Array.isArray(parsed.plays) ? parsed.plays : null;
    if (!rows) throw new TypeError('备份缺少记录数组');
    if (rows.length > 100000) throw new TypeError('备份超过 10 万条，请分批导入');
    return rows;
};

/**
 * 本机归档那几行：模组的 `folium.rpc.call(name, ...args)` 进来，这里按名字分派。
 * 抛出去的句子会原样出现在模组界面上，所以用中文写清楚「为什么不行」。
 */
const localArchiveRpc: Readonly<Record<string, (args: readonly unknown[]) => unknown>> = {
    'archive.query': async ([range]) => {
        const records = await loadRecords();
        return queryArchive(records, readRange(range), records.length);
    },
    'archive.records': async ([query]) => {
        const records = await loadRecords();
        return listArchiveRecords(records, readRecordQuery(query));
    },
    'archive.trajectory': async ([songKey, period]) => {
        if (typeof songKey !== 'string' || songKey === '') throw new TypeError('缺少歌曲键');
        if (typeof period !== 'string' || !PERIODS.includes(period as ModPeriod)) throw new TypeError('轨迹时段无效');
        const records = await loadRecords();
        return songTrajectory(records, songKey, period as ModPeriod);
    },
    'archive.settings': ([update]) => {
        const store = useListeningArchiveSettingsStore.getState();
        if (isRecord(update) && typeof update.lowPerformance === 'boolean') {
            store.setLowPerformance(update.lowPerformance);
        }
        return { lowPerformance: useListeningArchiveSettingsStore.getState().lowPerformance };
    },
    'archive.artworks': async ([keys]) => {
        if (!Array.isArray(keys) || keys.length > 500) throw new TypeError('封面查询数量无效');
        const wanted = new Set(keys.filter((key): key is string => typeof key === 'string'));
        const found: Record<string, { url: string }> = {};
        for (const play of await loadArchivePlays()) {
            if (!play.coverUrl) continue;
            const key = modSongKey(toModRecord(play).song);
            if (wanted.has(key) && !found[key]) found[key] = { url: play.coverUrl };
        }
        return found;
    },
    // 主进程那边会把播放页截下来的封面写进缓存目录；这里封面本来就在归档行上（coverUrl），没有要存的。
    'archive.artwork.save': () => null,
    // 写入由原生采集器负责（见文件头），模组自己的采样只到这里为止。
    'archive.record': () => ({ accepted: false, revision: 0 }),
    'archive.export': async () => {
        const records = await loadRecords();
        const fileName = exportFileName();
        downloadBackup(JSON.stringify({
            format: 'folia-listening-archive',
            version: 1,
            exportedAt: new Date().toISOString(),
            records,
        }), fileName);
        return { path: fileName, records: records.length };
    },
    'archive.import': async ([text]) => {
        if (typeof text !== 'string') throw new TypeError('导入内容不是文本');
        if (text.length > 50 * 1024 * 1024) throw new TypeError('备份超过 50 MiB，请分批导入');
        const rows = readBackupRows(text);
        const known = new Set((await loadArchivePlays()).map(play => play.id));
        const accepted = new Map<string, ReturnType<typeof toArchivePlay>>();
        for (const row of rows) {
            const play = toArchivePlay(row);
            if (!play || known.has(play.id) || accepted.has(play.id)) continue;
            accepted.set(play.id, play);
        }
        const plays = [...accepted.values()].filter((play): play is NonNullable<typeof play> => play !== null);
        if (plays.length > 0) {
            await saveArchivePlays(plays);
            invalidateArchiveRpcCache();
        }
        return { added: plays.length, total: known.size + plays.length };
    },
};

/*
 * 模组看到的一整张表：本机归档那几行，加上平台目录给的那几行（云端档案的账号、排行、报告、时长字段）。
 * 云端那一组按平台分目录：规则、状态和报错文案都在平台自己的目录里（src/services/onlineMusic 下各平台的
 * `*ArchiveRpc.ts`），这里只做合并，不写任何平台规则。
 */
export const listeningArchiveRpc: Readonly<Record<string, (args: readonly unknown[]) => unknown>> = {
    ...localArchiveRpc,
    ...neteaseArchiveRpc,
};
