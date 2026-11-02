import { getStoredString, removeStoredKey, setStoredString } from '../../../stores/storagePrimitives';

// src/services/onlineMusic/netease/neteaseArchiveRpc.ts
// 「听歌档案」模组里网易云云端那一组 rpc 在安卓端的回答：`netease.state` / `netease.invalidate` /
// `netease.configure` / `netease.account` / `netease.rank` / `netease.report`。桌面端这六个方法由模组的
// 主进程（index.cjs 里的 NeteaseArchive）回答，状态写在用户数据目录的 netease.json、报告另存成
// report-<metric>.json；安卓没有主进程通道，这里按同一套语义实现一份，状态落 localStorage。
// 表由 `src/services/listeningArchive/archiveRpc.ts` 合进模组的总表（builtinRpc.ts 只认总表）。
//
// 取数不在这里：模组的界面自己经 `platform.raw` 拿网易云后端的数据（folium/platformRaw.ts →
// omni.requestProviderRaw → 本目录 neteaseRaw.ts → netease.ts 的请求），拿到之后把结果交给
// `netease.rank` / `netease.report`，由这里校验、挑字段、算时长、留错误。所以这里一条 HTTP 都不发，
// 也就没有第二条 HTTP 客户端。
//
// 与主进程那版的差别（其余逐条对齐：方法名、参数、返回字段、报错文案）：
//   - 没有文件系统：状态是一份 localStorage 里的 JSON（键见 STORAGE_KEY），report-<metric>.json 那三份
//     原始报告不存——界面用到的只有挑出来的字段和算好的秒数；
//   - 还没记下账号（没登录）时，`netease.rank` / `netease.report` 回一句「先去登录」，主进程那版只回
//     「账号或范围已更改，请重新同步」；
//   - 每一处决定都记一条 `[ListeningArchive]` 日志（主进程那版靠它自己的 rpc 日志）。

/** 状态的存储键：和 `src/stores/` 里那些键一样，发布后不改名。 */
const STORAGE_KEY = 'folia.listening-archive.netease';
/** 模组配置里那个端点的名字（桌面端原样保留，界面读它）。 */
const ENDPOINT = 'Folium platform.raw';

/** 报告的三个周期：全部、本周、本月。 */
type ReportMetric = 'total' | 'week' | 'month';
const REPORT_METRICS: readonly ReportMetric[] = ['total', 'week', 'month'];
/** 排行榜的两种口径。 */
type RankScope = 'week' | 'all';
const RANK_SCOPES: readonly RankScope[] = ['week', 'all'];
/** 时长单位与换算成秒的倍数。 */
type TimeUnit = 'seconds' | 'minutes' | 'milliseconds';
const TIME_UNITS: readonly TimeUnit[] = ['seconds', 'minutes', 'milliseconds'];
const UNIT_SECONDS: Readonly<Record<TimeUnit, number>> = { seconds: 1, minutes: 60, milliseconds: 0.001 };

/** 报告里挑出来的一组数值字段：`path` 是从 `data` 起的点号路径（`data.totalDuration`）。 */
interface ArchiveField {
    path: string;
    value: number;
}

/** 时长字段与它自己的单位：界面上由用户从实际返回的字段里点选。 */
interface ArchiveMapping {
    path: string;
    unit: TimeUnit;
}

interface ArchiveReport {
    accountKey: string;
    metric: ReportMetric;
    syncedAt: number;
    fields: ArchiveField[];
    seconds: number | null;
    /** 这一期没拿到时报的话，界面照原样显示，上一期拿到的字段与秒数留着。 */
    error?: string;
    periodStart?: number;
    periodEnd?: number;
}

interface RankArtist {
    id: string;
    name: string;
}

interface RankSong {
    id: string;
    name: string;
    artists: string;
    artistItems: RankArtist[];
    albumId?: string;
    album: string;
    cover: string | null;
    plays: number;
}

interface ArchiveRank {
    accountKey: string;
    scope: RankScope;
    syncedAt: number;
    songs: RankSong[];
}

