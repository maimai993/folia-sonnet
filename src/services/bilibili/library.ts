import { fetchJson, fetchJsonWithHeaders, signedUrl, unwrap } from './api';
import { isBilibiliAvailable } from './transport';

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
}

/** 接口里的地址可能是 http，统一升成 https。 */
const https = (url: string | undefined): string => {
    if (!url) return '';
    return url.startsWith('http://') ? `https://${url.slice('http://'.length)}` : url;
};

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

    const simple = (
        id: string,
        title: string,
        url: string,
        /** 空间那几个要换来源，否则 412。 */
        space = false,
    ): BilibiliShelf => ({
        id,
        title,
        load: async () => {
            const payload = space
                ? unwrap(await fetchJsonWith(url))
                : unwrap(await fetchJson<unknown>(url));
            return listOf(payload).map(toItem).filter(item => item.bvid);
        },
    });

    shelves.push(
        simple('toview', '稍后再看', 'https://api.bilibili.com/x/v2/history/toview'),
        simple('coins', '最近投币的视频', `https://api.bilibili.com/x/space/coin/video?vmid=${uid}&pn=1&ps=30`, true),
        simple('likes', '最近点赞的视频', `https://api.bilibili.com/x/space/like/video?vmid=${uid}&pn=1&ps=30`, true),
        simple('uploads', '我的投稿', await signedUrl('/x/space/wbi/arc/search', {
            mid: uid,
            pn: 1,
            ps: 30,
            order: 'pubdate',
        }), true),
        simple('bangumi', '我的追番', `https://api.bilibili.com/x/space/bangumi/follow/list?type=1&follow_status=0&pn=1&ps=30&vmid=${uid}`, true),
        simple('tv', '我的追剧', `https://api.bilibili.com/x/space/bangumi/follow/list?type=2&follow_status=0&pn=1&ps=30&vmid=${uid}`, true),
    );

    return shelves;
};
