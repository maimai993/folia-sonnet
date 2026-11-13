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
import { isBilibiliAvailable } from '../services/bilibili/transport';

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

/** 「MV 时只留视频」落盘的键。 */
const HIDE_LYRICS_STORAGE_KEY = 'bilibili_mv_hide_lyrics';

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

const readStoredHideLyrics = (): boolean => {
    try {
        return localStorage.getItem(HIDE_LYRICS_STORAGE_KEY) === '1';
    } catch {
        return false;
    }
};

const writeStoredHideLyrics = (hide: boolean) => {
    try {
        localStorage.setItem(HIDE_LYRICS_STORAGE_KEY, hide ? '1' : '0');
    } catch {
        // 同上。
    }
};

interface CachedResolution extends BilibiliMvResolution {
    /** 解析完成的时间；resolving 时为 0。 */
    resolvedAt: number;
}

interface BilibiliMvState {
    /** 播放页是否把 MV 当背景铺上。 */
    enabled: boolean;
    /** MV 铺上时把歌词动画整个关掉，只留视频。 */
    hideLyrics: boolean;
    /** 配了 AI 时，让它判断哪条投稿才是这首歌的 MV（关掉就用打分规则）。 */
    useAiMatch: boolean;
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
    hideLyrics: readStoredHideLyrics(),
    useAiMatch: readStoredUseAi(),
    bySongKey: {},
    inflight: {},
};

interface BilibiliMvActions {
    setEnabled: (enabled: boolean) => void;
    setHideLyrics: (hide: boolean) => void;
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
}

export type BilibiliMvStore = BilibiliMvState & BilibiliMvActions;

/**
 * 从搜索结果里挑一条：有 AI 就让 AI 挑，没有或 AI 这次不行就退回打分。
 *
 * AI 那条路**任何失败都降级**，且不往分辨率里写错误：用户没配 AI、Key 过期、
 * 网络抖动，都不该让「这首歌没有 MV」。降级之后的行为和以前完全一样。
 */
const pickBest = async (
    hits: readonly BilibiliSearchHit[],
    input: { title: string; artist: string; durationSec?: number },
): Promise<BilibiliSearchHit | null> => {
    if (hits.length === 0) return null;
    if (useBilibiliMvStore.getState().useAiMatch && isAiTargetConfigured()) {
        try {
            const picked = await pickMvHitWithAi(hits, input);
            // 模型说「都不是」时**不降级**：它看懂了候选，结论就是没有。
            // 只有它答不上来（抛错 / 回答看不懂）才交给打分。
            if (picked.hit) return picked.hit;
            if (picked.reason && picked.reason !== '模型回答看不懂') return null;
        } catch {
            // 降级。
        }
    }
    return pickBestMvHit(hits, input);
};

export const useBilibiliMvStore = create<BilibiliMvStore>()((set, get) => ({
    ...initialState,

    setEnabled: (enabled) => {
        writeStoredEnabled(enabled);
        set({ enabled });
    },

    setHideLyrics: (hide) => {
        writeStoredHideLyrics(hide);
        set({ hideLyrics: hide });
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
        const state = get();
        if (state.inflight[songKey]) return;

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
            const stream: BilibiliMvStream = {
                bvid: best.bvid,
                cid: info.cid,
                title: info.title || best.title,
                author: info.author || best.author,
                durationSec: info.durationSec || best.durationSec,
                videoUrl: track.url,
                audioUrl: track.audioUrl,
                quality: track.height,
            };
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
            // 手动钉的那条一起清掉：invalidated 的语义是「重新来过」，留着钉住就又自动不搜了。
                return { bySongKey: rest };
        });
    },

    clear: () => set({ bySongKey: {}, inflight: {} }),
}));

/** 给非 React 的地方读当前解析结果。 */
export const readBilibiliMv = (songKey: string) => useBilibiliMvStore.getState().bySongKey[songKey];
