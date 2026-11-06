import { omni } from '../../../services/onlineMusic/omni';
import { usePlaybackStore } from '../../../stores/usePlaybackStore';
import { getPlaybackSongKey } from '../../../utils/appPlaybackGuards';
import { collectCollections, type RhineCollectionInputs } from './rhineLibrary';

// src/library/suites/rhine/rhinePayload.ts
//
// 把 Folia 曲库翻译成 RhineLabUI 的档案格式。
//
// 三维阵列那份代码（public/rhinelab）认的是 `content/archives.json` 那一套：
// `columns` 是几列的名字，每条 `record` 有自己的 `category` 决定它落在哪一列。
// 我们这边对应的是「歌单 = 一列，歌曲 = 一条记录」，转换只做这一层，别的不动。
//
// 只取 Folia 真有的字段：歌名、歌单名、歌手、封面、时长。RhineLab 的档案正文是
// 纯文本，所以摘要那块用歌手/专辑信息填，打开档案时不会看到编造的设定文字。

/** RhineLab 的档案记录。字段名必须和 `src/data.ts` 的 `ArchiveRecord` 一致。 */
export type RhineRecord = {
    id: string;
    title: string;
    en: string;
    department: string;
    category: string;
    date: string;
    lead: string;
    clearance: string;
    abstract: string;
    findings: string[];
    source: string;
    /** 专辑封面地址。RhineLab 的详情页据此显示封面；拿不到就留空。 */
    cover: string;
    /** 能不能播（拿得到音频地址）。详情页据此显示「可读取」或「无访问权限」。 */
    playable: boolean;
};

export type RhinePayload = {
    categories: string[];
    columns: string[];
    records: RhineRecord[];
    /** `record.id` → Folia 原始曲目，出列时用它去播放。 */
    songs: Record<string, unknown>;
    /** `record.id` → 封面地址，RhineLab 的档案卡能直接用。 */
    covers: Record<string, string>;
    /** `record.id` → 它属于哪一列（歌单名），用来凑播放队列。 */
    laneOf: Record<string, string>;
    /**
     * 当前正在播放的那首歌对应的 `record.id`；没有在播就是 `null`。
     *
     * 打开曲库时直接把指针放回正在放的那一首，省得自己再翻一遍 ——
     * 播放状态本来就是现成的（`usePlaybackStore.currentSong`），不用白不用。
     */
    currentId: string | null;
};

/**
 * 取某一首歌所在的那一列（同一个歌单）。
 *
 * 点一首歌播放时，队列应该是「这个歌单全部歌曲」而不是只有一首 ——
 * 否则播完就停，接着得手动点下一首。
 */
export const queueOf = (payload: RhinePayload, id: string): unknown[] => {
    const lane = payload.laneOf[id];
    if (!lane) return [];
    return payload.records
        .filter(record => record.department === lane)
        .map(record => payload.songs[record.id])
        .filter(Boolean);
};

/** 一列最多放多少条。RhineLab 的阵列高度是固定的，太多会挤。 */
const TRACKS_PER_COLUMN = 16;
/**
 * 最多几列。
 *
 * 这个数直接决定界面上「COLUMN nn / 总列数」的总数，不能随手截断 ——
 * 原来写 10，歌单多于 10 个时总数显示成 10，看起来就是「列数量不对」。
 * 放宽到 40：够装下绝大多数人的歌单，同时仍然拦住几百列的极端情况
 * （每列都要建模型实例，太多会拖垮首帧）。
 */
const MAX_COLUMNS = 40;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** 从曲目里挑封面，字段位置在不同平台不一样（见 rhineLibrary 的同名注释）。 */
const coverOf = (song: unknown): string => {
    const item = song as {
        album?: { coverUrl?: unknown; picUrl?: unknown; artworkUrl?: unknown };
        coverUrl?: unknown;
    } | null;
    const album = item?.album ?? {};
    const hit = [album.coverUrl, album.picUrl, album.artworkUrl, item?.coverUrl].find(
        value => typeof value === 'string' && value.length > 0,
    );
    return typeof hit === 'string' ? hit : '';
};

