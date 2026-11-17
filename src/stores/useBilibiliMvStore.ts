import { create } from 'zustand';
import type { BilibiliMvResolution, BilibiliMvStream, BilibiliSearchHit } from '../types/bilibili';
import {
    BilibiliApiError,
    fetchBilibiliPlayUrl,
    fetchBilibiliVideoInfo,
    searchBilibiliVideos,
} from '../services/bilibili/api';
import { buildSearchKeyword, pickBestMvHit } from '../services/bilibili/mvMatch';
import { pickMvHitWithAi } from '../services/bilibili/aiMvPick';
import { getStoredString, setStoredString } from './storagePrimitives';
import { isAiTargetConfigured } from '../services/aiCompletion';
import { isBilibiliAvailable, proxyBilibiliStream } from '../services/bilibili/transport';
import { warmStreamCache } from '../services/bilibili/streamPrefetch';
import { dropCachedMvMedia, readCachedMvMedia, readMvMediaCacheBytes as mvMediaCacheBytes, writeCachedMvMedia } from '../services/bilibili/mvMediaCache';
import { hasRealLyrics, stripPlaceholderLines } from '../services/bilibili/subtitleFilter';
import { buildLyricsFromCues, pickSubtitleTracks } from '../services/bilibili/bilibiliLyrics';
import { fetchBilibiliSubtitle, type PlayUrlSubtitle } from '../services/bilibili/api';
import type { LyricData } from '../types';

// src/stores/useBilibiliMvStore.ts
//
// 播放页的 B 站 MV 背景：开关状态，以及每首歌解析出来的是哪条 MV。
//
// 一条 MV 的解析要打三次接口（搜索 → 详情取 cid → 取播放地址），所以结果按 songKey
// 缓存起来：同一首歌反复切来切去不会再搜一遍。直链有时效，过期由画面层触发重解析。
//
// 会**提前把下一首也解析好**（prefetchNext）：MV 是铺满整屏的画面，等切歌再搜，
// 屏幕上会先空一两秒再突然出现画面。预取只在开关打开时做，且同一时刻只有一条在飞。
// 上一首的缓存**不丢**：切回来时立刻有画面，用户往回切是很常见的操作。

/** 缓存多久之后允许重新搜（直链过期或用户想看新结果时）。 */
const RESOLUTION_TTL_MS = 30 * 60 * 1000;

/** 开关落盘的键：用户开了 MV 背景，下次进播放页还是开着。 */
const ENABLED_STORAGE_KEY = 'bilibili_mv_enabled';

/*
 * 后台不匹配。
 *
 * 熄屏 / 切到后台时 WebView 的网络与定时器都被系统掐着：匹配跑到一半会停在半路，
 * 回到前台拿到的是一条没下完的地址 —— 画面定格在那儿、声音按播放器自己的时钟走，
 * 用户看到的就是「画面和音频对不上」。所以后台一律不解析（这一单推迟到回前台）；
 * visibilitychange 回到 visible 时，把当前歌强刷一遍 —— 旧的那份缓存视为过期。
 */

/** 「让 AI 判断哪条是 MV」落盘的键。默认开：配了 AI 就该用它。 */
const USE_AI_MATCH_STORAGE_KEY = 'bilibili_mv_use_ai';

/** MV 画面清晰度落盘的键。只对「不是 B 站平台的歌」生效，见 MvVideoQuality。 */
const MV_QUALITY_STORAGE_KEY = 'bilibili_mv_quality';

/**
 * 画面的清晰度档位 —— 和播放器那一行「画质」是**同一套五档**。
 *
 * 以前这里只有三档（standard / high / ultra），而面板写的是五档，于是选 1080P60 或
 * 4K 时被压回 ultra：面板上写着 4K，请求里问的却是 1080P+，画面当然不会变。用户报的
 * 「换了清晰度实际上还是没变」就是这个 —— 两处必须是同一套值。
 *
 * 名字和 api.ts 的 qualityToQn 一一对应：standard 480P / high 720P / ultra 1080P /
 * lossless 1080P60 / hires 4K。真正的解码上限由站方给回来的轨决定（见 pickVideoTrack）。
 */
export type MvVideoQuality = 'standard' | 'high' | 'ultra' | 'lossless' | 'hires';

/** 五档，从低到高。界面按这个顺序摆选项。 */
export const MV_QUALITY_LEVELS: readonly MvVideoQuality[] = ['standard', 'high', 'ultra', 'lossless', 'hires'];

