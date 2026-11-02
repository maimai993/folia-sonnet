import type { Artist, UnifiedSong } from '../../types';
import type { JsonValue, ProviderArtistSummary, ProviderCollection, ProviderPage, ProviderUser } from '../../types/onlineMusic';
import { OnlineProviderError } from '../../types/onlineMusic';
import { feiniuCoverUrl } from './feiniuTransport';

// src/services/onlineMusic/feiniuNormalize.ts
// 飞牛返回的曲目 / 歌单 / 专辑 / 歌手 → Folia 的统一模型。
// 飞牛的曲目自带 album 与 artists 两个子对象，不用像酷狗那样再补一次元数据。

export type FeiniuRecord = Record<string, any>;

export const feiniuRecord = (value: unknown): FeiniuRecord => (
    value && typeof value === 'object' && !Array.isArray(value) ? value as FeiniuRecord : {}
);

const text = (value: unknown): string => (value == null ? '' : String(value));

const finite = (value: unknown): number | undefined => {
    // 服务端偶尔把数字字段返回成字符串（releaseDate 尤其常见）。
    if (value == null || value === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
};

const catalogRef = (kind: 'album' | 'artist', id: string) => (
    id ? { providerId: 'feiniu' as const, kind, id } : undefined
);

const artistsOf = (item: FeiniuRecord): Artist[] => (
    (Array.isArray(item.artists) ? item.artists : [])
        .map(artist => feiniuRecord(artist))
        .filter(artist => text(artist.name))
        .map(artist => ({
            id: text(artist.guid),
            name: text(artist.name),
            catalogRef: catalogRef('artist', text(artist.guid)),
        }))
);

/** 已经归一化过（缓存里读出来的）就原样返回，不要二次转换。 */
const isOwnSong = (value: unknown): boolean => (
    feiniuRecord(value).sourceRef?.kind === 'online' && feiniuRecord(value).sourceRef.providerId === 'feiniu'
);

export const normalizeFeiniuSong = (raw: unknown): UnifiedSong => {
    const item = feiniuRecord(raw);
    if (isOwnSong(item)) return item as UnifiedSong;

    const guid = text(item.guid);
    if (!guid) throw new OnlineProviderError('invalid-response', 'FeiNiu track has no guid', 'feiniu');
    const album = feiniuRecord(item.album);
    // 曲目没带封面时退到专辑封面：飞牛大多数曲目的封面其实挂在专辑上。
    const coverId = text(item.coverId || album.coverId) || '';
    const providerData: Record<string, JsonValue> = {};
    if (coverId) providerData.coverId = coverId;
    if (item.isFavorite === true) providerData.isFavorite = true;
    // accessStatus=3 是「音频文件已被删掉」，播不出来，界面该早点说清楚。
    if (Number(item.accessStatus) === 3 || item.isAudioFileDeleted === true) providerData.unavailable = true;

    return {
        id: guid,
        name: text(item.title || item.name) || '未知标题',
        artists: artistsOf(item),
        album: {
            id: text(album.guid),
            name: text(album.name) || '未知专辑',
            coverUrl: feiniuCoverUrl(coverId),
            catalogRef: catalogRef('album', text(album.guid)),
        },
        // 飞牛的 duration 直接就是毫秒。
        durationMs: Math.max(0, finite(item.duration) ?? 0),
        sourceRef: { kind: 'online', providerId: 'feiniu', mediaId: guid, providerData },
    };
};

export const normalizeFeiniuUser = (raw: unknown): ProviderUser => {
    const item = feiniuRecord(raw);
    const user = feiniuRecord(item.user ?? item);
    const guid = text(user.guid || item.guid || item.id);
    return {
        id: guid,
        nickname: text(user.name || item.name || user.nickname) || '飞牛用户',
        avatarUrl: '',
    };
};

const collectionArtists = (item: FeiniuRecord): ProviderArtistSummary[] | undefined => {
    const artists = artistsOf(item);
    return artists.length > 0 ? artists : undefined;
};

export const normalizeFeiniuCollection = (raw: unknown, type = 'playlist'): ProviderCollection => {
    const item = feiniuRecord(raw);
    if (item.providerId === 'feiniu') return item as ProviderCollection;

    const id = text(item.guid || item.id);
    if (!id) throw new OnlineProviderError('invalid-response', 'FeiNiu collection has no guid', 'feiniu');
    const coverId = text(item.coverId) || '';
    // 歌单卡片的封面就靠这一个字段：没有它就拼不出 URL，界面上只剩占位（issue #204）。
    if (!coverId) console.info('[feiniu] 歌单没有 coverId', text(item.name) || id);
    const albumCount = finite(item.albumCount);
    const publishedAt = finite(item.releaseDate);
    const updatedAt = finite(item.updatedAt);

    return {
        providerId: 'feiniu',
        id,
        type,
        name: text(item.name) || (type === 'artist' ? '未知歌手' : type === 'album' ? '未知专辑' : '未知歌单'),
        coverUrl: feiniuCoverUrl(coverId),
        trackCount: finite(item.trackCount) ?? 0,
        ...(albumCount === undefined ? {} : { albumCount }),
        // releaseDate 有时是秒、有时是毫秒：小于 1e12 的按秒补成毫秒。
        ...(publishedAt === undefined ? {} : { publishedAt: publishedAt < 1e12 ? publishedAt * 1000 : publishedAt }),
        ...(updatedAt === undefined ? {} : { updatedAt: updatedAt < 1e12 ? updatedAt * 1000 : updatedAt }),
        ...(collectionArtists(item) ? { artists: collectionArtists(item) } : {}),
        isOwned: true,
        providerData: coverId ? { coverId } : {},
    };
};

export const feiniuPage = <T>(
    items: T[],
    total: number,
    offset: number,
    limit: number,
): ProviderPage<T> => {
    const nextOffset = offset + items.length;
    const knownTotal = Number.isFinite(total) && total > 0;
    return {
        items,
        ...(knownTotal ? { total } : {}),
        nextOffset,
        hasMore: knownTotal ? nextOffset < total : items.length >= limit,
    };
};
