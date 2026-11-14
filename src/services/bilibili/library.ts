import { fetchBilibiliZoneFeed, fetchJson, fetchJsonWithHeaders, signedUrl, unwrap } from './api';
import { upgradeCoverUrl } from './bilibiliNormalize';
import { isBilibiliAvailable } from './transport';
import { listBangumiEpisodes } from './bangumi';

/** 站内搜索接口认的来源；用 www 会被风控成 412。 */
const SEARCH_HEADERS = {
    Referer: 'https://search.bilibili.com/',
    Origin: 'https://search.bilibili.com',
};

// src/services/bilibili/library.ts
// 账号自己的东西：收藏夹、稍后再看、投稿、追番追剧、投币、点赞。
//
// 这些和「搜出来的视频」不是一类：它们属于这个人，而且多数要登录才有。
// 所以单独一处，谁的界面需要就来取。

/** 一个可以点开的歌单。 */
export interface BilibiliShelf {
    /** 稳定 id，界面用它做 key，也用它回头取曲目。 */
    id: string;
    title: string;
    coverUrl?: string;
    /** 里面有多少条（接口给不出就是 undefined，别瞎编一个 0）。 */
    count?: number;
    /** 取这个歌单里的视频。 */
    load: () => Promise<BilibiliShelfItem[]>;
}

/** 歌单里的一条：能直接当一首歌放。 */
export interface BilibiliShelfItem {
    bvid: string;
    title: string;
    author: string;
    coverUrl: string;
    durationSec: number;
    playCount: number;
    /** 番剧分集的 cid（普通投稿条目没有）；分集取流要用它。 */
    cid?: number;
}

/** 封面地址统一成完整的 https（协议相对的写法这里也会遇到）。 */
const https = (url: string | undefined): string => upgradeCoverUrl(url);

/** 标题里可能带高亮标签，摆到界面上要去掉。 */
const plain = (text: string | undefined): string => (text ?? '').replace(/<[^>]+>/g, '');

/** 换个来源再问一次：空间那几个接口用 www 会被风控（412），得用 space 的。 */
const SPACE_HEADERS = {
    Referer: 'https://space.bilibili.com/',
    Origin: 'https://space.bilibili.com',
};

/** 带空间来源再问一次。 */
const fetchJsonWith = <T>(url: string) => fetchJsonWithHeaders<T>(url, SPACE_HEADERS);

/** 当前登录的 uid；没登录回空串。 */
const readUid = async (): Promise<string> => {
    try {
        const nav = unwrap(await fetchJson<{ isLogin?: boolean; mid?: number }>(
            'https://api.bilibili.com/x/web-interface/nav',
        ));
        return nav.isLogin && nav.mid ? String(nav.mid) : '';
    } catch {
        return '';
    }
};

interface VlistItem {
    bvid?: string;
    aid?: number;
    title?: string;
    author?: string;
    pic?: string;
    length?: string;
    play?: number;
    /** 稍后再看那一条用的是这几个名字。 */
    name?: string;
    cover?: string;
    duration?: number;
    owner?: { name?: string };
}

/** 「12:34」→ 754 秒。接口只有这种字符串形式时才需要它。 */
const parseLength = (length: string | undefined): number => {
    if (!length) return 0;
    const parts = length.split(':').map(part => Number(part));
    if (parts.some(part => !Number.isFinite(part))) return 0;
    return parts.reduce((total, part) => total * 60 + part, 0);
};

const toItem = (raw: VlistItem): BilibiliShelfItem => ({
    bvid: raw.bvid ?? '',
    title: plain(raw.title ?? raw.name),
    author: raw.author ?? raw.owner?.name ?? '',
    coverUrl: https(raw.pic ?? raw.cover),
    durationSec: raw.duration ?? parseLength(raw.length),
    playCount: raw.play ?? 0,
});