interface ArchiveState {
    config: {
        endpoint: string;
        accountKey: string;
        mappings: Partial<Record<ReportMetric, ArchiveMapping>>;
    };
    loggedIn: boolean;
    nickname: string;
    ranks: Partial<Record<RankScope, ArchiveRank>>;
    reports: Partial<Record<ReportMetric, ArchiveReport>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

/** 深拷贝：交出去的那份和留在模块里的那份互不影响（主进程那版用 structuredClone）。 */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** 空状态：与模组自己的 `er()`（client.mjs）同形，第一次同步前界面看到的就是它。 */
const emptyState = (): ArchiveState => ({
    config: { endpoint: ENDPOINT, accountKey: '', mappings: {} },
    loggedIn: false,
    nickname: '',
    ranks: {},
    reports: {},
});

/*
 * 报告数据里像凭据的键一律不往下带（主进程那版也是这么滤的）：留下来的只有 null、数字和布尔值，
 * 字符串在整棵树上都不留，所以拍平成字段以后剩下的全是数字。
 */
const SECRET_FIELD = /(cookie|token|authorization|password|secret|friend|session|credential|csrf)/i;

const sanitize = (value: unknown, depth = 0): unknown => {
    if (depth > 6) return undefined;
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value !== 'object') return undefined;
    if (Array.isArray(value)) {
        return value.slice(0, 100).map((item) => sanitize(item, depth + 1)).filter((item) => item !== undefined);
    }
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !SECRET_FIELD.test(key))
        .map(([key, item]) => [key, sanitize(item, depth + 1)])
        .filter(([, item]) => item !== undefined));
};

/** 把树拍成 `{ path, value }`：只收非负的有限数，最多 6 层、每层 100 项、总数 200 项。 */
const flatten = (value: unknown, path = 'data', depth = 0): ArchiveField[] => {
    if (depth > 6) return [];
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? [{ path, value }] : [];
    // 数组不拍平（主进程那版同样只走对象），字符串与布尔值也都不是字段。
    if (!isRecord(value)) return [];
    return Object.entries(value)
        .slice(0, 100)
        .flatMap(([key, item]) => flatten(item, `${path}.${key}`, depth + 1))
        .slice(0, 200);
};

/** 每个周期首选的时长字段；都是非负有限数才进候选。 */
const PREFERRED_PATH: Readonly<Record<ReportMetric, string>> = {
    total: 'data.totalDuration',
    week: 'data.listenTimeDistributionBlock.playDuration',
    month: 'data.listenTimeDistributionBlock.playDuration',
};
/** 首选字段不在时认的备选路径（和主进程那版同一个正则）。 */
const FALLBACK_PATH = /^data\.(?:duration|listenTime|listenDuration|durationSeconds|durationMinutes|durationMilliseconds|exampleSeconds)$/;

/** 这个周期的时长字段候选：首选路径优先，没有就按备选路径找；都没有时是空数组。 */
const durationFields = (metric: ReportMetric, fields: readonly ArchiveField[]): ArchiveField[] => {
    const usable = fields.filter((field) => Number.isFinite(field.value) && field.value >= 0);
    const exact = usable.filter((field) => field.path === PREFERRED_PATH[metric]);
    return exact.length > 0 ? exact : usable.filter((field) => FALLBACK_PATH.test(field.path));
};

/** 按映射把字段换算成秒；没有映射、字段不在、单位不认识时是 null。 */
const secondsOf = (
    metric: ReportMetric,
    fields: readonly ArchiveField[],
    mapping: ArchiveMapping | undefined,
): number | null => {
    if (!mapping || !TIME_UNITS.includes(mapping.unit)) return null;
    const field = fields.find((item) => item.path === mapping.path);
    if (!field) return null;
    const seconds = field.value * UNIT_SECONDS[mapping.unit];
    return Number.isFinite(seconds) ? seconds : null;
};

/**
 * 从报告数据里认出时长字段与单位，认不出时返回 null。
 * 周期对不上、结构变了就抛错：那是网易云改了形状，界面上要说出来，上一期的结果留着。
 */
const detectMapping = (metric: ReportMetric, data: Record<string, unknown>): ArchiveMapping | null => {
    if (data.type !== undefined && data.type !== metric) throw new TypeError('平台报告周期与请求不一致，保留上次结果');
    if (metric === 'total') {
        return typeof data.totalDuration === 'number' && Number.isFinite(data.totalDuration) && data.totalDuration >= 0
            ? { path: 'data.totalDuration', unit: 'seconds' }
            : null;
    }
    const block = data.listenTimeDistributionBlock;
    if (!isRecord(block)) return null;
    if (block.blockType !== undefined
        && (typeof block.blockType !== 'string' || !block.blockType.startsWith('LISTEN_TIME_DISTRIBUTION'))) {
        throw new TypeError('平台时长报告结构变化，保留上次结果');
    }
    return typeof block.playDuration === 'number' && Number.isFinite(block.playDuration) && block.playDuration >= 0
        ? { path: 'data.listenTimeDistributionBlock.playDuration', unit: 'minutes' }
        : null;
};