const isMvVideoQuality = (value: unknown): value is MvVideoQuality => (
    value === 'standard' || value === 'high' || value === 'ultra' || value === 'lossless' || value === 'hires'
);

const readStoredUseAi = (): boolean => {
    try {
        const raw = getStoredString(USE_AI_MATCH_STORAGE_KEY, '');
        // 没存过就是默认开。
        return raw === null ? true : raw === '1';
    } catch {
        return true;
    }
};

/**
 * MV 画面要哪一档清晰度。
 *
 * 只在**非 B 站平台**下有意义：B 站自己的投稿取流不受它管（走播放器那套音质偏好），
 * 这里管的是「这首歌不是 B 站的，MV 是另找的一条视频」。默认 standard（720P）：
 * 背景是衬在歌词后面的，1080P 起在手机上解码吃力，也没有肉眼可见的收益。
 */
const readStoredQuality = (): MvVideoQuality => {
    try {
        const raw = getStoredString(MV_QUALITY_STORAGE_KEY, '');
        return isMvVideoQuality(raw) ? raw : 'standard';
    } catch {
        return 'standard';
    }
};

const readStoredEnabled = (): boolean => {
    try {
        return getStoredString(ENABLED_STORAGE_KEY, '') === '1';
    } catch {
        // 读不到就当没开：这是画面，默认安静比默认出声好。
        return false;
    }
};

const writeStoredEnabled = (enabled: boolean) => {
    try {
        setStoredString(ENABLED_STORAGE_KEY, enabled ? '1' : '0');
    } catch {
        // 存不下就只改这一次的状态，不影响用。
    }
};

/** 后台推迟的那一单：回到前台时对它重新解析（强刷 —— 旧缓存视为过期）。 */
let pendingForegroundKey: string | null = null;

/** 后台推迟的那一单的参数，回前台原样重放。 */
let pendingForegroundRequest: { title: string; artist: string; durationSec: number } | null = null;

interface CachedResolution extends BilibiliMvResolution {
    /** 解析完成的时间；resolving 时为 0。 */
    resolvedAt: number;
}

interface BilibiliMvState {
    /** 播放页是否把 MV 当背景铺上。 */
    enabled: boolean;
    /** MV 铺上时把歌词动画整个关掉，只留视频。 */
    /** 配了 AI 时，让它判断哪条投稿才是这首歌的 MV（关掉就用打分规则）。 */
    useAiMatch: boolean;
    /** MV 画面清晰度。只对非 B 站平台的歌有意义（见 MvVideoQuality）。 */
    quality: MvVideoQuality;
    /**
     * 被背景样式强制打开（见 visualizer 的 mv 样式）。
     *
     * 和用户那个开关分开记：样式要求「这一款背景必须有画面」，用户那个开关表达
     * 「我愿不愿意用视频」。两者任一成立就开 —— 但只有用户能关他自己那个，
     * 切走这一款背景时也不会把用户的开关改成开。
     */
    forcedByStyle: boolean;
    bySongKey: Record<string, CachedResolution>;
    /** 正在解析的 key，防止同一首并发触发多次搜索。 */
    inflight: Record<string, true>;
    /**
     * 用户从搜索结果里手动挑的那条：songKey → bvid。
     *
     * 挑过之后这首歌就放这一条，不再自动匹配（否则下一次解析又会被搜索结果盖掉）。
     * 点「重新匹配」清掉它，回到自动。
     */
}

/**
 * 匹配结果落盘（存储页能看见、能清）。
 *
 * ★ 只存「匹配到了哪条投稿」，**不存直链**。
 *
 * B 站的播放地址是带签名的，几个小时就过期；把直链落盘再读出来放，画面必然放不出来。
 * 所以这里存的是 bvid / cid / 标题 / 作者 / 时长这些「不随时间变」的部分，下次要放的时候
 * 拿 bvid 重新取一次地址即可（一次请求，比重新搜一遍快得多，也不会换一条投稿）。
 * 手动钉的那条同样是这么存的 —— 用户挑的是哪一支视频，这个选择不该因为重启而丢。
 */
export const MV_CACHE_STORAGE_KEY = 'bilibili_mv_resolutions_v1';

/** 落盘的结果里，这些字段是**不**存的（直链 / 字幕这类会过期或很大的东西）。 */
type StoredMvResolution = {
    songKey: string;
    state: BilibiliMvResolution['state'];
    bvid: string;
    cid: number;
    title: string;
    author: string;
    durationSec: number;
    keyword: string;
    manual: boolean;
    message?: string;
    resolvedAt: number;
};