/** 从各种形状的响应里把列表抠出来 —— 这几个接口返回的字段名各不相同。 */
const listOf = (data: unknown): VlistItem[] => {
    if (!data) return [];
    if (Array.isArray(data)) return data as VlistItem[];
    const box = data as Record<string, unknown>;
    for (const key of ['list', 'medias', 'item', 'archives', 'vlist']) {
        const value = box[key];
        if (Array.isArray(value)) return value as VlistItem[];
        // `list.vlist` 是投稿那种套了一层的形状。
        if (value && typeof value === 'object') {
            const inner = (value as Record<string, unknown>).vlist;
            if (Array.isArray(inner)) return inner as VlistItem[];
        }
    }
    return [];
};

/**
 * 账号的歌单。
 *
 * 每一个收藏夹单独一个（这是 B 站自己的粒度，合并成一个反而找不到东西）。
 * 没登录时只回空表 —— 这些内容本来就属于某个人。
 */
export const listBilibiliShelves = async (): Promise<BilibiliShelf[]> => {
    if (!isBilibiliAvailable()) return [];
    const uid = await readUid();
    if (!uid) return [];

    const shelves: BilibiliShelf[] = [];

    // 收藏夹：先拿列表，每个收藏夹自己再去要曲目。
    try {
        const folders = unwrap(await fetchJson<{ list?: Array<{ id?: number; title?: string; cover?: string; media_count?: number }> }>(
            `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${uid}`,
        ));
        for (const folder of folders.list ?? []) {
            const folderId = folder.id;
            if (typeof folderId !== 'number') continue;
            shelves.push({
                id: `fav:${folderId}`,
                title: folder.title ?? '',
                coverUrl: https(folder.cover),
                count: folder.media_count,
                load: async () => {
                    const page = unwrap(await fetchJson<{ medias?: VlistItem[] }>(
                        `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${folderId}&pn=1&ps=100&platform=web`,
                    ));
                    return (page.medias ?? []).map(toItem).filter(item => item.bvid);
                },
            });
        }
    } catch {
        // 这个分类取不到就不摆它，别把整个歌单页判成失败。
    }

    /**
     * 一条「点开才去要」的歌单。
     *
     * 取到一次就记着：列列表时要条数、点进去要曲目，是同一份东西，不该问两遍。
     * 条数不填的话列表上那几个歌单一个数字都没有，看着就像空的。
     */
    const simple = (
        id: string,
        title: string,
        url: string,
        /** 空间那几个要换来源，否则 412。 */
        space = false,
    ): BilibiliShelf => {
        let cached: BilibiliShelfItem[] | null = null;
        let inflight: Promise<BilibiliShelfItem[]> | null = null;
        const items = async (): Promise<BilibiliShelfItem[]> => {
            if (cached) return cached;
            if (!inflight) {
                inflight = (async () => {
                    const payload = space
                        ? unwrap(await fetchJsonWith(url))
                        : unwrap(await fetchJson<unknown>(url));
                    const list = listOf(payload).map(toItem).filter(item => item.bvid);
                    cached = list;
                    return list;
                })().catch(error => {
                    // 失败不留缓存，下次点还能重试。
                    inflight = null;
                    throw error;
                });
            }
            return inflight;
        };
        return { id, title, load: items };
    };

    /** 列歌单时把每一条的条数补上：取不到就留空，不编一个 0。 */
    const countOf = async (shelf: BilibiliShelf): Promise<BilibiliShelf> => {
        try {
            shelf.count = (await shelf.load()).length;
        } catch {
            // 这一条取不到就不带数字，列表照常摆。
        }
        return shelf;
    };

    /*
     * 排在最前面的是「推荐」和「我的收藏」。
     *
     * 推荐用的是首页那条流（和探索页同一个接口）：对账号自己来说，这就是「给我推的」。
     * 「我的收藏」是这一站的总收藏 —— 它本身不是一个能翻的列表，站内也是把各个收藏夹
     * 汇总起来看的；这里用同一份收藏夹数据摊平，避免摆一个点进去什么都没有的入口。
     */
    shelves.push({
        id: 'recommend',
        title: 'shelfRecommend',
        coverUrl: undefined,
        load: async () => {
            try {
                const feed = await fetchBilibiliZoneFeed(0, 30);
                return feed
                    .filter(hit => hit.bvid)
                    .map(hit => toItem({
                        bvid: hit.bvid,
                        title: hit.title,
                        author: hit.author,
                        pic: hit.coverUrl,
                        duration: hit.durationSec,
                    }));
            } catch {
                return [];
            }
        },
    });

    /*
     * 「我的收藏」：把上面那些收藏夹摊平成一个入口。
     *
     * 这一站在网页版里也是这么看的（总收藏 = 各收藏夹之和），单独一个能翻的总表
     * 并不存在。做成一个「全部」入口，比一个点进去空空的项好。
     */
    const folderShelfIds = shelves
        .filter(shelf => shelf.id.startsWith('fav:'))
        .map(shelf => shelf.id);
    if (folderShelfIds.length > 0) {
        shelves.splice(1, 0, {
            id: 'favorites',
            title: 'shelfFavorites',
            load: async () => {
                const collected: BilibiliShelfItem[] = [];
                for (const id of folderShelfIds) {
                    const shelf = shelves.find(item => item.id === id);
                    if (!shelf) continue;
                    const items = await shelf.load().catch(() => []);
                    collected.push(...items);
                }
                return collected;
            },
        });
    }

    /*
     * 追番 / 追剧：这两个接口回的是**番剧季**（season_id、标题、封面），不是视频
     * 投稿 —— 以前的 toItem 把它们按视频解析（要 bvid），季条目自然一个都没有，
     * 整个歌单空掉。现在把每一季摊平成它的分集：一部番就是一份「歌」（一集一首），
     * 和「我的收藏」摊平各收藏夹是同一个模式。分集没有 bvid 也能播 —— 取流走
     * ep_id 那条路（bilibiliProvider 的 getAudioSource 按歌的 ep 前缀分派）。
     */
    const followList = async (type: 1 | 2): Promise<BilibiliShelfItem[]> => {
        try {
            const payload = unwrap(await fetchJsonWith<{
                result?: {
                    list?: Array<{
                        season_id?: number;
                        title?: string;
                        cover?: string;
                        season_type?: number;
                        first_ep?: { ep_id?: number };
                    }>;
                };
            }>(`https://api.bilibili.com/x/space/bangumi/follow/list?type=${type}&follow_status=0&pn=1&ps=30&vmid=${uid}`));
            const seasons = payload.result?.list ?? [];
            const collected: BilibiliShelfItem[] = [];
            for (const season of seasons) {
                const seasonId = season.season_id;
                if (typeof seasonId !== 'number') continue;
                const episodes = await listBangumiEpisodes(seasonId, season.first_ep?.ep_id ?? null).catch(() => []);
                for (const episode of episodes) {
                    collected.push({
                        // 分集没有 bvid：给 `ep:<epId>` 占位，getPlaylistTracks 认得出它是番剧分集。
                        bvid: `ep:${episode.epId}`,
                        title: episode.title || season.title || '',
                        // UP 主那一栏放季名 —— 追番列表里「谁的作品」就是哪部番。
                        author: season.title ?? '',
                        coverUrl: https(season.cover),
                        durationSec: episode.durationSec,
                        playCount: 0,
                        cid: episode.cid,
                    });
                }
            }
            return collected;
        } catch {
            return [];
        }
    };

    shelves.push(
        simple('toview', 'shelfToview', 'https://api.bilibili.com/x/v2/history/toview'),
        simple('coins', 'shelfCoins', `https://api.bilibili.com/x/space/coin/video?vmid=${uid}&pn=1&ps=30`, true),
        simple('likes', 'shelfLikes', `https://api.bilibili.com/x/space/like/video?vmid=${uid}&pn=1&ps=30`, true),
        simple('uploads', 'shelfUploads', await signedUrl('/x/space/wbi/arc/search', {
            mid: uid,
            pn: 1,
            ps: 30,
            order: 'pubdate',
        }), true),
        {
            id: 'bangumi',
            title: 'shelfBangumi',
            load: () => followList(1),
        },
        {
            id: 'tv',
            title: 'shelfTv',
            load: () => followList(2),
        },
    );

    // 条数一次问全，而且并着问：它们是同一个账号下的几个小列表。
    return Promise.all(shelves.map(countOf));
};