/** 网易云的封面地址只认 `*.music.126.net`，一律升成 https。 */
const NETWORK_COVER = /^https?:\/\/[^/]+\.music\.126\.net\//i;

/** 把排行榜的回答收成一首首歌；条目或回答不像样时抛错，上一期的榜留着。 */
const readRank = (accountKey: string, scope: RankScope, answer: unknown): ArchiveRank => {
    const record = isRecord(answer) ? answer : null;
    if (record?.code !== 200) throw new TypeError('排行榜不可用：请检查登录状态、用户 ID 和隐私权限');
    const rows = record[scope === 'week' ? 'weekData' : 'allData'];
    if (!Array.isArray(rows)) throw new TypeError('排行榜返回结构变化，保留上次结果');
    const seen = new Set<string>();
    const songs = rows.slice(0, 1000).map((row): RankSong => {
        const entry = isRecord(row) ? row : {};
        const song = isRecord(entry.song) ? entry.song : {};
        const id = String(song.id ?? '');
        const name = typeof song.name === 'string' ? song.name : '';
        const plays = typeof entry.playCount === 'number' ? entry.playCount : NaN;
        if (!/^\d+$/.test(id) || !name || !Number.isFinite(plays) || plays < 0 || seen.has(id)) {
            throw new TypeError('排行榜条目无效，保留上次结果');
        }
        seen.add(id);
        const album = isRecord(song.al) ? song.al : isRecord(song.album) ? song.album : {};
        const rawArtists = Array.isArray(song.ar) ? song.ar : Array.isArray(song.artists) ? song.artists : [];
        const artistItems = rawArtists
            .map((artist: unknown): RankArtist => {
                const item = isRecord(artist) ? artist : {};
                return { id: String(item.id ?? item.name ?? ''), name: String(item.name ?? '') };
            })
            .filter((item) => item.name !== '');
        const cover = typeof album.picUrl === 'string' && NETWORK_COVER.test(album.picUrl)
            ? album.picUrl.replace(/^http:/, 'https:')
            : null;
        return {
            id,
            name,
            artists: artistItems.map((item) => item.name).join(' / '),
            artistItems,
            albumId: album.id ? String(album.id) : undefined,
            album: String(album.name ?? ''),
            cover,
            plays,
        };
    });
    return { accountKey, scope, syncedAt: Date.now(), songs };
};

// ---- 状态：一份留在模块里，一份写进 localStorage

let state: ArchiveState | null = null;

/** 读回来的一份：形状不对就当空的重新来（主进程那版读坏 json 时也是重来）。 */
const readStored = (): ArchiveState => {
    const empty = emptyState();
    const raw = getStoredString(STORAGE_KEY, '');
    if (!raw) return empty;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed)) return empty;
        const config = isRecord(parsed.config) ? parsed.config : {};
        return {
            config: {
                endpoint: ENDPOINT,
                accountKey: typeof config.accountKey === 'string' ? config.accountKey : '',
                mappings: isRecord(config.mappings) ? config.mappings as ArchiveState['config']['mappings'] : {},
            },
            // 桌面端读盘时也把登录态置回 false：登录态每次都由 `netease.account` 重新说一遍。
            loggedIn: false,
            nickname: typeof parsed.nickname === 'string' ? parsed.nickname : '',
            ranks: isRecord(parsed.ranks) ? parsed.ranks as ArchiveState['ranks'] : {},
            reports: isRecord(parsed.reports) ? parsed.reports as ArchiveState['reports'] : {},
        };
    } catch (error) {
        console.warn('[ListeningArchive] 存着的网易云云端档案读不出来，按空的重来', error);
        return empty;
    }
};

const current = (): ArchiveState => {
    if (!state) state = readStored();
    return state;
};

