import type { MediaId, OnlineCatalogProvider, ProviderPage } from '../../types/onlineMusic';
import type { UnifiedSong } from '../../types';
import { feiniuList, feiniuRequest } from './feiniuTransport';
import { feiniuPage, normalizeFeiniuCollection, normalizeFeiniuSong } from './feiniuNormalize';
import { backfillSongCovers, prewarmCollectionCovers, resolveProxiedCollectionCover } from './onlineCoverFallback';

// src/services/onlineMusic/feiniuCatalog.ts
// 歌单 / 专辑 / 歌手的曲目与详情。
// 飞牛没有「按 id 取单个歌单详情」的接口（`/playlist/list` 只给列表），所以详情一律沿用
// 调用方手上那份集合 —— 界面本来就是从某个集合点进去的，那份数据是最新的。

/** 「我喜欢的」是飞牛自己的收藏接口，不是一个真歌单，用这个固定 id 顶替。 */
export const FEINIU_FAVORITE_ID = 'favorite';

/**
 * 「全部歌曲」也是一个伪歌单，走曲目列表接口本身。
 *
 * 不是可有可无的一颗按钮：飞牛的歌单要用户自己建，**一个歌单都没有的人点进
 * 「歌单」看到的是一片空** —— 他的第一反应是「没连上」而不是「我还没建歌单」。
 * 有这一条，连上就有东西。
 */
export const FEINIU_ALL_TRACKS_ID = 'all-tracks';

const songPage = async (
    path: string,
    query: Record<string, string | number | boolean | undefined>,
    limit: number,
    offset: number,
): Promise<ProviderPage<UnifiedSong>> => {
    const { items, total } = await feiniuList<unknown>(path, query, offset, limit);
    // 飞牛的库里常有没嵌封面的文件，这里顺手借一张（有缓存，只补当前页头几首）。
    return feiniuPage(await backfillSongCovers(items.map(normalizeFeiniuSong)), total, offset, limit);
};

export const feiniuCatalog: OnlineCatalogProvider = {
    canResolveSongCatalogRefs: song => song.sourceRef?.kind === 'online' && song.sourceRef.providerId === 'feiniu',
    // 曲目里已经带着 album / artists，不需要再解析一次。
    resolveSongCatalogRefs: async song => song,

    getPlaylistTracks: (id, limit, offset, collection) => {
        const key = String(id);
        if (key === FEINIU_FAVORITE_ID || collection?.isLiked === true) {
            return songPage('/favorite-track/list', {}, limit, offset);
        }
        if (key === FEINIU_ALL_TRACKS_ID) {
            return songPage('/track/list', {}, limit, offset);
        }
        return songPage('/track/playlist-detail/list', { playlistGUID: key }, limit, offset);
    },
    getAlbumTracks: (id, limit = 120, offset = 0) => songPage('/track/album-detail/list', { albumGUID: String(id) }, limit, offset),
    getArtistSongs: (id, limit, offset) => songPage('/track/artist-detail/list', { artistGUID: String(id) }, limit, offset),

    getPlaylistDetail: (_id, collection) => Promise.resolve(collection ?? null),
    getAlbumDetail: (_id, collection) => Promise.resolve(collection ?? null),
    getArtistDetail: () => Promise.resolve(null),

    /**
     * 歌手的专辑。飞牛的 `/album/list` 不带歌手筛选，只能整页取回来在本地筛 ——
     * 而专辑对象里根本不含歌手字段，筛不出来。与其给一份错的，不如不给。
     */
    getArtistAlbums: undefined,

    // 歌单都是用户自己的，谈不上订阅。
    getSubscriptionStatus: () => Promise.resolve(true),
};

/** 专辑列表（首页「专辑」页用），按创建时间倒序取一页。 */
export const feiniuAlbumPage = async (offset: number, limit: number) => {
    const { items, total } = await feiniuList<unknown>('/album/list', {}, offset, limit);
    // 与 feiniuLibrary 的集合列表同一趟：先把这一页封面预热成代理地址（issue #204 的漏网出口）。
    const albums = items.map(item => normalizeFeiniuCollection(item, 'album'));
    await prewarmCollectionCovers(albums.map(item => item.coverUrl));
    return feiniuPage(albums.map(item => ({ ...item, coverUrl: resolveProxiedCollectionCover(item.coverUrl) })), total, offset, limit);
};

/** 歌手列表，同上。 */
export const feiniuArtistPage = async (offset: number, limit: number) => {
    const { items, total } = await feiniuList<unknown>('/artist/list', {}, offset, limit);
    const artists = items.map(item => normalizeFeiniuCollection(item, 'artist'));
    await prewarmCollectionCovers(artists.map(item => item.coverUrl));
    return feiniuPage(artists.map(item => ({ ...item, coverUrl: resolveProxiedCollectionCover(item.coverUrl) })), total, offset, limit);
};

/** 单曲详情（播放前补元数据用）。 */
export const feiniuTrackDetail = async (guid: MediaId) => {
    const data = await feiniuRequest<{ track?: unknown }>('/track/metadata', { query: { guid: String(guid) } });
    const [song] = await backfillSongCovers([normalizeFeiniuSong(data?.track ?? data)], 1);
    return song;
};
