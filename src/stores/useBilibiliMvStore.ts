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
import { isAiTargetConfigured } from '../services/aiCompletion';
import { isBilibiliAvailable, proxyBilibiliStream } from '../services/bilibili/transport';
import { warmStreamCache } from '../services/bilibili/streamPrefetch';
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

const readStoredUseAi = (): boolean => {
    try {
        const raw = localStorage.getItem(USE_AI_MATCH_STORAGE_KEY);
        // 没存过就是默认开。
        return raw === null ? true : raw === '1';
    } catch {
        return true;
    }
};

const readStoredEnabled = (): boolean => {
    try {
        return localStorage.getItem(ENABLED_STORAGE_KEY) === '1';
    } catch {
        // 读不到就当没开：这是画面，默认安静比默认出声好。
        return false;
    }
};

const writeStoredEnabled = (enabled: boolean) => {
    try {
        localStorage.setItem(ENABLED_STORAGE_KEY, enabled ? '1' : '0');
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

const initialState: BilibiliMvState = {
    enabled: readStoredEnabled(),
    useAiMatch: readStoredUseAi(),
    forcedByStyle: false,
    bySongKey: {},
    inflight: {},
};

interface BilibiliMvActions {
    setEnabled: (enabled: boolean) => void;
    /** 背景样式要求强制打开（它自己不写用户的开关）。 */
    setForcedByStyle: (forced: boolean) => void;
    setUseAiMatch: (use: boolean) => void;
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
            if (picked.hit) return picked.hit;
            /*
             * 模型说「都不是」的时候仍然看一眼打分。
             *
             * 以前这里是直接收工（理由是「它看懂了候选」），结果就是：模型偏保守、或者
             * 歌名对不上它的口味时，**每一首都被判成没有 MV**，而打分其实挑得出一个
             * 很像的 —— 用户看到的就是「完全不匹配 MV，开不开 AI 都一样」。
             * 打分那条路本来就要求标题命中且分数为正，它挑出来的不会是乱配。
             */
        } catch {
            // 降级。
        }
    }
    return scored;
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
            localStorage.setItem(USE_AI_MATCH_STORAGE_KEY, use ? '1' : '0');
        } catch {
            // 存不下也不影响这次运行。
        }
        set({ useAiMatch: use });
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
            if (cached.state === 'ready' && cached.stream && fresh) return;
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
                return {
                    inflight: rest,
                    bySongKey: {
                        ...current.bySongKey,
                        [songKey]: { ...resolution, songKey, resolvedAt: Date.now() },
                    },
                };
            });
        };

        try {
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

            const info = await fetchBilibiliVideoInfo(best.bvid);
            const track = await fetchBilibiliPlayUrl(best.bvid, info.cid);
            /*
             * 画面和声音都走原生中转。
             *
             * 直链是「一组候选」（主地址 + 若干备用），其中总有几台对某些投稿回 403。
             * 这里以前直接把 track.url 喂给 <video>：抽到坏节点就是画面出不来 —— 正是
             * 「别的平台匹配的 MV 放不出来、直接放这一站反而正常」的来源（那条路早就
             * 走中转）。中转由原生按顺序试，403 换下一台。
             *
             * 中转起不来就退回直链，至少还留一次机会。
             */
            const streamHeaders = {
                Referer: 'https://www.bilibili.com/',
                Origin: 'https://www.bilibili.com',
            };
            const [localVideo, localAudio] = await Promise.all([
                proxyBilibiliStream(track.urls.length > 0 ? track.urls : [track.url], streamHeaders),
                track.audioUrls.length > 0 || track.audioUrl
                    ? proxyBilibiliStream(track.audioUrls.length > 0 ? track.audioUrls : [track.audioUrl], streamHeaders)
                    : Promise.resolve(null),
            ]);
            const stream: BilibiliMvStream = {
                bvid: best.bvid,
                cid: info.cid,
                title: info.title || best.title,
                author: info.author || best.author,
                durationSec: info.durationSec || best.durationSec,
                videoUrl: localVideo ?? track.url,
                audioUrl: localAudio ?? (track.audioUrl || track.url),
                quality: track.height,
                // 这条投稿自己的字幕，筛掉占位行之后才留着；不合格就是 null。
                subtitles: await resolveMvSubtitles(track.subtitles, best.bvid),
            };
            // 画面地址到手就预热开头，切过去时立刻有一帧。
            void warmStreamCache(stream.videoUrl);
            if (stream.audioUrl) void warmStreamCache(stream.audioUrl);
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
            return { bySongKey: rest, inflight: flyingRest };
        });
    },

    clear: () => set({ bySongKey: {}, inflight: {} }),

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
                return {
                    inflight: rest,
                    bySongKey: {
                        ...current.bySongKey,
                        [songKey]: { ...resolution, songKey, resolvedAt: Date.now() },
                    },
                };
            });
        };
        try {
            // 打开画面是「用户点了这条就该看到」的意思：这里顺手把开关写上（与注释
            // 里 pinBv 的语义一致 —— 不该还要再回设置里开一次）。
            if (!get().enabled) get().setEnabled(true);
            const info = await fetchBilibiliVideoInfo(clean);
            const track = await fetchBilibiliPlayUrl(clean, info.cid);
            const streamHeaders = {
                Referer: 'https://www.bilibili.com/',
                Origin: 'https://www.bilibili.com',
            };
            const [localVideo, localAudio] = await Promise.all([
                proxyBilibiliStream(track.urls.length > 0 ? track.urls : [track.url], streamHeaders),
                track.audioUrls.length > 0 || track.audioUrl
                    ? proxyBilibiliStream(track.audioUrls.length > 0 ? track.audioUrls : [track.audioUrl], streamHeaders)
                    : Promise.resolve(null),
            ]);
            const stream: BilibiliMvStream = {
                bvid: clean,
                cid: info.cid,
                title: info.title,
                author: info.author,
                durationSec: info.durationSec,
                videoUrl: localVideo ?? track.url,
                audioUrl: localAudio ?? (track.audioUrl || track.url),
                quality: track.height,
                subtitles: await resolveMvSubtitles(track.subtitles, clean),
            };
            void warmStreamCache(stream.videoUrl);
            if (stream.audioUrl) void warmStreamCache(stream.audioUrl);
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
