import { API_BASE, fetchJson, fetchJsonWithHeaders, signedUrl, unwrap, type ApiEnvelope } from './api';
import { isBilibiliAvailable } from './transport';

// src/services/bilibili/bangumi.ts
// 番剧 / 电影 / 国创 / 电视剧：整季当歌单，一集当一首歌。
//
// 这些内容和普通投稿不是一套接口：投稿按 bvid 找，番剧按 season_id 找，
// 取流走的是 PGC 那一套。所以单独一个文件。
//
// 一集一集地放，是因为播放器的全部设施都是围绕「一首歌 = 一段音频」建的：
// 一集有自己独立的时长、标题、进度，把它当成一首歌最省事，也让「下一集」
// 就是播放器的下一首。

/** 这些内容在站内分四类，各有各的 season_type。 */
export type BangumiKind = 'bangumi' | 'movie' | 'guochuang' | 'tv';

/** season_type 的取值；界面上的分类按钮直接用它。 */
const KIND_TO_SEASON_TYPE: Record<BangumiKind, number> = {
    bangumi: 1,
    movie: 2,
    guochuang: 4,
    tv: 5,
};

/** 索引里的一条：一整季（一部番 / 一部电影）。 */
export interface BangumiSeason {
    seasonId: number;
    title: string;
    coverUrl: string;
    /** 已经播了多少集，界面上那句「全 8 话」就是这么来的。 */
    indexShow: string;
    kind: BangumiKind;
    /** 第一集的 ep_id；取分集列表要用它。 */
    firstEpId: number | null;
}

/** 一集。 */
export interface BangumiEpisode {
    epId: number;
    title: string;
    /** 这一集对应的投稿号；普通投稿取流和字幕靠它。番剧分集没有它（空串），取流走 ep_id。 */
    bvid: string;
    cid: number;
    durationSec: number;
    /** 第几集（从 1 开始）。 */
    index: number;
}

interface IndexPayload {
    result?: {
        data?: {
            list?: Array<{
                season_id?: number;
                title?: string;
                cover?: string;
                index_show?: string;
                season_type?: number;
                first_ep?: { ep_id?: number };
            }>;
            total?: number;
        };
    } | Array<unknown>;
}

/** 接口回的图片地址可能是 http，统一升成 https（WebView 会拦 http）。 */
const https = (url: string | undefined): string => {
    if (!url) return '';
    return url.startsWith('http://') ? `https://${url.slice('http://'.length)}` : url;
};

const getJson = async <T>(url: string): Promise<T> => {
    const envelope = await fetchJson<T>(url);
    return unwrap(envelope as ApiEnvelope<T>);
};

/**
 * 列出某一类的作品。
 *
 * 用索引接口而不是搜索接口：搜索接口对这几类有风控（直接回 412），
 * 而索引接口不需要签名、也不需要登录。
 */
export const listBangumiSeasons = async (
    kind: BangumiKind,
    page = 1,
    pageSize = 20,
): Promise<BangumiSeason[]> => {
    if (!isBilibiliAvailable()) return [];
    const seasonType = KIND_TO_SEASON_TYPE[kind];
    const url = 'https://api.bilibili.com/pgc/season/index/result'
        + `?season_type=${seasonType}&page=${page}&pagesize=${pageSize}&type=1`;
    const payload = await getJson<IndexPayload>(url);
    // 这个接口的 data 有两种形状（对象带 data，或直接是数组），都兜住。
    const raw = payload?.result;
    const list = Array.isArray(raw)
        ? (raw as Array<{ season_id?: number; title?: string; cover?: string; index_show?: string; first_ep?: { ep_id?: number } }>)
        : (raw?.data?.list ?? []);
    return list
        .filter(item => typeof item.season_id === 'number')
        .map(item => ({
            seasonId: item.season_id as number,
            title: item.title ?? '',
            coverUrl: https(item.cover),
            indexShow: item.index_show ?? '',
            kind,
            firstEpId: typeof item.first_ep?.ep_id === 'number' ? item.first_ep.ep_id : null,
        }));
};

interface SeasonPayload {
    result?: {
        episodes?: Array<{
            id?: number;
            title?: string;
            long_title?: string;
            bvid?: string;
            cid?: number;
            duration?: number;
        }>;
        /** 有的季把正片放在 main_section 里（电影就是这种）。 */
        main_section?: {
            episodes?: Array<{
                id?: number;
                title?: string;
                long_title?: string;
                bvid?: string;
                cid?: number;
                duration?: number;
            }>;
        };
    };
}

/**
 * 一季里的全部集数。
 *
 * season_id 与 ep_id 两条路都试：接口对其中一条偶尔回空对象，两条都问一次
 * 比挑一条然后失败要好。
 */
/**
 * 按关键词在番剧/电影里找。
 *
 * 搜索接口对这几类有风控（回 412），所以改成拉索引再在本地按标题筛。
 * 索引一页 20 条，翻几页就够覆盖常见的名字；翻太多会慢，而且用户真正想看的
 * 一般就在前面。
 */