/** 最多留多少条：一首一条，几百条就是几十 KB，够了不该无限涨。 */
const MAX_STORED_RESOLUTIONS = 300;

/**
 * 落盘的结果多久算过期。
 *
 * 和 lxmusic 那份播放缓存同一套做法（services/onlineMusic/lxmusic/lxmusicProvider.ts）：
 * 读的时候先扔掉过期的，写的时候再裁一遍 —— 存储页那一行的数字才和真正用得上的
 * 那一份对得上，不会把「早就不可能再命中」的记录也算进去。
 *
 * 30 天：这首歌匹配到的是哪条投稿，本来就不会天天变；过一个月还没再放过的，
 * 重新搜一遍也不贵，而且那时的搜索结果可能更准。手动钉的那条**不过期**
 * （用户亲口选的就是这支视频，除非他自己点「重新匹配」）。
 */
const STORED_RESOLUTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 这条落盘记录还算不算数：手动钉的永远算，其余看时间。 */
const isStoredResolutionFresh = (resolution: { manual: boolean; resolvedAt: number }): boolean => (
    resolution.manual || Date.now() - resolution.resolvedAt < STORED_RESOLUTION_TTL_MS
);

const readStoredResolutions = (): Record<string, CachedResolution> => {
    if (typeof window === 'undefined') return {};
    try {
        const raw = getStoredString(MV_CACHE_STORAGE_KEY, '');
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return {};
        const out: Record<string, CachedResolution> = {};
        for (const [key, value] of Object.entries(parsed as Record<string, StoredMvResolution>)) {
            if (!value || typeof value !== 'object' || !value.songKey) continue;
            // 过期的就不再复活（手动钉的那条不过期，见 isStoredResolutionFresh）。
            if (!isStoredResolutionFresh({
                manual: value.manual,
                resolvedAt: Number.isFinite(value.resolvedAt) ? value.resolvedAt : 0,
            })) continue;
            out[key] = {
                state: value.state,
                songKey: value.songKey,
                // stream 里只有「哪条投稿」是真的：直链要重新取，所以这一份是占位。
                stream: value.state === 'ready' && value.bvid
                    ? {
                        bvid: value.bvid,
                        cid: value.cid,
                        title: value.title ?? '',
                        author: value.author ?? '',
                        durationSec: value.durationSec ?? 0,
                        videoUrl: '',
                        audioUrl: '',
                        quality: 0,
                        subtitles: null,
                    }
                    : null,
                keyword: value.keyword ?? '',
                manual: value.manual,
                message: value.message,
                resolvedAt: Number.isFinite(value.resolvedAt) ? value.resolvedAt : 0,
            };
        }
        return out;
    } catch {
        return {};
    }
};

const writeStoredResolutions = (bySongKey: Record<string, CachedResolution>): void => {
    if (typeof window === 'undefined') return;
    try {
        const entries = Object.entries(bySongKey)
            // 只留已经定论的（ready / missing）：「正在解析」不值得存，重启后也没法续。
            .filter(([, resolution]) => resolution.state === 'ready' || resolution.state === 'missing')
            .filter(([, resolution]) => isStoredResolutionFresh(resolution))
            // 新的在前，超出上限就丢最旧的。
            .sort((a, b) => b[1].resolvedAt - a[1].resolvedAt)
            .slice(0, MAX_STORED_RESOLUTIONS);
        const payload: Record<string, StoredMvResolution> = {};
        for (const [key, resolution] of entries) {
            payload[key] = {
                songKey: resolution.songKey,
                state: resolution.state,
                bvid: resolution.stream?.bvid ?? '',
                cid: resolution.stream?.cid ?? 0,
                title: resolution.stream?.title ?? '',
                author: resolution.stream?.author ?? '',
                durationSec: resolution.stream?.durationSec ?? 0,
                keyword: resolution.keyword,
                manual: resolution.manual,
                message: resolution.message,
                resolvedAt: resolution.resolvedAt,
            };
        }
        setStoredString(MV_CACHE_STORAGE_KEY, JSON.stringify(payload));
    } catch {
        // 存不下（配额满）就只留内存里那一份，不影响播放。
    }
};

/**
 * MV 匹配结果这份缓存占了多少字节（存储页那一行用）。
 *
 * 量的是「重启之后还真的会用到的那一份」—— 过期的不算，和写盘时的裁剪规则一致。
 */
export const readMvMatchCacheBytes = (): number => {
    if (typeof window === 'undefined') return 0;
    try {
        return getStoredString(MV_CACHE_STORAGE_KEY, '').length;
    } catch {
        return 0;
    }
};