/** 存下来：写不进 localStorage（配额满了）就只在这次运行里有效，不因此让 rpc 失败。 */
const persist = (next: ArchiveState): ArchiveState => {
    state = next;
    try {
        setStoredString(STORAGE_KEY, JSON.stringify(next));
    } catch (error) {
        console.warn('[ListeningArchive] 网易云云端档案没写进本地存储，这次运行里还好用', error);
    }
    return next;
};

/** 交出去的那份：三个报告的秒数按当前映射再算一遍（主进程那版 get() 也是这么做的）。 */
const snapshot = (): ArchiveState => {
    const copy = clone(current());
    for (const metric of REPORT_METRICS) {
        const report = copy.reports[metric];
        if (report) report.seconds = secondsOf(metric, report.fields, copy.config.mappings[metric]);
    }
    return copy;
};

/** 账号、映射、报告、排行全丢，回到空状态。 */
const invalidate = (): ArchiveState => {
    state = emptyState();
    removeStoredKey(STORAGE_KEY);
    console.info('[ListeningArchive] 网易云云端档案已清空：账号、报告字段和排行榜都从头来');
    return snapshot();
};

/** 记下当前登录的账号。账号换了就把上一号的报告、排行、映射都丢掉。 */
const account = (value: unknown): ArchiveState => {
    if (!value) return invalidate();
    if (!isRecord(value)) throw new TypeError('账号信息无效');
    const accountKey = value.accountKey;
    const nickname = value.nickname;
    if (typeof accountKey !== 'string' || accountKey === '' || accountKey.length > 256) throw new TypeError('账号信息无效');
    if (typeof nickname !== 'string') throw new TypeError('账号信息无效');

    const before = current();
    const changed = accountKey !== before.config.accountKey;
    const next: ArchiveState = {
        ...before,
        config: changed
            ? { ...before.config, accountKey, mappings: {} }
            : { ...before.config, accountKey },
        ranks: changed ? {} : before.ranks,
        reports: changed ? {} : before.reports,
        nickname: nickname.slice(0, 200),
        loggedIn: true,
    };
    persist(next);
    console.info(changed
        ? `[ListeningArchive] 网易云云端档案换了账号（${accountKey}），上一号的报告与排行已丢弃`
        : `[ListeningArchive] 网易云云端档案确认账号（${accountKey}），登录态已记下`);
    return snapshot();
};

/**
 * 确认时长字段与单位。只能在已经拿到报告的字段里选，且不能跨账号：
 * 换过账号以后旧的字段选择没有意义，要让用户重新确认。
 */
const configure = (value: unknown): ArchiveState => {
    const before = current();
    const accountKey = isRecord(value) ? value.accountKey : undefined;
    if (accountKey !== before.config.accountKey) throw new TypeError('账号已更改，请重新确认报告字段');

    const given = isRecord(value) && isRecord(value.mappings) ? value.mappings : {};
    const mappings: Partial<Record<ReportMetric, ArchiveMapping>> = {};
    for (const metric of REPORT_METRICS) {
        const candidate = given[metric];
        if (!candidate) continue;
        if (!isRecord(candidate)) throw new TypeError('请选择实际返回的听歌时长字段，并明确确认单位');
        const { path, unit } = candidate;
        const usable = durationFields(metric, before.reports[metric]?.fields ?? []).some((field) => field.path === path);
        if (typeof path !== 'string' || path.length > 500 || typeof unit !== 'string'
            || !TIME_UNITS.includes(unit as TimeUnit) || !usable) {
            throw new TypeError('请选择实际返回的听歌时长字段，并明确确认单位');
        }
        mappings[metric] = { path, unit: unit as TimeUnit };
    }

    const next = clone(before);
    next.config.mappings = mappings;
    for (const metric of REPORT_METRICS) {
        const report = next.reports[metric];
        if (report) report.seconds = secondsOf(metric, report.fields, mappings[metric]);
    }
    persist(next);
    const chosen = Object.entries(mappings).map(([metric, mapping]) => `${metric}=${mapping.path}(${mapping.unit})`);
    console.info(`[ListeningArchive] 网易云云端档案的报告字段改成 ${chosen.length > 0 ? chosen.join('，') : '未选任何字段'}`);
    return snapshot();
};