export const searchBangumiSeasons = async (
    keyword: string,
    kind: BangumiKind,
    page = 1,
): Promise<BangumiSeason[]> => {
    const trimmed = keyword.trim();
    if (!trimmed) return [];
    const resultType = kind === 'movie' ? 'media_ft' : 'media_bangumi';
    /*
     * 走「一次问全部类型」的那个接口，不按类型分开问。
     *
     * 分开问（`search/type?search_type=media_bangumi`）实测很不可靠：同一个关键词连
     * 打三次，会是「0 条 / 412 / 0 条」这样的组合。而 all/v2 一次就把番剧、影视、
     * 视频、用户全带回来，同一个词稳定出结果 —— 用户看到的「除了视频和用户都搜不到」
     * 就是前者造成的。
     *
     * 两个接口对头部的要求一样：Referer / Origin 必须是站内搜索页，否则按爬虫拦下。
     */
    const payload = await searchAll(trimmed, page);
    const group = (payload.result ?? []).find(entry => entry.result_type === resultType);
    const result = group?.data ?? [];
    return result
        .filter(item => typeof item.season_id === 'number')
        .map(item => {
            // 标题里带高亮标签（<em class="keyword">…</em>），摆到界面上要去掉。
            const title = (item.title ?? '').replace(/<[^>]+>/g, '');
            return {
                seasonId: item.season_id as number,
                title,
                coverUrl: https(item.cover),
                indexShow: item.index_show ?? '',
                kind,
                firstEpId: typeof item.first_ep?.ep_id === 'number' ? item.first_ep.ep_id : null,
            };
        });
};

/**
 * 问一次「全部类型」的搜索，拿回分组之后的结果。
 *
 * 412 是这一站的风控，跟内容无关，隔一会儿再问就好 —— 所以重试一次，两次都挂才
 * 算真的失败（调用方会看到空列表，而不是一个错误）。
 */
const searchAll = async (keyword: string, page: number): Promise<SearchAllPayload> => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const url = await signedUrl('/x/web-interface/wbi/search/all/v2', { keyword, page });
            return unwrap(await fetchJsonWithHeaders<SearchAllPayload>(url, SEARCH_HEADERS));
        } catch (error) {
            lastError = error;
            if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 400));
        }
    }
    /*
     * wbi 版两次都被拒（-412 / -400 这类）时退到不验签名的同名接口。
     *
     * 两个版本返回的是同一份分组结果，差别只在要不要签名；设备上实测 wbi 版
     * 被拦、普通版稳定给全量，所以这里把普通版当保底 —— 番剧/电影分区的搜索
     * 就靠它才有结果。
     */
    const plainUrl = `${API_BASE}/x/web-interface/search/all/v2?keyword=${encodeURIComponent(keyword)}&page=${page}`;
    return unwrap(await fetchJsonWithHeaders<SearchAllPayload>(plainUrl, SEARCH_HEADERS));
};

/** 站内搜索接口认的那个来源；别的值会被风控。 */
const SEARCH_HEADERS: Record<string, string> = {
    Referer: 'https://search.bilibili.com/',
    Origin: 'https://search.bilibili.com',
};

/** all/v2 回来的一条（按类型分组，每组自己的 data）。 */
interface SearchAllPayload {
    result?: Array<{
        result_type?: string;
        data?: SearchTypeItem[];
    }>;
}

/** 组里的一条。番剧/影视那一组用 season_id 认人。 */
interface SearchTypeItem {
    season_id?: number;
    title?: string;
    cover?: string;
    index_show?: string;
    first_ep?: { ep_id?: number };
}

export const listBangumiEpisodes = async (
    seasonId: number,
    firstEpId?: number | null,
): Promise<BangumiEpisode[]> => {
    if (!isBilibiliAvailable()) return [];
    const tries = [`season_id=${seasonId}`];
    if (firstEpId) tries.push(`ep_id=${firstEpId}`);

    for (const query of tries) {
        try {
            const payload = await getJson<SeasonPayload>(
                `https://api.bilibili.com/pgc/view/web/season?${query}`,
            );
            const result = payload?.result;
            const episodes = result?.episodes ?? result?.main_section?.episodes ?? [];
            /*
             * 只要有 cid 就留。以前要求 bvid 也在场 —— 番剧（PGC）的分集**本来就没有
             * bvid**，只有 ep_id + cid，取流走 PGC 的 playurl（ep_id 那条路）；
             * 电影的分集有时才有。这一道过滤把正片番剧全滤光了，用户看到的就是
             * 「点进去一集都没有」。
             */
            const usable = episodes.filter(ep => typeof ep.cid === 'number' && ep.id);
            if (usable.length > 0) {
                return usable.map((ep, index) => ({
                    epId: ep.id ?? index + 1,
                    title: ep.long_title || ep.title || '',
                    bvid: ep.bvid ?? '',
                    cid: ep.cid as number,
                    durationSec: ep.duration ?? 0,
                    index: index + 1,
                }));
            }
        } catch {
            // 这条路不通就试下一条。
        }
    }
    return [];
};