/** 歌手串。集合成员可能叫 artists / singer / ar，能拿到哪个用哪个。 */
const artistsOf = (song: unknown): string => {
    const item = song as {
        artists?: { name?: unknown }[];
        singer?: unknown;
        ar?: { name?: unknown }[];
    } | null;
    const list = item?.artists ?? item?.ar;
    if (Array.isArray(list)) {
        const names = list.map(artist => text(artist?.name)).filter(Boolean);
        if (names.length) return names.join(' / ');
    }
    return text(item?.singer);
};

/** 时长，显示成 mm:ss；拿不到就留空。 */
const durationOf = (song: unknown): string => {
    const raw = (song as { duration?: unknown; dt?: unknown } | null)?.duration ?? (song as { dt?: unknown } | null)?.dt;
    const ms = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    if (!ms) return '';
    const total = Math.round(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/**
 * 判断这一首到底能不能播。
 *
 * 大部分平台不会在歌单列表里就给出音频地址 —— 真正取流要等点播放的那一刻。
 * 所以这里只看**明确表示不能播**的标记，其余一律当作可播：
 * 判据反过来的话，整库都会显示成「无访问权限」，而点下去其实是有声音的。
 */
const playableOf = (song: unknown): boolean => {
    const item = song as {
        audioUrl?: unknown;
        url?: unknown;
        privilege?: { st?: unknown; pl?: unknown };
        noCopyrightRcmd?: unknown;
    } | null;
    if (!item) return false;
    // 曲目里已经带了地址：肯定能播。
    const direct = [item.audioUrl, item.url].find(value => typeof value === 'string' && value.length > 0);
    if (typeof direct === 'string') return true;
    // 平台明确推荐「无版权替代曲」，说明原曲放不了。
    if (item.noCopyrightRcmd) return false;
    const privilege = item.privilege;
    if (!privilege) return true;
    // st < 0 是下架 / 无版权，唯一明确的坏标记。
    // `pl` 不参与判断：列表接口里它常常还没填（0 = 尚未查询，不是没权限）。
    const st = typeof privilege.st === 'number' ? privilege.st : 0;
    return st >= 0;
};

/**
 * 组装注入用的载荷。没有任何歌单时返回 `null` —— 那种情况就让 RhineLab 用它自己的
 * 示例档案，至少屏上不是空的。
 */
export const buildRhinePayload = async (props: RhineCollectionInputs): Promise<RhinePayload | null> => {
    const entries = collectCollections(props).slice(0, MAX_COLUMNS);
    if (!entries.length) return null;

    const records: RhineRecord[] = [];
    const songs: Record<string, unknown> = {};
    const covers: Record<string, string> = {};
    const laneOf: Record<string, string> = {};
    // 只保留真的取到曲目的歌单，否则阵列里会出现一整列空白。
    const columns: string[] = [];

    await Promise.all(
        entries.map(async entry => {
            let items: unknown[] = [];
            try {
                const page = await omni.getCollectionTracks(
                    entry.collection as never,
                    { limit: TRACKS_PER_COLUMN, offset: 0 } as never,
                );
                items = ((page as { items?: unknown[] } | null)?.items ?? []).slice(0, TRACKS_PER_COLUMN);
            } catch (error) {
                console.warn('[rhine] 取歌单曲目失败', entry.name, error);
                return;
            }
            if (!items.length) return;

            columns.push(entry.name);
            items.forEach((item, index) => {
                /*
                 * id 必须是 `X-NNN` 这种形态。
                 *
                 * 界面上「FILE NUMBER: X-027」是直接从 id 解析出来的，
                 * 之前用 `歌单#0` 这种拼接，解析不出数字就显示成 `X-NaN`。
                 * 这里用「列序号 × 每列上限 + 列内下标」算，不依赖并发完成的先后顺序。
                 */
                const lane = entries.indexOf(entry);
                const serial = lane * TRACKS_PER_COLUMN + index + 1;
                const id = `X-${String(serial).padStart(3, '0')}`;
                const song = item as { name?: unknown; album?: { name?: unknown } };
                const title = text(song?.name) || `#${index + 1}`;
                const albumName = text(song?.album?.name);
                const artists = artistsOf(item) || entry.name;
                // 封面要在构造 record 时就拿到 —— RhineLab 只认 record，不认外挂表。
                const cover = coverOf(item);
                records.push({
                    id,
                    title,
                    en: albumName || entry.name,
                    department: entry.name,
                    category: entry.name,
                    date: durationOf(item),
                    lead: artists,
                    clearance: 'REFERENCE AREA',
                    abstract: albumName ? `${entry.name} · ${albumName}` : entry.name,
                    findings: [],
                    source: '',
                    cover,
                    playable: playableOf(item),
                });
                songs[id] = item;
                laneOf[id] = entry.name;
                if (cover) covers[id] = cover;
            });
        }),
    );

    if (!records.length) return null;

    /*
     * 找出「正在播放」的那一首，打开曲库时直接选中它。
     *
     * 用 `getPlaybackSongKey` 比较而不是比 id：同一个平台上同一首歌，
     * 从歌单进来的对象和播放器里存的对象 id 字段未必一致，key 才是统一口径。
     */
    const playing = usePlaybackStore.getState().currentSong;
    let currentId: string | null = null;
    if (playing) {
        const playingKey = getPlaybackSongKey(playing);
        for (const record of records) {
            const item = songs[record.id];
            if (item && getPlaybackSongKey(item as never) === playingKey) {
                currentId = record.id;
                break;
            }
        }
    }

    // RhineLab 按 `category` 归列，顺序由 `columns` 决定；这里保持上面 push 的顺序。
    return {
        categories: columns.slice(),
        columns,
        records,
        songs,
        covers,
        laneOf,
        currentId,
    };
};

/* ───────────── 平台搜索 ───────────── */

/**
 * 平台搜索结果的稳定 id。
 *
 * 歌单里的档案用 `X-001` 这种编号，搜索结果没有编号可用，就用平台 + 曲目
 * id 现拼一个 —— 只要同一首歌每次拼出来一样，「选中 / 播放 / 入队」就能
 * 靠它找回原始曲目。
 */
export const searchIdOf = (song: unknown): string => {
    const item = song as { source?: unknown; platform?: unknown; id?: unknown; songmid?: unknown } | null;
    const platform = text(item?.source) || text(item?.platform) || 'search';
    const id = text(item?.id) || text(item?.songmid);
    return `S:${platform}:${id}`;
};

/**
 * 把一首平台搜索结果包装成 RhineLab 认得的档案。
 *
 * 字段尽量复用歌单那条路径的口径（歌手、时长、能否播放），这样搜索结果在
 * 三维阵列里和普通档案长得一样，不需要额外的渲染分支。
 */
export const songToSearchRecord = (song: unknown): RhineRecord => {
    const item = song as {
        name?: unknown;
        title?: unknown;
        album?: unknown;
        al?: { name?: unknown };
        cover?: unknown;
        pic?: unknown;
    } | null;
    const title = text(item?.name) || text(item?.title) || '未知曲目';
    const albumName = text((item?.album as { name?: unknown } | undefined)?.name) ?? text(item?.al?.name);
    const cover =
        text((item?.album as { picUrl?: unknown } | undefined)?.picUrl) ??
        text(item?.cover) ??
        text(item?.pic);
    const artists = artistsOf(song);
    return {
        id: searchIdOf(song),
        title,
        en: albumName || '',
        department: '平台搜索',
        category: '平台搜索',
        date: durationOf(song),
        lead: artists || '未知艺术家',
        clearance: 'ONLINE',
        abstract: albumName ? `平台搜索 · ${albumName}` : '平台搜索结果',
        findings: [],
        source: '',
        cover,
        playable: playableOf(song),
    };
};