/** 账号对不上（或者还没登录）时就地说清楚，别让后面把结果记到别人的名下。 */
const requireAccount = (accountKey: unknown): void => {
    const remembered = current().config.accountKey;
    if (remembered === '') throw new TypeError('还没登录网易云：请先在 Folia 首页登录，再回档案页同步云端数据');
    if (typeof accountKey !== 'string' || accountKey !== remembered) {
        throw new TypeError('账号或范围已更改，请重新同步');
    }
};

/** 收一份排行榜的回答。 */
const rank = (accountKey: unknown, scope: unknown, answer: unknown): ArchiveState => {
    requireAccount(accountKey);
    if (typeof scope !== 'string' || !RANK_SCOPES.includes(scope as RankScope)) throw new TypeError('账号或范围已更改，请重新同步');
    const before = current();
    const held = readRank(before.config.accountKey, scope as RankScope, answer);
    const next = clone(before);
    next.ranks = { ...next.ranks, [scope as RankScope]: held };
    persist(next);
    console.info(`[ListeningArchive] 网易云云端排行（${held.scope}）收下 ${held.songs.length} 首`);
    return snapshot();
};

/**
 * 收一份报告的两种结局：
 *   - 这次没拿到（第 4 个实参是原因）：只把原因记在这个周期上，上一期的字段与秒数留着；
 *   - 拿到了：校验形状、认时长字段、拍平成数值字段、按映射算秒数。
 * 本机统计不经过这里，无论哪种结局都不受影响。
 */
const report = (accountKey: unknown, metric: unknown, answer: unknown, failure: unknown): ArchiveState => {
    requireAccount(accountKey);
    if (typeof metric !== 'string' || !REPORT_METRICS.includes(metric as ReportMetric)) {
        throw new TypeError('账号或范围已更改，请重新同步');
    }
    const before = current();
    const key = before.config.accountKey;
    const as = metric as ReportMetric;
    const said = typeof failure === 'string' ? failure.trim() : '';

    if (said !== '') {
        const text = said.slice(0, 500);
        const previous = before.reports[as];
        const next = clone(before);
        next.reports = {
            ...next.reports,
            [as]: previous
                ? { ...previous, error: text }
                : { accountKey: key, metric: as, syncedAt: 0, fields: [], seconds: null, error: text },
        };
        persist(next);
        console.warn(`[ListeningArchive] 网易云云端报告（${as}）这次没拿到，保留上次结果：${text}`);
        return snapshot();
    }

    const payload = isRecord(answer) ? answer : {};
    const data = payload.data;
    if (payload.code !== 200 || !isRecord(data)) {
        throw new TypeError('平台未提供报告，可能需要登录或会员权限');
    }
    if (JSON.stringify(data).length > 4 * 1024 * 1024) throw new TypeError('报告超出可处理大小');

    const detected = detectMapping(as, data);
    const next = clone(before);
    if (!next.config.mappings[as] && detected) next.config.mappings[as] = detected;
    const fields = flatten(sanitize(data));
    const seconds = secondsOf(as, fields, next.config.mappings[as]);
    const period = as !== 'total' && Number.isFinite(data.startTime) && Number.isFinite(data.endTime)
        ? { periodStart: data.startTime as number, periodEnd: data.endTime as number }
        : {};
    next.reports = {
        ...next.reports,
        [as]: { accountKey: key, metric: as, syncedAt: Date.now(), fields, seconds, ...period },
    };
    persist(next);
    console.info(`[ListeningArchive] 网易云云端报告（${as}）收下 ${fields.length} 个数值字段，听歌时长 ${seconds === null ? '未识别' : `${seconds} 秒`}`);
    return snapshot();
};

/**
 * 模组问的那六个方法。抛出去的句子会原样出现在模组界面上，所以都写成中文的「为什么不行」。
 * 参数与主进程那版同序：`netease.rank(accountKey, scope, 回答)`、
 * `netease.report(accountKey, metric, 回答, 没拿到的原因)`。
 */
export const neteaseArchiveRpc: Readonly<Record<string, (args: readonly unknown[]) => unknown>> = {
    'netease.state': () => snapshot(),
    'netease.invalidate': () => invalidate(),
    'netease.configure': ([update]) => configure(update),
    'netease.account': ([value]) => account(value),
    'netease.rank': ([accountKey, scope, answer]) => rank(accountKey, scope, answer),
    'netease.report': ([accountKey, metric, answer, failure]) => report(accountKey, metric, answer, failure),
};
