import type { TFunction } from 'i18next';
import type { ProviderCollection } from '../../../types/onlineMusic';
import type { LibraryHomeCard, LibraryHomeRadioFeed } from './homeModel.contract';

// src/library/core/home/homeCards.ts
// 在线首页三个页签的卡片视图模型（纯函数，原样搬自 Grid3D）：账户歌单、收藏专辑、电台（私人 FM、每日推荐、
// 推荐歌单）。卡片的 raw 是打开集合时交给描述工厂的来源对象，形状与原先一致，所以宿主收到的集合描述不变。

/** 电台页签里的私人 FM 卡：点它直接播放，不打开集合。 */
export const PERSONAL_FM_CARD_ID = 'personal_fm';
/** 电台页签里的每日推荐卡。 */
export const DAILY_RECOMMENDATIONS_CARD_ID = 'daily_recommendations';

/** 在线集合卡片上的「作者」：专辑的歌手（逗号连接），没有就用创建者昵称。 */
export const getProviderCollectionArtistLabel = (
    collection: Pick<ProviderCollection, 'artists' | 'creator'> | null | undefined,
): string => {
    const artists = collection?.artists
        ?.map(artist => artist.name.trim())
        .filter(Boolean)
        .join(', ');
    return artists || collection?.creator?.nickname || '';
};

/**
 * 账户歌单页签（含云盘）。
 *
 * `markSourceProvider`：「全部」视图里打开。合并了各家歌单之后，每张卡必须记住自己来自哪家
 * （封面角标、打开歌单取曲目都靠它；见 LibraryHomeCard.sourceProviderId 的注释），默认不开 ——
 * 单平台视图里整屏都是同一家，逐卡带一遍只是噪音。
 */
export const buildOnlinePlaylistCards = (
    collections: readonly ProviderCollection[],
    t: TFunction,
    { markSourceProvider = false }: { markSourceProvider?: boolean } = {},
): LibraryHomeCard[] => (
    collections.map(collection => ({
        id: collection.id,
        name: collection.name,
        coverUrl: collection.coverUrl,
        trackCount: collection.trackCount,
        description: collection.creator?.nickname || t('home.playlists'),
        summary: collection.description || '',
        type: collection.type,
        raw: collection,
        ...(markSourceProvider && collection.providerId ? { sourceProviderId: collection.providerId } : {}),
    }))
);

/**
 * 收藏专辑页签。
 *
 * `markSourceProvider` 与歌单那一份同理：「全部」视图里合进了各家的专辑，得记住各自来自哪家
 * （角标、打开专辑取曲目、卡片 id 去重都靠它）。
 */
export const buildOnlineAlbumCards = (
    albums: readonly ProviderCollection[],
    t: TFunction,
    { markSourceProvider = false }: { markSourceProvider?: boolean } = {},
): LibraryHomeCard[] => (
    albums.map(album => ({
        id: album.id,
        name: album.name,
        coverUrl: album.coverUrl,
        trackCount: album.trackCount,
        description: getProviderCollectionArtistLabel(album) || t('player.unknownArtist'),
        summary: album.description || '',
        type: 'album',
        raw: album,
        ...(markSourceProvider && album.providerId ? { sourceProviderId: album.providerId } : {}),
    }))
);

type RadioSource = {
    id: string | number;
    name: string;
    coverUrl?: string;
    trackCount?: number;
    description?: string;
    summary?: string;
    isFm?: boolean;
    isDailyRecommendations?: boolean;
    /** 「全部」视图里这张推荐歌单来自哪家。 */
    sourceProviderId?: string;
};

/**
 * 电台页签：私人 FM、每日推荐排在推荐歌单前面。私人 FM 卡的描述是当前的 FM 模式（provider 支持模式时），
 * 否则是「私人 FM」。provider 没给 FM 的歌时没有 FM 卡（放不出来的卡不摆出来）。feed 还没读到时为空。
 */
export const buildOnlineRadioCards = (
    feed: LibraryHomeRadioFeed | null,
    {
        t,
        personalFmModeLabel = '',
        markSourceProvider = false,
    }: { t: TFunction; personalFmModeLabel?: string; markSourceProvider?: boolean },
): LibraryHomeCard[] => {
    if (!feed) return [];
    const sources: RadioSource[] = [
        ...(feed.hasPersonalFm === false ? [] : [{
            id: PERSONAL_FM_CARD_ID,
            name: t('home.personalFm'),
            coverUrl: feed.personalFmCoverUrl,
            description: t('home.personalFm'),
            isFm: true,
        }]),
        ...(feed.supportsDailySongs === false ? [] : [{
            id: DAILY_RECOMMENDATIONS_CARD_ID,
            name: t('home.dailyRecommendations'),
            coverUrl: feed.dailyCoverUrl,
            trackCount: feed.dailyCount,
            description: t('home.dailyRecommendationsDescription'),
            summary: t('home.dailyRecommendationsSummary'),
            isDailyRecommendations: true,
        }]),
        ...feed.recommended.map(collection => {
            const description = collection.description || collection.creator?.nickname || '';
            return {
                ...collection,
                isFm: Boolean(collection.personalFm),
                coverUrl: collection.coverUrl,
                description,
                summary: description,
                ...(collection.providerId ? { sourceProviderId: collection.providerId } : {}),
            };
        }),
    ];
    return sources.map(source => ({
        id: source.id,
        name: source.name,
        coverUrl: source.coverUrl,
        trackCount: source.trackCount,
        description: (source.isFm && source.id === PERSONAL_FM_CARD_ID && personalFmModeLabel) || source.description || t('home.radio'),
        summary: source.summary || '',
        type: source.isFm
            ? 'radio'
            : source.isDailyRecommendations
                ? 'daily_recommendations'
                : 'playlist',
        raw: source,
        // 私人 FM 与每日推荐在「全部」视图里各只有一张（各家的内容合进同一张卡），
        // 所以不带角标；只有各家自己的推荐歌单才需要标出来自哪家。
        ...(markSourceProvider && source.sourceProviderId ? { sourceProviderId: source.sourceProviderId } : {}),
    }));
};

/** 这张卡是私人 FM（直接播放，不打开集合）。 */
export const isPersonalFmCard = (card: Pick<LibraryHomeCard, 'id' | 'raw'>): boolean => (
    card.id === PERSONAL_FM_CARD_ID || (card.raw as { id?: unknown } | undefined)?.id === PERSONAL_FM_CARD_ID
    || Boolean((card.raw as ProviderCollection | undefined)?.personalFm)
);

/** 这张卡是 provider 的额外电台（卡片带 personalFm.station）：和私人 FM 一样直接播放，但不是私人 FM 本身。 */
export const isStationCard = (card: Pick<LibraryHomeCard, 'raw'>): boolean => (
    Boolean((card.raw as ProviderCollection | undefined)?.personalFm?.station)
);

/** 打开在线卡片时交给集合描述工厂的对象：来源对象带上卡片的类型（电台里的推荐歌单记作 playlist）。 */
export const onlineCardCollection = (card: LibraryHomeCard): Record<string, unknown> => (
    card.raw
        ? { ...(card.raw as Record<string, unknown>), type: card.type }
        : { ...card }
);
