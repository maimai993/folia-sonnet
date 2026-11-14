import type { BilibiliSearchHit } from '../../types/bilibili';
import { readBilibiliAuthNative } from '../../platform/foliaNative';
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

export const API_BASE = 'https://api.bilibili.com';
const WBI_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12_000;

export interface ApiEnvelope<T> {
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

export const fetchJsonWithHeaders = async <T>(
    url: string,
    headers: Record<string, string>,
): Promise<ApiEnvelope<T>> => {
    const response = await withTimeout(requestBilibiliUrl(url, { method: 'GET', headers }));
    if (!response.bodyText) throw new BilibiliApiError(-1, `empty response (${response.status})`);
    try {
        return JSON.parse(response.bodyText) as ApiEnvelope<T>;
    } catch {
        throw new BilibiliApiError(-1, `unreadable response (${response.status})`);
    }
};

export const fetchJson = async <T>(url: string): Promise<ApiEnvelope<T>> => {
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

export const unwrap = <T>(envelope: ApiEnvelope<T>): T => {
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

export const signedUrl = async (path: string, params: Record<string, string | number>) => {
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

const normalizeHit = (row: Record<string, unknown>): BilibiliSearchHit[] => {
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
};

interface AllV2Block {
    result_type?: string;
    data?: Record<string, unknown>[];
}

/** 从综合搜索的返回里把视频块抽出来（搜索的主路被拒时走这条备用路）。 */
const hitsFromAllV2 = (payload: { result?: AllV2Block[] }): BilibiliSearchHit[] => {
    const blocks = Array.isArray(payload.result) ? payload.result : [];
    const video = blocks.find(block => block.result_type === 'video');
    if (!video || !Array.isArray(video.data)) return [];
    return video.data.flatMap(normalizeHit);
};

const searchOnce = async (keyword: string, page: number): Promise<BilibiliSearchHit[]> => {
    try {
        const url = await signedUrl('/x/web-interface/wbi/search/type', {
            search_type: 'video',
            keyword,
            page,
            page_size: 30,
        });
        const envelope = await fetchJson<{ result?: unknown[] }>(url);
        const result = unwrap(envelope).result;
        if (!Array.isArray(result)) return [];
        return result.flatMap((item): BilibiliSearchHit[] => normalizeHit(item as Record<string, unknown>));
    } catch (error) {
        /*
         * 搜索和取流一样有两条路：wbi 签名版和综合搜索版。
         *
         * wbi 那条对签名挑得很 —— 设备上实测 -412「request was banned」，签名
         * 算得再对也过不去。综合搜索（search/all/v2）不验签名，一次就把视频块
         * 连同番剧、用户等一起给回来，抽出 video 那一块就是同一份结果。
         *
         * 综合搜索没有分页参数（一页就是一批），所以备用路只在第一页走，后面的
         * 页直接空着 —— 大多数搜索用不满一页，先保住「能搜出来」。
         */
        if (page !== 1) return [];
        console.warn('[Bilibili] wbi search rejected, falling back to the all/v2 endpoint', error instanceof BilibiliApiError ? error.code : error);
        const envelope = await fetchJsonWithHeaders<{ result?: AllV2Block[] }>(
            `${API_BASE}/x/web-interface/search/all/v2?keyword=${encodeURIComponent(keyword)}&page=1`,
            { Referer: 'https://search.bilibili.com/', Origin: 'https://search.bilibili.com' },
        );
        return hitsFromAllV2(unwrap(envelope));
    }
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
    pages?: Array<{
        cid: number;
        /** 分P 的名字。单P 投稿这里是空串或者和标题一样。 */
        part?: string;
        duration?: number;
        page?: number;
    }>;
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
/**
 * 站内分区。界面上那一排「番剧 / 国创 / 综艺 / 动画 …」就是它们。
 *
 * `rid` 是分区号，接口认的是它；名字只是给界面用的。
 */
export interface BilibiliZone {
    rid: number;
    /** i18n key：分区名是给人看的，按界面语言取。 */
    titleKey: string;
}

/** 能直接出内容的分区（剩下的两类——番剧与电影——走 bangumi 那一套）。 */
export const BILIBILI_ZONES: BilibiliZone[] = [
    { rid: 1, titleKey: 'zone1' },
    { rid: 3, titleKey: 'zone3' },
    { rid: 4, titleKey: 'zone4' },
    { rid: 5, titleKey: 'zone5' },
    { rid: 36, titleKey: 'zone36' },
    { rid: 155, titleKey: 'zone155' },
    { rid: 160, titleKey: 'zone160' },
    { rid: 119, titleKey: 'zone119' },
    { rid: 129, titleKey: 'zone129' },
    { rid: 181, titleKey: 'zone181' },
    { rid: 188, titleKey: 'zone188' },
    { rid: 211, titleKey: 'zone211' },
    { rid: 217, titleKey: 'zone217' },
    { rid: 223, titleKey: 'zone223' },
    { rid: 234, titleKey: 'zone234' },
];

/**
 * 某个分区里当前在推什么。
 *
 * 走的是首页推荐那一条接口，带上 `rid` 就变成「这个分区的推荐」——
 * 比排行榜那条宽容：排行榜对多数分区回 -352，这条不会。
 */
export const fetchBilibiliZoneFeed = async (rid: number, ps = 20): Promise<BilibiliSearchHit[]> => {
    if (!isBilibiliAvailable()) {
        throw new BilibiliApiError(BRIDGE_UNAVAILABLE_CODE, 'bilibili requests need the Android app');
    }
    const url = await signedUrl('/x/web-interface/wbi/index/top/feed/rcmd', { rid, ps });
    const payload = unwrap(await fetchJson<RcmdPayload>(url));
    return (payload.item ?? [])
        .filter(item => item.goto === 'av' && typeof item.bvid === 'string' && item.bvid.length > 0)
        .map(item => ({
            bvid: item.bvid as string,
            title: stripSearchHighlight(item.title ?? ''),
            author: item.owner?.name ?? '',
            durationSec: item.duration ?? 0,
            coverUrl: toHttps(item.pic),
            playCount: item.stat?.view ?? 0,
        }));
};

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
/** 补成完整的 https。`//host/path` 这种协议相对写法也要认（搜索接口就是这么给的）。 */
const toHttps = (url: string | undefined): string => {
    if (!url) return '';
    if (url.startsWith('//')) return `https:${url}`;
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

/**
 * 这条投稿的所有分P。
 *
 * 多P 投稿（一整季的番、一整套教程）在 B 站是一串分P，各自有 cid 和自己的名字，
 * 播放地址也各是各的 —— 所以「一集」在这里就是一首歌，整条投稿是一个歌单。
 * 单P 投稿回一条，调用方据此决定要不要显示成歌单。
 */
export const fetchBilibiliPages = async (
    bvid: string,
): Promise<Array<{ cid: number; title: string; durationSec: number; index: number }>> => {
    const payload = unwrap(await fetchJson<ViewPayload>(`${API_BASE}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`));
    const pages = payload.pages ?? [];
    return pages
        .filter(page => typeof page.cid === 'number')
        .map((page, index) => ({
            cid: page.cid,
            // 单P 投稿的 part 常常是空的，用总标题兜底。
            title: (page.part ?? '').trim() || payload.title || '',
            durationSec: page.duration ?? 0,
            index: page.page ?? index + 1,
        }));
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
    /**
     * 字幕。
     *
     * 只有登录了才有内容，而且 UP 主可以一个都不上传 —— 所以这里随时可能是空的，
     * 空就是「这条视频没有字幕」，不是出错。
     */
    subtitle?: {
        subtitles?: PlayUrlSubtitle[];
    };
}

/** 一条字幕轨：哪个语言、界面叫什么、文件在哪。 */
export interface PlayUrlSubtitle {
    /** 语言代码：ai-zh 是自动生成的中文，zh-CN / zh-Hans 是 UP 主上传的。 */
    lan?: string;
    /** 这个语言在界面上叫什么（「中文（自动生成）」之类）。 */
    lan_doc?: string;
    /** 字幕文件的地址，JSON。协议相对地址，前面要补 https:。 */
    subtitle_url?: string;
}

/**
 * 这条投稿有哪些字幕轨。
 *
 * 字幕**不在取流那一次响应里** —— `playurl` 的 subtitle 字段永远是空的，
 * 得单独问 `x/player/v2`（它才是播放器页面拿字幕的地方）。而且只有登录了才给：
 * 未登录时这里回的是一张空表。
 */
export const fetchBilibiliSubtitles = async (
    bvid: string,
    cid: number,
): Promise<PlayUrlSubtitle[]> => {
    const payload = unwrap(await fetchJson<{
        subtitle?: { subtitles?: PlayUrlSubtitle[] };
    }>(`https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${cid}`));
    return payload.subtitle?.subtitles ?? [];
};

/** 字幕文件里的 `body` 是一条条带时间的句子。 */
interface SubtitleBody {
    body?: Array<{ from?: number; to?: number; content?: string }>;
}

/**
 * 取一条字幕的内容。
 *
 * 字幕地址不是 bilibili 的接口，是它 CDN 上的一个**裸 JSON 文件**（没有 code/message
 * 那层信封），所以这里不能用 `unwrap`。地址还常常是协议相对的（`//aisubtitle...`），
 * 不补 `https:` 在 WebView 里会被当成相对路径。
 */
export const fetchBilibiliSubtitle = async (
    subtitleUrl: string,
): Promise<Array<{ from?: number; to?: number; content?: string }>> => {
    const absolute = subtitleUrl.startsWith('//') ? `https:${subtitleUrl}` : subtitleUrl;
    const response = await requestBilibiliUrl(absolute, { method: 'GET' });
    if (!response.ok) {
        throw new BilibiliApiError(response.status, 'subtitle file not readable');
    }
    try {
        const body = JSON.parse(response.bodyText) as SubtitleBody;
        return Array.isArray(body?.body) ? body.body : [];
    } catch {
        // 有时候会拿到一大段 HTML（被拦住时），当成「没有字幕」比抛错好。
        return [];
    }
};

/**
 * 从 DASH 的画面轨里挑一条最合适的。
 *
 * **优先 H.264（avc1）**：bilibili 现在默认给 HEVC（hev1 / hvc1），而安卓的
 * MediaCodec 与 WebView 对 HEVC 的支持因机型而异 —— 挑到一条播放器解不了的轨，
 * 表现是「MV 一片黑但有声音」。同样编码下取最高的那条。
 *
 * 拿不到 DASH（老投稿或某些清晰度）时退回 durl。
 */
/**
 * 档位对应的画面高度上限。
 *
 * 这些是「这一档最多给到多高」，不是请求参数 —— 接口回什么由它自己定（会员、投稿本身
 * 有没有 4K、风控都可能改），真正挑哪一条在这里定。
 */
const qualityMaxHeight: Record<string, number> = {
    standard: 720,
    high: 1080,
    ultra: 1080,
    lossless: 1080,
    hires: 2160,
};

/**
 * 从 DASH 里挑一条画面轨。
 *
 * quality 是用户选的档位，必须参与挑轨：以前这里只按 height 从高到低排，接口一旦
 * 把 4K 也回下来（fnval 要了全部格式、fourk 又开着），不管用户选的是哪一档都拿 4K
 * —— 手机上就是又糊又卡，甚至直接放不动。现在的规则是「不超过这一档上限的最高那条」。
 */
export const pickVideoTrack = (
    payload: PlayUrlDash,
    quality: string = 'standard',
): { url: string; height: number; urls: string[] } | null => {
    const videos = payload.dash?.video ?? [];
    if (videos.length > 0) {
        const scored = videos
            .map(video => {
                const url = video.baseUrl || video.base_url || '';
                const codecs = (video.codecs || '').toLowerCase();
                // avc1 / h264 排前面，其它排后面。
                const isAvc = codecs.includes('avc') || codecs.includes('h264');
                // 同一条流给的备用地址：主地址那台回 403 时换它们。
                const urls = [url, ...(video.backupUrl ?? video.backup_url ?? [])]
                    .filter(item => item.length > 0);
                return { url, urls, height: video.height ?? 0, isAvc };
            })
            .filter(item => item.url.length > 0);
        if (scored.length > 0) {
            /*
             * 先按档位筛出「这一档允许的」，再在里面挑最高的一条。
             *
             * 一档都不符合（比如投稿本身就是 480，而用户要 1080）时退回全部候选：
             * 能放总比什么都没有好。
             */
            const cap = qualityMaxHeight[quality] ?? qualityMaxHeight.standard;
            const withinCap = scored.filter(item => item.height <= cap);
            const pool = withinCap.length > 0 ? withinCap : scored;
            pool.sort((a, b) => {
                if (a.isAvc !== b.isAvc) return a.isAvc ? -1 : 1;
                return b.height - a.height;
            });
            return { url: pool[0].url, urls: pool[0].urls, height: pool[0].height };
        }
    }
    const fallback = payload.durl?.find(item => typeof item.url === 'string' && item.url.length > 0);
    if (fallback?.url) return { url: fallback.url, urls: [fallback.url], height: 0 };
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
/**
 * 当前登录的人是谁。
 *
 * `nav` 是唯一一个「登录了就有昵称和头像」的接口；没登录时它回 isLogin=false。
 * 大会员状态也在这里（vipStatus），清晰度那一栏据此说明是哪一档。
 */
export const fetchBilibiliNavProfile = async (): Promise<{
    signedIn: boolean;
    uid: string;
    nickname: string;
    avatarUrl: string;
    vip: boolean;
} | null> => {
    if (!isBilibiliAvailable()) return null;
    try {
        const payload = unwrap(await fetchJson<{
            isLogin?: boolean;
            mid?: number;
            uname?: string;
            face?: string;
            vipStatus?: number;
        }>('https://api.bilibili.com/x/web-interface/nav'));
        return {
            signedIn: payload.isLogin === true,
            uid: payload.mid ? String(payload.mid) : '',
            nickname: payload.uname ?? '',
            avatarUrl: toHttps(payload.face),
            vip: (payload.vipStatus ?? 0) === 1,
        };
    } catch {
        return null;
    }
};

/**
 * 当前有没有登录。
 *
 * 读的是本机 cookie，不联网，很便宜；仍然记一小会儿 —— 取流是按首歌调的，一次播放
 * 会问很多遍。登录 / 登出会走 clearCookies / setCookies，那时清掉即可，所以这个缓存
 * 卡不住状态。
 */
let signedInCache: { value: boolean; at: number } | null = null;
const SIGNED_IN_TTL_MS = 5_000;

export const isBilibiliSignedIn = async (): Promise<boolean> => {
    const now = Date.now();
    if (signedInCache && now - signedInCache.at < SIGNED_IN_TTL_MS) return signedInCache.value;
    let value = false;
    try {
        value = Boolean((await readBilibiliAuthNative())?.signedIn);
    } catch {
        // 问不到就当成没登录：那样只是少要几个高清格式，不会出错。
    }
    signedInCache = { value, at: now };
    return value;
};

/** 登录态变了（写入 / 清掉 cookie）之后调一下。 */
export const forgetBilibiliSignedIn = (): void => {
    signedInCache = null;
};

export const fetchBilibiliPlayUrl = async (
    bvid: string,
    cid: number,
    quality: string = 'standard',
): Promise<{
    url: string;
    height: number;
    /** 画面的候选地址（主地址在前）。 */
    urls: string[];
    audioUrl: string;
    /** 声音的候选地址（主地址在前）。 */
    audioUrls: string[];
    subtitles: PlayUrlSubtitle[];
}> => {
    /*
     * 要哪些格式，跟着档位走。
     *
     * nval 是位掩码：以前固定写 4048，等于把 8K、杜比视界、AV1、AI 插帧全要了一遍。
     * 这些格式**即使最后一条都不用**也会把候选列表撑大，而且一旦挑中 AV1，低端机上解码
     * 直接卡成幻灯片 —— 用户报的「又糊又特别卡」就是这个。现在按档位只放开需要的：
     * 基础档只要 mp4 + dash；1080P 起才加 HDR / 4K；4K 档才开始考虑 AV1。
     *
     * ourk 同理：只要没选到 4K 档就不开。
     */
    /*
     * 没登录时最高只到 480P。
     *
     * 这不是我们设的限 —— 站内对未登录给的本来就只有这些，问 1080P 也不会给。
     * 所以档位在这里先压下去：否则请求里带着高清参数、回来的却是 480P 的流，
     * 挑轨那一步会以为「没找到要的清晰度」，白绕一圈。
     *
     * 登录之后仍然按用户选的那一档（默认 720P，见 pickBilibiliQuality）。
     */
    const signedIn = await isBilibiliSignedIn();
    const effectiveQuality = signedIn ? quality : 'standard';
    const wants4k = (qualityMaxHeight[effectiveQuality] ?? 720) > 1080;
    const fnval = wants4k ? 4048 : 2 + 1 + 4; // dash + mp4 + hdr（2=dash, 1=mp4, 4=hdr）
    const qn = qualityToQn[quality] ?? 64;
    /*
     * 取流有两条路：wbi 签名版和老的普通版。
     *
     * wbi 那条是「正路」，但它的签名校验对客户端挑得很：签名稍有出入（buvid 对不上、
     * key 换了没跟住）就回 -400「请求错误」，而且**不管怎么重算签名都过不去** ——
     * 这不是我们算错，是站方对这一跳的校验收得比文档说的严。
     *
     * 老接口没有这层校验，实测在设备上直接给流（durl 模式，最高 720P）。所以先走
     * wbi，一旦它拿 -400 就退到老接口：有流可比什么都没有强得多。字幕只有 wbi
     * 那份会带，退路里就空着 —— 歌词优先的默认设置下用户看到的还是歌词。
     */
    let payload: PlayUrlDash;
    try {
        const url = await signedUrl('/x/player/wbi/playurl', {
            bvid,
            cid,
            qn,
            fnval,
            fourk: wants4k ? 1 : 0,
        });
        payload = unwrap(await fetchJson<PlayUrlDash>(url));
    } catch (error) {
        const code = error instanceof BilibiliApiError ? error.code : -1;
        if (code !== -400 && code !== -403) throw error;
        console.warn('[Bilibili] wbi playurl rejected, falling back to the plain endpoint', code);
        const fallbackUrl = `${API_BASE}/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}`
            + `&qn=${qn}&platform=html5&high_quality=1`;
        payload = unwrap(await fetchJson<PlayUrlDash>(fallbackUrl));
    }
    const track = pickVideoTrack(payload, effectiveQuality);
    if (!track) throw new BilibiliApiError(-404, 'no video stream');
    // 字幕跟着取流一起回来：它和 playurl 是同一次请求，单独再要一遍是白跑。
    // 备用地址一起带回去：CDN 的一台节点回 403 时，原生中转靠它换下一台。
    return {
        ...track,
        audioUrl: pickAudioTrack(payload),
        audioUrls: pickAudioCandidates(payload),
        subtitles: payload.subtitle?.subtitles ?? [],
    };
};

/**
 * 从 DASH 里挑一条声音轨：取码率最高的那条。
 *
 * 声音只有一条内容，清晰度差异纯粹是码率，所以不用像画面那样挑编码 ——
 * DASH 的音频在这几个版本里统一是 AAC。
 */
/**
 * 声音的全部候选地址，码率高的在前。
 *
 * 第一条给 `getAudioSource` 用；整串交给原生中转 —— 这一站的 CDN 是一组节点，
 * 有些节点对特定投稿回 403，换一台就好。
 */
export const pickAudioCandidates = (payload: PlayUrlDash): string[] => {
    const audios = payload.dash?.audio ?? [];
    return audios
        .map(audio => ({
            urls: [audio.baseUrl || audio.base_url || '', ...(audio.backupUrl ?? audio.backup_url ?? [])]
                .filter(url => url.length > 0),
            bandwidth: audio.bandwidth ?? audio.bandwith ?? 0,
        }))
        .filter(item => item.urls.length > 0)
        .sort((a, b) => b.bandwidth - a.bandwidth)
        .flatMap(item => item.urls);
};

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