/**
 * MV 的**音视频字节**缓存占了多少（存储页那一行用）。
 *
 * 与上面那个分开：那个量的是 localStorage 里的匹配记录（几百字节），这个量的是盘上
 * 画面 + 音轨的两个媒体文件（几十兆），量法也不同 —— 要问原生，所以是异步的。
 */
export const readMvMediaCacheBytes = mvMediaCacheBytes;

/**
 * 存储页那两行 MV 缓存用的**平台无关**入口。
 *
 * 设置页不该认识「B 站」这个名字（见 omniArchitecture 那条边界）：它只知道
 * 「有一份 MV 匹配记录」和「有一份 MV 音视频字节」，怎么清、量多少由这个 store 决定。
 * 两行与两个入口一一对应，正好让界面不必 import 这个 store 就能干活。
 */
export const clearMvMatchCache = (): void => {
    useBilibiliMvStore.getState().clear();
};

/** 只清盘上的音视频字节，保留「配了哪条投稿」的记录。 */
export const clearMvMediaCacheBytes = async (): Promise<void> => {
    await useBilibiliMvStore.getState().clearBytesCache();
};

const initialState: BilibiliMvState = {
    enabled: readStoredEnabled(),
    useAiMatch: readStoredUseAi(),
    quality: readStoredQuality(),
    forcedByStyle: false,
    bySongKey: readStoredResolutions(),
    inflight: {},
};

interface BilibiliMvActions {
    setEnabled: (enabled: boolean) => void;
    /** 背景样式要求强制打开（它自己不写用户的开关）。 */
    setForcedByStyle: (forced: boolean) => void;
    setUseAiMatch: (use: boolean) => void;
    setQuality: (quality: MvVideoQuality) => void;
    /**
     * 把某条 BV 直接钉给这首歌当背景（搜索结果里点一条时用）。
     *
     * 它自己解析播放地址并打开开关：用户点的是「看这个视频」，不该还要再回设置里开一次。
     */
    resolveForSong: (
        songKey: string,
        title: string,
        artist: string,
        durationSec?: number,
        force?: boolean,
    ) => Promise<void>;
    /**
     * 提前把下一首解析好。只在开关打开时由播放页调用。
     *
     * 与 resolveForSong 的区别是**失败不写进缓存**：下一首只是可能切过去，
     * 它解析不出来不该在用户真切过去时看到一个「没有找到」的结论。
     */
    prefetchNext: (songKey: string, title: string, artist: string, durationSec?: number) => void;
    /** 把某一首的缓存扔掉，下次会重新搜。 */
    invalidate: (songKey: string) => void;
    /** 清空全部缓存（设置里「重新匹配」用）。 */
    clear: () => void;
    /**
     * 把 MV 的**字节**缓存（音轨 + 画面 + 绑定）整份删掉。
     *
     * 与 [clear] 分开：那个清的是「哪条投稿配哪首歌」（localStorage 里的小记录），
     * 这个清的是盘上几十兆的媒体文件。存储页的「清除缓存」两样一起清，但它不该知道
     * 这份字节缓存是怎么落的 —— 那是这个平台自己的事。
     */
    clearBytesCache: () => Promise<void>;
    /**
     * 用户从搜索结果里手动挑一条 BV 钉给这首歌。
     *
     * 搜到的那条直接解析、打开画面；钉上之后这首歌不再自动匹配（自动匹配会在下一次
     * 解析时把手动的盖掉）。不想要了就点「重新匹配」—— invalidate 会把钉住的清掉。
     */
    pinBv: (songKey: string, bvid: string) => Promise<void>;
}

export type BilibiliMvStore = BilibiliMvState & BilibiliMvActions;

/**
 * 从搜索结果里挑一条：有 AI 就让 AI 挑，没有或 AI 这次不行就退回打分。
 *
 * AI 那条路**任何失败都降级**，且不往分辨率里写错误：用户没配 AI、Key 过期、
 * 网络抖动，都不该让「这首歌没有 MV」。降级之后的行为和以前完全一样。
 */
/**
 * 这条投稿的字幕，转成播放页认的歌词格式。
 *
 * 三步走：挑一轨（中文优先、跳过 AI 生成的那种）→ 拉它的 cues → 拼成歌词。
 * 任何一步拿不到、或者拼出来只是「纯音乐欣赏」这种占位，就回 null —— 对播放页来说
 * 那等于「这条投稿没有歌词」，它就不该把这份字幕换上去。
 */
