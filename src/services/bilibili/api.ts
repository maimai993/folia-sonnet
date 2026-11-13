import type { BilibiliSearchHit } from '../../types/bilibili';
import { signWbiParams, wbiKeyFromUrl } from './wbi';
import { BRIDGE_UNAVAILABLE_CODE, isBilibiliAvailable, requestBilibiliUrl } from './transport';

// src/services/bilibili/api.ts
//
// bilibili 的三个只读接口：搜索、取详情（拿 cid）、取播放地址。
//
// 搜索与播放地址都要 wbi 签名，密钥从 nav 接口得到、缓存十分钟。播放地址只取画面流
// （DASH 的 video 轨，或者老格式的 durl）：MV 背景里声音永远是歌曲本身，拿音轨只会
// 多一份没用的流量。
//
// 画质要不到时接口会降档返回，所以「要 1080p」不代表拿到的就是 1080p，实际高度跟着
// 结果走。未登录上限是 480p。

const API_BASE = 'https://api.bilibili.com';
const WBI_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12_000;

interface ApiEnvelope<T> {
    code: number;
    message?: string;
    data?: T;
}

export class BilibiliApiError extends Error {
    readonly code: number;

    constructor(code: number, message: string) {
        super(message);
        this.name = 'BilibiliApiError';
        this.code = code;
    }
}

const withTimeout = <T>(task: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BilibiliApiError(-1, 'timeout')), REQUEST_TIMEOUT_MS);
    task.then(
        value => { clearTimeout(timer); resolve(value); },
        error => { clearTimeout(timer); reject(error); },
    );
});

const fetchJson = async <T>(url: string): Promise<ApiEnvelope<T>> => {
    const response = await withTimeout(requestBilibiliUrl(url, { method: 'GET' }));
    if (!response.bodyText) {
        throw new BilibiliApiError(-1, `empty response (${response.status})`);
    }
    try {
        return JSON.parse(response.bodyText) as ApiEnvelope<T>;
    } catch {
        throw new BilibiliApiError(-1, `unreadable response (${response.status})`);
    }
};

const unwrap = <T>(envelope: ApiEnvelope<T>): T => {
    if (envelope.code !== 0) {
        throw new BilibiliApiError(envelope.code, envelope.message || `bilibili error ${envelope.code}`);
    }
    if (envelope.data === undefined) {
        throw new BilibiliApiError(envelope.code, 'empty payload');
    }
    return envelope.data;
};

let wbiKeys: { imgKey: string; subKey: string; fetchedAt: number } | null = null;

interface NavPayload {
    wbi_img?: { img_url?: string; sub_url?: string };
}

/**
 * 取 wbi 密钥并缓存十分钟。
 *
 * 未登录时 nav 的 code 是 -101（不是 0），但 wbi_img 照常下发 —— 所以这里只看
 * data 里有没有密钥，不看 code。把 -101 当失败会让所有请求都发不出去。
 */
const readWbiKeys = async (force: boolean) => {
    if (!force && wbiKeys && Date.now() - wbiKeys.fetchedAt < WBI_TTL_MS) return wbiKeys;
    const nav = await fetchJson<NavPayload>(`${API_BASE}/x/web-interface/nav`);
    const imgUrl = nav.data?.wbi_img?.img_url;
    const subUrl = nav.data?.wbi_img?.sub_url;
    if (!imgUrl || !subUrl) {
        throw new BilibiliApiError(nav.code, nav.message || 'missing wbi keys');
    }
    wbiKeys = { imgKey: wbiKeyFromUrl(imgUrl), subKey: wbiKeyFromUrl(subUrl), fetchedAt: Date.now() };
    return wbiKeys;
};

const signedUrl = async (path: string, params: Record<string, string | number>) => {
    const keys = await readWbiKeys(false);
    return `${API_BASE}${path}?${signWbiParams(params, keys.imgKey, keys.subKey)}`;
};

/** 搜索结果是带 `<em class="keyword">` 高亮的 HTML 片段，这里还原成纯文本。 */
export const stripSearchHighlight = (text: string): string => text
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .trim();

const normalizeCoverUrl = (url: string) => {
    if (!url) return '';
    return url.startsWith('//') ? `https:${url}` : url;
};

/** `12:34` / `1:02:03` → 秒。 */
export const parseDurationText = (text: string): number => {
    const parts = text.split(':').map(part => Number.parseInt(part, 10));
    if (parts.some(part => !Number.isFinite(part))) return 0;
    return parts.reduce((total, part) => total * 60 + part, 0);
};