/** 搜到的一个人。 */
export interface BilibiliUserHit {
    mid: number;
    name: string;
    avatarUrl: string;
    sign: string;
    videoCount: number;
}

/**
 * 按名字搜人。
 *
 * 用的是站内的用户搜索。它和视频搜索一样要 wbi 签名，而且要 search 那个来源的
 * Referer，否则一律 412。
 */
export const searchBilibiliUsers = async (keyword: string): Promise<BilibiliUserHit[]> => {
    if (!isBilibiliAvailable()) return [];
    const trimmed = keyword.trim();
    if (!trimmed) return [];
    try {
        const url = await signedUrl('/x/web-interface/wbi/search/type', {
            search_type: 'bili_user',
            keyword: trimmed,
            page: 1,
        });
        const payload = unwrap(await fetchJsonWithHeaders<{
            result?: Array<{
                mid?: number;
                uname?: string;
                upic?: string;
                usign?: string;
                videos?: number;
            }>;
        }>(url, SEARCH_HEADERS));
        return (payload.result ?? [])
            .filter(item => typeof item.mid === 'number')
            .map(item => ({
                mid: item.mid as number,
                name: plain(item.uname),
                avatarUrl: https(item.upic),
                sign: plain(item.usign),
                videoCount: item.videos ?? 0,
            }));
    } catch {
        return [];
    }
};