const resolveMvSubtitles = async (
    tracks: PlayUrlSubtitle[],
    bvid: string,
): Promise<LyricData | null> => {
    if (!tracks || tracks.length === 0) return null;
    try {
        const picked = pickSubtitleTracks(tracks);
        if (!picked.primary?.subtitle_url) return null;
        const primaryCues = await fetchBilibiliSubtitle(picked.primary.subtitle_url);
        if (!primaryCues || primaryCues.length === 0) return null;
        const secondaryCues = picked.secondary?.subtitle_url
            ? await fetchBilibiliSubtitle(picked.secondary.subtitle_url).catch(() => [])
            : [];
        const lyrics = buildLyricsFromCues(primaryCues, secondaryCues);
        if (!hasRealLyrics(lyrics)) return null;
        return stripPlaceholderLines(lyrics);
    } catch (error) {
        console.warn('[Bilibili] MV subtitles failed', bvid, error);
        return null;
    }
};

const pickBest = async (
    hits: readonly BilibiliSearchHit[],
    input: { title: string; artist: string; durationSec?: number },
): Promise<BilibiliSearchHit | null> => {
    if (hits.length === 0) return null;
    const scored = pickBestMvHit(hits, input);
    if (useBilibiliMvStore.getState().useAiMatch && isAiTargetConfigured()) {
        try {
            const picked = await pickMvHitWithAi(hits, input);
            /*
             * ★ 模型说「都不是」（index -1）时，**就真的不要**。
             *
             * 以前这里会往下走到打分去捞一条 —— 注释还写着「打分要求标题命中，挑出来的
             * 不会是乱配」。但事实是：模型把候选通读一遍都说不是这首歌，说明这批候选里
             * 根本没有它；这时候靠标题字面命中硬凑一条，凑出来的正是用户看到的
             * 「AI 没效果，还是给我配了别的视频」。
             *
             * 取舍：没有画面只是背景少一层（播放页仍然是歌词 + 背景），配错一条是
             * 这首歌「看起来就是那支 MV」——后者更糟，而且是用户明确要我们别做的。
             */
            if (picked.hit) return picked.hit;
            console.info('[Bilibili] AI found no MV among the candidates:', picked.reason);
            return null;
        } catch {
            // AI 这条路本身出错（没网、超时、格式不对）：这时才降级到打分。
        }
    }
    return scored;
};

/**
 * 按一条 bvid 取回「能放的那一份」：画面 / 声音的地中转地址 + 这一条投稿的字幕。
 *
 * 两条路共用：自动匹配挑中一条之后，以及**从磁盘恢复**那条已经定好的投稿
 * （见 resolveForSong 里的 bvid 分支 —— 落盘的记录只有 bvid / cid，直链故意不存）。
 * 抽成一处，是为了这两条路不会各自演化成不一样的取流方式。
 *
 * ★ 取流之前先问一句缓存（mvMediaCache.ts）。
 *
 * 缓存里的画面与声音是**同一条投稿、同一档**的一整份，绑定对得上就直接用本机回环
 * 地址，一个字节都不过网 —— 这正是「切回来不用重新下载一遍」要的效果。绑定对不上
 * （换了投稿 / 换了清晰度 / 换了歌）时那次读会自己把旧的一份丢掉，这里照常取流。
 *
 * `songKey` 是这首歌的身份：绑定时要连它一起记，换歌之后即便 bvid 撞了也不复用。
 */