const searchOnce = async (keyword: string, page: number): Promise<BilibiliSearchHit[]> => {
    const url = await signedUrl('/x/web-interface/wbi/search/type', {
        search_type: 'video',
        keyword,
        page,
        page_size: 30,
    });
    const envelope = await fetchJson<{ result?: unknown[] }>(url);
    const result = unwrap(envelope).result;
    if (!Array.isArray(result)) return [];
    return result.flatMap((item): BilibiliSearchHit[] => {
        const row = item as Record<string, unknown>;
        const bvid = typeof row.bvid === 'string' ? row.bvid : '';
        if (!bvid) return [];
        return [{
            bvid,
            title: stripSearchHighlight(typeof row.title === 'string' ? row.title : ''),
            author: typeof row.author === 'string' ? row.author : '',
            durationSec: parseDurationText(typeof row.duration === 'string' ? row.duration : ''),
            coverUrl: normalizeCoverUrl(typeof row.pic === 'string' ? row.pic : ''),
            playCount: typeof row.play === 'number' ? row.play : 0,
        }];
    });
};

/** 搜一批投稿。失败时抛出 BilibiliApiError。 */
export const searchBilibiliVideos = async (
    keyword: string,
    pages = 2,
): Promise<BilibiliSearchHit[]> => {
    if (!isBilibiliAvailable()) {
        throw new BilibiliApiError(BRIDGE_UNAVAILABLE_CODE, 'bilibili requests need the Android app');
    }
    const trimmed = keyword.trim();
    if (!trimmed) return [];
    const all: BilibiliSearchHit[] = [];
    for (let page = 1; page <= pages; page += 1) {
        const hits = await searchOnce(trimmed, page);
        all.push(...hits);
        // 这一页不够 30 条说明没有下一页了，别再白跑一次。
        if (hits.length < 30) break;
    }
    return all;
};

interface ViewPayload {
    bvid: string;
    title?: string;
    duration?: number;
    owner?: { name?: string };
    /** 封面图；可能是 http，用的时候要升成 https。 */
    pic?: string;
    pages?: Array<{ cid: number; duration?: number }>;
}

/** 推荐接口回来的一条。字段和搜索那边不太一样，所以单独解析。 */
interface RcmdPayload {
    item?: Array<{
        bvid?: string;
        title?: string;
        duration?: number;
        owner?: { name?: string };
        pic?: string;
        stat?: { view?: number };
        /** 直播、番剧、广告位这些也在同一个列表里，用 goto 区分。 */
        goto?: string;
    }>;
}

/**
 * 首页推荐。
 *
 * 登录了就带上 Cookie（transport 走原生 CookieManager），B 站回的是这个人自己的推荐；
 * 没登录它回的是平台默认推荐 —— 两件事用同一个接口，不需要在这里分开写。
 *
 * 只保留普通投稿（goto === 'av'）：列表里混着直播、番剧和广告位，那些没有稳定的
 * bvid / cid，点开也放不了。
 */
export const fetchBilibiliRecommendations = async (): Promise<BilibiliSearchHit[]> => {
    if (!isBilibiliAvailable()) {
        throw new BilibiliApiError(BRIDGE_UNAVAILABLE_CODE, 'bilibili requests need the Android app');
    }
    const url = await signedUrl('/x/web-interface/wbi/index/top/feed/rcmd', {
        fresh_type: 3,
        ps: 20,
    });
    const payload = unwrap(await fetchJson<RcmdPayload>(url));
    return (payload.item ?? [])
        .filter(item => item.goto === 'av' && typeof item.bvid === 'string' && item.bvid.length > 0)
        .map(item => ({
            bvid: item.bvid as string,
            title: stripSearchHighlight(item.title ?? ''),
            author: item.owner?.name ?? '',
            // 推荐接口给的是秒，和搜索那边一致。
            durationSec: item.duration ?? 0,
            coverUrl: toHttps(item.pic),
            playCount: item.stat?.view ?? 0,
        }));
};

/** 图片地址可能是 http（WebView 里会被拦），统一升成 https。 */
const toHttps = (url: string | undefined): string => {
    if (!url) return '';
    return url.startsWith('http://') ? `https://${url.slice('http://'.length)}` : url;
};

/** 取一条投稿的 cid（第一个分 P）与元信息。 */
export const fetchBilibiliVideoInfo = async (bvid: string) => {
    const payload = unwrap(await fetchJson<ViewPayload>(`${API_BASE}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`));
    const page = payload.pages?.[0];
    if (!page || typeof page.cid !== 'number') {
        throw new BilibiliApiError(-404, 'no playable page');
    }
    return {
        bvid: payload.bvid || bvid,
        cid: page.cid,
        title: payload.title ?? '',
        author: payload.owner?.name ?? '',
        durationSec: page.duration ?? payload.duration ?? 0,
        coverUrl: toHttps(payload.pic),
    };
};

