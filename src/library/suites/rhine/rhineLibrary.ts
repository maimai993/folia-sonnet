import type { LibraryHomeSurfaceProps } from '../../core/suite/suite.contract';
import type { RhineShelfAlbum, RhineShelfLibrary } from './rhineShelf';
import { omni } from '../../../services/onlineMusic/omni';

// src/library/suites/rhine/rhineLibrary.ts
// 把 Folia 的曲库转成三维架子认识的形状。
//
// **关键语义**（照 RhineDroid 的 archiveColumns）：`columns` 每一列是一个歌单，
// 列里放的是该歌单的每一首歌。渲染器按列摆盒子 —— 「一排 = 一个歌单，列内是该歌单的歌」。
//
// 两个必须守住的约束（否则会出现「每排都一样、同一位置都发光」）：
//   1. **列数要够**。`ShelfLayout.cells` 用 `floorMod(lane + dx, columns.size)` 取列，
//      给的列少于固定列数（7）时它会循环复用同一列 → 整面墙都是同一个歌单。
//   2. **必须用 realistic 模式**。`filled` 模式会把曲目 `floorMod` 循环铺满整列，
//      于是每列同一行都是同一首歌，选中高亮也跟着出现在每一列。这条由调用方发
//      `scene-array: realistic` 保证。

/** 渲染器固定的**显示**列数（`ShelfLayout.COLUMNS`）。数据不足要补空列，不能让取模复用。 */
export const SHELF_COLUMNS = 7;
/** 渲染器一列的物理容量（`ShelfLayout.ROWS`）。详情页用它铺满。 */
const LANE_ROWS = 31;
/**
 * 主架子每列显示几格：第 1 格是歌单名，后面 8 首。
 * 用户明确要回到这个规模 —— 一屏能同时看到多个歌单，比塞满一列好看。
 */
const MAIN_LANE_ROWS = 17;
const TRACKS_PER_LANE = MAIN_LANE_ROWS - 1;
/** 每个歌单最多取几首（一列放不下会续到下一列）。 */
const MAX_TRACKS_PER_COLLECTION = 30;
/** 最多取几个歌单。渲染器支持 columns 多于显示列数，左右滑动能看到后面的。 */
const MAX_LANES = 10;

export type AlbumSource = {
    title: string;
    coverUrl?: string;
    /** 原始曲目对象（点中后交给播放用）。 */
    raw?: unknown;
};

export type RhineLibraryBuild = {
    library: RhineShelfLibrary;
    /** 与 library.albums 同序，供取封面用。 */
    sources: AlbumSource[];
    /** 二维列：每列一个歌单；不足 SHELF_COLUMNS 时补空列。 */
    columns: string[][];
    /** `device-album-<n>` → 原始曲目对象，点中后要拿它去播放。 */
    songsById: Record<string, unknown>;
    /** `device-album-<n>` → 它属于哪个歌单（歌单 id）。 */
    albumToCollection: Record<string, string>;
    /**
     * 哪些格子是**歌单名格**（不是歌曲）。
     *
     * 点歌单名 → 进这个歌单的详情；点歌曲 → 只选中它并露出播放按钮。
     * 两种格子在 `columns` 里长得一样，必须靠这张表区分。
     */
    collectionHeaders: Record<string, true>;
    /** 歌单 id → 详情页的列（这个歌单的全部歌曲，不含歌单名格）。 */
    detailColumns: Record<string, string[][]>;
    /** 曲库为空、架上摆的是占位盒。调用方据此显示登录引导。 */
    isPlaceholder: boolean;
};

/** 完全没曲库时的占位：一列九格，证明渲染链路通。 */
const placeholderBoard = (): { albums: RhineShelfAlbum[]; sources: AlbumSource[]; columns: string[][] } => {
    const albums: RhineShelfAlbum[] = [];
    const sources: AlbumSource[] = [];
    const firstLane: string[] = [];
    for (let index = 0; index < TRACKS_PER_LANE; index += 1) {
        const id = `device-album-${index}`;
        const label = String(index + 1).padStart(2, '0');
        albums.push({ id, title: label, coverVersion: 0 });
        sources.push({ title: label });
        firstLane.push(id);
    }
    const columns: string[][] = [firstLane];
    while (columns.length < SHELF_COLUMNS) columns.push([]);
    return { albums, sources, columns };
};

/** 网页首页传已订阅的数据；原生架子仍可直接传宿主资源，保持旧入口兼容。 */
export type RhineCollectionInputs = Pick<LibraryHomeSurfaceProps, 'playlists' | 'cloudPlaylist'> & {
    favoriteAlbums?: LibraryHomeSurfaceProps['playlists'];
    homeResources?: Pick<LibraryHomeSurfaceProps['homeResources'], 'favoriteAlbums'>;
};

export const collectCollections = (props: RhineCollectionInputs) => {
    const out: { collection: unknown; id: string; name: string }[] = [];
    const seen = new Set<string>();
    const push = (collection: { id?: unknown; name?: unknown } | null | undefined): void => {
        if (!collection) return;
        const id = String(collection.id ?? '');
        if (!id || seen.has(id)) return;
        seen.add(id);
        out.push({ collection, id, name: String(collection.name ?? '') });
    };
    for (const collection of props.playlists ?? []) push(collection);
    push(props.cloudPlaylist ?? null);
    const favorites = props.favoriteAlbums ?? props.homeResources?.favoriteAlbums?.getSnapshot?.().data;
    if (Array.isArray(favorites)) for (const collection of favorites) push(collection);
    return out.slice(0, MAX_LANES);
};