const loadStreamForBvid = async (
    bvid: string,
    quality: MvVideoQuality,
    songKey: string,
): Promise<BilibiliMvStream> => {
    const info = await fetchBilibiliVideoInfo(bvid);
    const track = await fetchBilibiliPlayUrl(bvid, info.cid, quality);
    const streamHeaders = {
        Referer: 'https://www.bilibili.com/',
        Origin: 'https://www.bilibili.com',
    };
    /*
     * 先按「这一次要放的这一条」建一个壳：缓存查找用的是它的身份
     * （bvid + cid + 清晰度），与下面取回来的流是同一套字段。
     */
    const identityShell: BilibiliMvStream = {
        bvid,
        cid: info.cid,
        title: info.title,
        author: info.author,
        durationSec: info.durationSec,
        // 这两个字段只用来表明「要不要声音」：老投稿没有独立音轨时不该要求它命中。
        videoUrl: 'pending',
        audioUrl: track.audioUrl || (track.audioUrls[0] ?? ''),
        quality: track.height,
        subtitles: null,
    };
    const cached = await readCachedMvMedia(identityShell, songKey);
    if (cached) {
        return {
            ...identityShell,
            videoUrl: cached.videoUrl,
            audioUrl: cached.audioUrl,
            // 字幕不进缓存（很小，但要跟着这一次的解析走）：命中缓存这一趟也要拿到。
            subtitles: await resolveMvSubtitles(track.subtitles, bvid),
        };
    }
    const [localVideo, localAudio] = await Promise.all([
        proxyBilibiliStream(track.urls.length > 0 ? track.urls : [track.url], streamHeaders),
        track.audioUrls.length > 0 || track.audioUrl
            ? proxyBilibiliStream(track.audioUrls.length > 0 ? track.audioUrls : [track.audioUrl], streamHeaders)
            : Promise.resolve(null),
    ]);
    const stream: BilibiliMvStream = {
        bvid,
        cid: info.cid,
        title: info.title,
        author: info.author,
        durationSec: info.durationSec,
        videoUrl: localVideo ?? track.url,
        audioUrl: localAudio ?? (track.audioUrl || track.url),
        quality: track.height,
        subtitles: await resolveMvSubtitles(track.subtitles, bvid),
    };
    // 画面地址到手就预热开头，切过去时立刻有一帧。
    void warmStreamCache(stream.videoUrl);
    if (stream.audioUrl) void warmStreamCache(stream.audioUrl);
    /*
     * 落盘：**给的是原始 CDN 地址**，不是上面那条本机中转地址。
     *
     * 中转是给播放器流式读的（一路转发、带多地址容错），拿它当下载源会下到
     * 「中转找不到这条流」的 404 文本，缓存里于是躺着一份放不出来的东西。
     * 下载一律用 track 里那几条真实地址，由原生带 Referer / Origin 去取。
     */
    void writeCachedMvMedia(stream, songKey, {
        videoUrl: track.urls[0] ?? track.url,
        audioUrl: track.audioUrls[0] ?? track.audioUrl ?? '',
    }, {
        /*
         * 这条路径只给「别的平台的歌配一条 MV」用（见文件头），所以这里永远是 false。
         * 仍然显式传出来，是为了让准入条件在调用点也读得见 —— B 站投稿当歌听的那条路
         * （BilibiliVideoStage）根本不经过这里，它不该被缓存。
         */
        songIsBilibiliPost: false,
    });
    return stream;
};