/**
 * 某个人名下的投稿。
 *
 * 这是「用户」那一档点开之后的内容：一个人的投稿就是一份歌单。空间那条接口
 * 要 space 的来源，用 www 的会被风控。
 */
export const loadBilibiliUserUploads = async (mid: string): Promise<BilibiliShelfItem[]> => {
    if (!isBilibiliAvailable()) return [];
    try {
        const url = await signedUrl('/x/space/wbi/arc/search', {
            mid,
            pn: 1,
            ps: 50,
            order: 'pubdate',
        });
        /*
         * 空间接口必须带空间的 Referer / Origin，否则回 412。
         *
         * 以前这里用的是默认那套头，于是「歌手页 0 首」：请求被拦下，下面的 catch
         * 把异常吞成空数组，界面看到的就是一个真的空歌单。
         */
        const payload = unwrap(await fetchJsonWithHeaders<unknown>(url, SPACE_HEADERS));
        return listOf(payload).map(toItem).filter(item => item.bvid);
    } catch (error) {
        console.warn('[Bilibili] User uploads failed', error);
        return [];
    }
};

/** 一个人的资料（歌手页的表头）。 */
export interface BilibiliUserProfile {
    mid: string;
    name: string;
    avatarUrl: string;
    sign: string;
    followerCount: number;
}

/**
 * 某个 UP 主的资料。
 *
 * 空间那条接口一次给全：名字、头像、签名、粉丝数。拿不到就回 null，
 * 歌手页退回用搜索时那点信息（名字和头像已经有了）。
 */
export const fetchBilibiliUserProfile = async (mid: string): Promise<BilibiliUserProfile | null> => {
    if (!isBilibiliAvailable() || !mid) return null;
    try {
        const payload = unwrap(await fetchJsonWith<{
            card?: { name?: string; face?: string; sign?: string; fans?: number };
        }>(`https://api.bilibili.com/x/web-interface/card?mid=${mid}`));
        const card = payload.card;
        if (!card) return null;
        return {
            mid,
            name: plain(card.name),
            avatarUrl: https(card.face),
            sign: plain(card.sign),
            followerCount: card.fans ?? 0,
        };
    } catch {
        return null;
    }
};