/**
 * 取一个歌单的前几首曲目。走 omni 的统一入口（`OmniCollection` 就是 `ProviderCollection`）。
 * 单个歌单取不到就当它为空 —— 不能让一个失败把整面墙弄没。
 */
const readTracks = async (collection: unknown, fallbackTitle: string): Promise<AlbumSource[]> => {
    try {
        const page = await omni.getCollectionTracks(
            collection as never,
            { limit: MAX_TRACKS_PER_COLLECTION, offset: 0 } as never,
        );
        const items = (page as { items?: unknown[] } | null)?.items ?? [];
        return items.slice(0, MAX_TRACKS_PER_COLLECTION).map((item, index) => {
            const song = item as {
                name?: unknown;
                album?: { coverUrl?: unknown; picUrl?: unknown; artworkUrl?: unknown };
                coverUrl?: unknown;
            };
            // 封面挂在 album 上（SongResult.album），不是 song 顶层 —— 之前取错字段所以没封面。
            const album = song.album ?? {};
            const candidate = [album.coverUrl, album.picUrl, album.artworkUrl, song.coverUrl]
                .find(value => typeof value === 'string' && value.length > 0);
            return {
                title: String(song.name ?? fallbackTitle ?? `#${index + 1}`),
                coverUrl: typeof candidate === 'string' ? candidate : undefined,
                raw: item,
            };
        });
    } catch (error) {
        console.warn('[rhine] 取歌单曲目失败', fallbackTitle, error);
        return [];
    }
};

/** 组装原生架子要的曲库：每个歌单成一列，列内是该歌单的曲目；列数补到 SHELF_COLUMNS。 */
export const buildRhineLibrary = async (props: LibraryHomeSurfaceProps): Promise<RhineLibraryBuild> => {
    const entries = collectCollections(props);
    const lanes = await Promise.all(entries.map(entry => readTracks(entry.collection, entry.name)));
    const collectionTitles = entries.map(entry => entry.name);

    const albums: RhineShelfAlbum[] = [];
    const sources: AlbumSource[] = [];
    const columns: string[][] = [];
    const songsById: Record<string, unknown> = {};
    const albumToCollection: Record<string, string> = {};
    const collectionHeaders: Record<string, true> = {};
    const detailColumns: Record<string, string[][]> = {};
    let counter = 0;

    entries.forEach((entry, laneIndex) => {
        const tracks = lanes[laneIndex];
        if (!tracks.length) return;
        const collectionName = entry.name || '歌单';

        // 这个歌单的全部曲目都进 albums（详情页要用），但主架子只显示前 8 首。
        const allIds: string[] = [];
        for (const track of tracks) {
            const id = `device-album-${counter}`;
            counter += 1;
            allIds.push(id);
            albums.push({ id, title: track.title.slice(0, 12), coverVersion: 0 });
            sources.push(track);
            if (track.raw) songsById[id] = track.raw;
            albumToCollection[id] = entry.id;
        }

        // 歌单名放在**数组末尾**：渲染器的 dz 是负值在前，末位在画面上落在最前面。
        const headerId = `device-album-${counter}`;
        counter += 1;
        albums.push({ id: headerId, title: collectionName.slice(0, 12), coverVersion: 0 });
        sources.push({ title: collectionName });
        albumToCollection[headerId] = entry.id;
        collectionHeaders[headerId] = true;
        columns.push([...allIds.slice(0, TRACKS_PER_LANE), headerId]);

        /*
         * 详情页：这个歌单的全部歌曲铺成若干列（不带歌单名格），一列放满就续列。
         *
         * 按 `MAIN_LANE_ROWS`（17）切而不是 `LANE_ROWS`（31）：渲染器的可视窗口就是
         * 17 格高，一列 31 格的话，选中格居中后上下都会伸出窗口外，
         * 看起来像「只有一行」。
         */
        const detailLanes: string[][] = [];
        for (let start = 0; start < allIds.length; start += MAIN_LANE_ROWS) {
            detailLanes.push(allIds.slice(start, start + MAIN_LANE_ROWS));
        }
        while (detailLanes.length < SHELF_COLUMNS) detailLanes.push([]);
        detailColumns[entry.id] = detailLanes;
    });

    if (!columns.length) {
        const blank = placeholderBoard();
        return {
            library: { albums: blank.albums },
            sources: blank.sources,
            columns: blank.columns,
            songsById: {},
            albumToCollection: {},
            collectionHeaders: {},
            detailColumns: {},
            isPlaceholder: true,
        };
    }

    /*
     * 不补空列、也不循环复制。
     *
     * 补空列会让可视范围里出现「有卡片形状、却点不中」的透明格子；
     * 循环复制则会让左右滑几屏都在看同样的歌单。
     * 直接用真实歌单数，边缘之外干脆没有格子 —— 滑到头就停，行为最直白。
     */

    console.info('[rhine] 曲库组装', { collections: entries.length, lanes: columns.length, albums: albums.length });
    return { library: { albums }, sources, columns, songsById, albumToCollection, collectionHeaders, detailColumns, isPlaceholder: false };
};

/** 收集 `id → 封面 URL`。**不在这里下载** —— 网页层 fetch 在线封面会被 CORS 挡住，
 *  由原生下载并缓存（见 RhineShelfPlugin 的 coverUrls）。 */
export const collectCoverUrls = (
    albums: readonly RhineShelfAlbum[],
    sources: readonly AlbumSource[],
): Record<string, string> => {
    const result: Record<string, string> = {};
    albums.forEach((album, index) => {
        const url = sources[index]?.coverUrl;
        if (typeof url === 'string' && url.startsWith('http')) result[album.id] = url;
    });
    return result;
};