export const useBilibiliMvStore = create<BilibiliMvStore>()((set, get) => ({
    ...initialState,

    setEnabled: (enabled) => {
        writeStoredEnabled(enabled);
        set({ enabled });
    },

    setForcedByStyle: (forced) => {
        if (get().forcedByStyle === forced) return;
        set({ forcedByStyle: forced });
    },

    setUseAiMatch: (use) => {
        try {
            setStoredString(USE_AI_MATCH_STORAGE_KEY, use ? '1' : '0');
        } catch {
            // 存不下也不影响这次运行。
        }
        set({ useAiMatch: use });
    },

    setQuality: (quality) => {
        if (get().quality === quality) return;
        try {
            setStoredString(MV_QUALITY_STORAGE_KEY, quality);
        } catch {
            // 存不下也不影响这次运行。
        }
        set({ quality });
        /*
         * 已经解析好的那几条要按新档重取一次。
         *
         * 直链是**按档取回来的**：换了档不重来，画面还是上一档那条 —— 用户点了
         * 「1080P」，屏幕上纹丝不动。这里只重取「已经 ready」的那些：missing / error
         * 的记录重取没意义（它们要么没有 MV，要么本来就取不到）。
         *
         * 记住的那条（手动钉的）照样重取，它钉的是哪条投稿，不是哪一档。
         */
        const state = get();
        if (!state.enabled) return;
        for (const [songKey, cached] of Object.entries(state.bySongKey)) {
            if (cached.state !== 'ready' || !cached.stream) continue;
            void get().resolveForSong(songKey, cached.stream.title, cached.stream.author, cached.stream.durationSec, true);
        }
    },

    /**
     * 解析一首歌的 MV。
     *
     * 已经有可用结果、且没过期时直接返回（force 除外）。解析失败不抛给调用方：
     * 背景只是画不出东西，不该让播放页崩掉 —— 状态记在 resolution 里给界面看。
     */
    resolveForSong: async (songKey, title, artist, durationSec = 0, force = false) => {
        if (!songKey) return;
        // 后台不匹配：熄屏 / 切后台时请求会停在半路，拿到的是一条没下完的地址
        // （画面定格、声音照走 —— 用户看到的「音画不同步」）。记下这首歌，回前台重试。
        if (typeof document !== 'undefined' && document.hidden) {
            pendingForegroundKey = songKey;
            pendingForegroundRequest = { title, artist, durationSec };
            return;
        }
        const state = get();
        // force 是「重新匹配」，它要能打断正在飞的那一单 —— 否则按钮看起来没反应。
        if (state.inflight[songKey] && !force) return;

        const cached = state.bySongKey[songKey];
        // 这首歌被手动钉过某条 BV：除非 force（「重新匹配」会先清掉钉的那条），否则不自动搜。
        if (!force && cached) {
            const fresh = Date.now() - cached.resolvedAt < RESOLUTION_TTL_MS;
            /*
             * ★ 「ready」还不够，还必须**手上真的有能放的地址**。
             *
             * 从磁盘恢复出来的那一条是 ready、也有 bvid，但 videoUrl 是空的（直链会过期，
             * 故意不落盘，见 writeStoredResolutions）。只判 ready + fresh 的话，这一条会
             * 在这里提前 return，谁都不会去重新取地址 —— 用户看到的是「MV 匹配结果明明
             * 还在，画面就是不出来」。
             *
             * 地址没了就当作没解析过，往下走一趟（按下文：有 bvid 时直接按 bvid 取，不重搜）。
             */
            const playable = Boolean(cached.stream?.videoUrl);
            if (cached.state === 'ready' && cached.stream && playable && fresh) return;
            // 已经确认过「这首歌没有 MV」的话，短时间内不必再搜。
            if (cached.state === 'missing' && fresh) return;
        }

        if (!isBilibiliAvailable()) {
            set(current => ({
                bySongKey: {
                    ...current.bySongKey,
                    [songKey]: {
                        state: 'error',
                        songKey,
                        stream: null,
                        keyword: '',
                        manual: false,
                        message: '仅安卓 App 内可用',
                        resolvedAt: Date.now(),
                    },
                },
            }));
            return;
        }

        set(current => ({
            inflight: { ...current.inflight, [songKey]: true },
            bySongKey: {
                ...current.bySongKey,
                [songKey]: {
                    state: 'resolving',
                    songKey,
                    stream: null,
                    keyword: cached?.keyword ?? '',
                    manual: false,
                    resolvedAt: 0,
                },
            },
        }));

        const keyword = buildSearchKeyword(title, artist);
        const finish = (resolution: Omit<CachedResolution, 'songKey' | 'resolvedAt'>) => {
            set(current => {
                const { [songKey]: _gone, ...rest } = current.inflight;
                const bySongKey = {
                    ...current.bySongKey,
                    [songKey]: { ...resolution, songKey, resolvedAt: Date.now() },
                };
                // 结果一出来就落盘：重启 / 换播放器回来时不必重搜一遍（手动钉的那条尤其不能丢）。
                writeStoredResolutions(bySongKey);
                return { inflight: rest, bySongKey };
            });
        };

        try {
            /*
             * 从磁盘恢复回来的那一条：bvid 已经定了，只差一个能放的地址。
             *
             * 直接按 bvid 取流，**不要再搜一遍** —— 搜索是「挑哪条投稿」的问题，这个问题
             * 上次已经答过了（还是用户亲手钉的那条，重搜可能换成另一支，等于把他的选择冲掉）。
             * 取一次地址比搜一遍快，也不会因为搜索排序变了而换了视频。
             */
            if (cached?.stream?.bvid) {
                const restored = await loadStreamForBvid(cached.stream.bvid, get().quality, songKey);
                finish({ state: 'ready', stream: restored, keyword: cached.keyword, manual: cached.manual });
                return;
            }
            const hits = await searchBilibiliVideos(keyword);
            const best = await pickBest(hits, { title, artist, durationSec });
            if (!best) {
                finish({
                    state: 'missing',
                    stream: null,
                    keyword,
                    manual: false,
                    message: hits.length === 0 ? '没有搜到结果' : '搜到了，但没有一条像是这首歌的 MV',
                });
                return;
            }

            const stream = await loadStreamForBvid(best.bvid, get().quality, songKey);
            finish({ state: 'ready', stream, keyword, manual: false });
        } catch (error) {
            const message = error instanceof BilibiliApiError
                ? error.message
                : error instanceof Error
                    ? error.message
                    : String(error);
            finish({ state: 'error', stream: null, keyword, manual: false, message });
        }
    },

    prefetchNext: (songKey, title, artist, durationSec = 0) => {
        if (!songKey) return;
        // 后台不预取：请求会停在半路（见 resolveForSong 里的注释），回前台重放那一单。
        if (typeof document !== 'undefined' && document.hidden) {
            pendingForegroundKey = songKey;
            pendingForegroundRequest = { title, artist, durationSec };
            return;
        }
        const state = get();
        // 开关没开就不预取：用户根本不会看到画面，白花流量又占搜索接口的额度。
        if (!state.enabled) return;
        // 已经有结果（不管是 ready 还是 missing）都不必再问。
        if (state.bySongKey[songKey] || state.inflight[songKey]) return;
        // 同一时刻只预取一首：切歌快时别把接口打满。
        if (Object.keys(state.inflight).length > 0) return;
        void get().resolveForSong(songKey, title, artist, durationSec);
    },

    invalidate: (songKey) => {
        set(current => {
            const { [songKey]: _drop, ...rest } = current.bySongKey;
            const { [songKey]: _flying, ...flyingRest } = current.inflight;
            // 手动钉的那条一起清掉：invalidated 的语义是「重新来过」，留着钉住就又自动不搜了。
            // 正在飞的那一单也一起清：不清的话紧接着的重新匹配会被 inflight 挡回去。
            // 磁盘上那份也要跟着改，否则重启之后旧结论又回来了。
            writeStoredResolutions(rest);
            return { bySongKey: rest, inflight: flyingRest };
        });
    },

    clear: () => {
        writeStoredResolutions({});
        set({ bySongKey: {}, inflight: {} });
        /*
         * 盘上的字节缓存也一起清：匹配记录一没，那份音轨 / 画面就成了没人认领的
         * 几十兆文件，绑定也指向空。这里不 await（clear 是同步接口，界面不等删文件），
         * 删失败不影响下一次读取 —— 绑定已经清掉，下次一定走重新取流那条路。
         */
        void dropCachedMvMedia();
    },

    clearBytesCache: async () => {
        await dropCachedMvMedia();
    },

    pinBv: async (songKey, bvid) => {
        if (!songKey || !bvid.trim()) return;
        const clean = bvid.trim();
        if (!isBilibiliAvailable()) return;
        set(current => ({
            inflight: { ...current.inflight, [songKey]: true },
            bySongKey: {
                ...current.bySongKey,
                [songKey]: {
                    state: 'resolving',
                    songKey,
                    stream: null,
                    keyword: clean,
                    manual: true,
                    resolvedAt: 0,
                },
            },
        }));
        const finish = (resolution: Omit<CachedResolution, 'songKey' | 'resolvedAt'>) => {
            set(current => {
                const { [songKey]: _gone, ...rest } = current.inflight;
                const bySongKey = {
                    ...current.bySongKey,
                    [songKey]: { ...resolution, songKey, resolvedAt: Date.now() },
                };
                // 结果一出来就落盘：重启 / 换播放器回来时不必重搜一遍（手动钉的那条尤其不能丢）。
                writeStoredResolutions(bySongKey);
                return { inflight: rest, bySongKey };
            });
        };
        try {
            // 打开画面是「用户点了这条就该看到」的意思：这里顺手把开关写上（与注释
            // 里 pinBv 的语义一致 —— 不该还要再回设置里开一次）。
            if (!get().enabled) get().setEnabled(true);
            const stream = await loadStreamForBvid(clean, get().quality, songKey);
            finish({ state: 'ready', stream, keyword: clean, manual: true });
        } catch (error) {
            const message = error instanceof BilibiliApiError
                ? error.message
                : error instanceof Error
                    ? error.message
                    : String(error);
            finish({ state: 'error', stream: null, keyword: clean, manual: true, message });
        }
    },
}));

/*
 * 回到前台：后台攒下的那一单现在才解析。
 *
 * 放在 store 建好之后 —— 监听里要读 get()。旧的那份缓存因 force 清掉：后台期间
 * 直链多半已经过期，重放一次才能拿到能用的地址（画面不再定格在熄屏前那一帧）。
 */
if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        const songKey = pendingForegroundKey;
        const request = pendingForegroundRequest;
        pendingForegroundKey = null;
        pendingForegroundRequest = null;
        if (!songKey || !request) return;
        const current = useBilibiliMvStore.getState();
        if (!current.enabled) return;
        void current.resolveForSong(songKey, request.title, request.artist, request.durationSec, true);
    });
}

/** 给非 React 的地方读当前解析结果。 */
export const readBilibiliMv = (songKey: string) => useBilibiliMvStore.getState().bySongKey[songKey];