interface PlayUrlDash {
    dash?: {
        video?: Array<{
            baseUrl?: string;
            base_url?: string;
            backupUrl?: string[];
            backup_url?: string[];
            height?: number;
            width?: number;
            codecs?: string;
            bandwith?: number;
            bandwidth?: number;
        }>;
        /**
         * 声音轨。bilibili 的 DASH 把画面和声音拆成两条独立的流，
         * 这里单独取声音，播放器直接拿它当音源（见 fetchBilibiliPlayUrl）。
         */
        audio?: Array<{
            baseUrl?: string;
            base_url?: string;
            backupUrl?: string[];
            backup_url?: string[];
            bandwidth?: number;
            bandwith?: number;
        }>;
    };
    durl?: Array<{ url?: string; backup_url?: string[] }>;
}

/**
 * 从 DASH 的画面轨里挑一条最合适的。
 *
 * **优先 H.264（avc1）**：bilibili 现在默认给 HEVC（hev1 / hvc1），而安卓的
 * MediaCodec 与 WebView 对 HEVC 的支持因机型而异 —— 挑到一条播放器解不了的轨，
 * 表现是「MV 一片黑但有声音」。同样编码下取最高的那条。
 *
 * 拿不到 DASH（老投稿或某些清晰度）时退回 durl。
 */
export const pickVideoTrack = (
    payload: PlayUrlDash,
): { url: string; height: number } | null => {
    const videos = payload.dash?.video ?? [];
    if (videos.length > 0) {
        const scored = videos
            .map(video => {
                const url = video.baseUrl || video.base_url || '';
                const codecs = (video.codecs || '').toLowerCase();
                // avc1 / h264 排前面，其它排后面。
                const isAvc = codecs.includes('avc') || codecs.includes('h264');
                return { url, height: video.height ?? 0, isAvc };
            })
            .filter(item => item.url.length > 0);
        if (scored.length > 0) {
            scored.sort((a, b) => {
                if (a.isAvc !== b.isAvc) return a.isAvc ? -1 : 1;
                return b.height - a.height;
            });
            return { url: scored[0].url, height: scored[0].height };
        }
    }
    const fallback = payload.durl?.find(item => typeof item.url === 'string' && item.url.length > 0);
    if (fallback?.url) return { url: fallback.url, height: 0 };
    return null;
};

/** 音质档位 → bilibili 的 qn（清晰度编号）。未登录时高码率那几档会被它自己压到 480。 */
const qualityToQn: Record<string, number> = {
    standard: 64,   // 720P（bilibili 的 64 就是 720P；未登录会落到 32=480P）
    high: 80,       // 1080P
    ultra: 112,     // 1080P+
    lossless: 116,  // 1080P60
    hires: 120,     // 4K
};

/**
 * 取一条投稿的画面直链与声音直链。
 *
 * bilibili 的 DASH 本来就把画面和声音拆成两条流。以前只取画面、声音还是歌曲本身，
 * 于是要一套「音画偏移」去对两者。现在把**声音也拿过来**：播放器直接放这条音频，
 * 视频只负责画面 —— 两端同源，天生同步，进度条、歌词、可视化全都照旧走播放器。
 *
 * 拿不到独立音轨时（老投稿只有 durl）返回的 audioUrl 为空，调用方退回用歌曲发声。
 */
export const fetchBilibiliPlayUrl = async (
    bvid: string,
    cid: number,
    quality: string = 'standard',
): Promise<{ url: string; height: number; audioUrl: string }> => {
    const url = await signedUrl('/x/player/wbi/playurl', {
        bvid,
        cid,
        qn: qualityToQn[quality] ?? 64,
        fnval: 4048,
        fourk: 1,
    });
    const payload = unwrap(await fetchJson<PlayUrlDash>(url));
    const track = pickVideoTrack(payload);
    if (!track) throw new BilibiliApiError(-404, 'no video stream');
    return { ...track, audioUrl: pickAudioTrack(payload) };
};

/**
 * 从 DASH 里挑一条声音轨：取码率最高的那条。
 *
 * 声音只有一条内容，清晰度差异纯粹是码率，所以不用像画面那样挑编码 ——
 * DASH 的音频在这几个版本里统一是 AAC。
 */
export const pickAudioTrack = (payload: PlayUrlDash): string => {
    const audios = payload.dash?.audio ?? [];
    const scored = audios
        .map(audio => ({
            url: audio.baseUrl || audio.base_url || '',
            bandwidth: audio.bandwidth ?? audio.bandwith ?? 0,
        }))
        .filter(item => item.url.length > 0)
        .sort((a, b) => b.bandwidth - a.bandwidth);
    return scored[0]?.url ?? '';
};
