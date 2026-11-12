import { create } from 'zustand';
import type { BilibiliMvResolution, BilibiliMvStream } from '../types/bilibili';
import {
    BilibiliApiError,
    fetchBilibiliPlayUrl,
    fetchBilibiliVideoInfo,
    searchBilibiliVideos,
} from '../services/bilibili/api';
import { buildSearchKeyword, pickBestMvHit } from '../services/bilibili/mvMatch';
import { isBilibiliAvailable } from '../services/bilibili/transport';

// src/stores/useBilibiliMvStore.ts
//
// 每首歌解析出来的是哪条 MV，以及这首歌的画面偏移。
//
// 一条 MV 的解析要打三次接口（搜索 → 详情取 cid → 取播放地址），所以结果按 songKey
// 缓存起来：同一首歌反复切来切去不会再搜一遍。直链有时效，过期由画面层触发重解析。
//
// 这里不做「提前预取下一首」：搜索接口对频繁调用会限流，而且大多数歌用户根本不会
// 盯着看 MV，预取只是白花流量。

/** 缓存多久之后允许重新搜（直链过期或用户想看新结果时）。 */
const RESOLUTION_TTL_MS = 30 * 60 * 1000;

/** 偏移落盘的键。用户手调的音画偏移不该因为重启就没了。 */
const OFFSET_STORAGE_KEY = 'bilibili_mv_offsets';

const readStoredOffsets = (): Record<string, number> => {
    try {
        const raw = localStorage.getItem(OFFSET_STORAGE_KEY);
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return {};
        const out: Record<string, number> = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
        }
        return out;
    } catch {
        // 存坏了就当没调过：全部回到 0，总好过整份设置读不出来。
        return {};
    }
};

const writeStoredOffsets = (offsets: Record<string, number>) => {
    try {
        localStorage.setItem(OFFSET_STORAGE_KEY, JSON.stringify(offsets));
    } catch {
        // 存不下就只改这一次的状态，不影响用。
    }
};

interface CachedResolution extends BilibiliMvResolution {
    /** 解析完成的时间；resolving 时为 0。 */
    resolvedAt: number;
}

interface BilibiliMvState {
    bySongKey: Record<string, CachedResolution>;
    /** 每首歌的画面偏移（秒）。正数 = 画面比声音晚。 */
    offsets: Record<string, number>;
    /** 正在解析的 key，防止同一首并发触发多次搜索。 */
    inflight: Record<string, true>;
}

const initialState: BilibiliMvState = {
    bySongKey: {},
    offsets: readStoredOffsets(),
    inflight: {},
};

interface BilibiliMvActions {
    resolveForSong: (
        songKey: string,
        title: string,
        artist: string,
        durationSec?: number,
        force?: boolean,
    ) => Promise<void>;
    setOffset: (songKey: string, offsetSec: number) => void;
    /** 把某一首的缓存扔掉，下次会重新搜。 */
    invalidate: (songKey: string) => void;
    /** 清空全部缓存（设置里「重新匹配」用）。 */
    clear: () => void;
}

export type BilibiliMvStore = BilibiliMvState & BilibiliMvActions;

export const useBilibiliMvStore = create<BilibiliMvStore>()((set, get) => ({
    ...initialState,

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
            const best = pickBestMvHit(hits, { title, artist, durationSec });
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

    setOffset: (songKey, offsetSec) => {
        if (!songKey || !Number.isFinite(offsetSec)) return;
        set(current => {
            const next = { ...current.offsets, [songKey]: offsetSec };
            writeStoredOffsets(next);
            return { offsets: next };
        });
    },

    invalidate: (songKey) => {
        set(current => {
            const { [songKey]: _drop, ...rest } = current.bySongKey;
            return { bySongKey: rest };
        });
    },

    clear: () => set({ bySongKey: {}, inflight: {} }),
}));

/** 给非 React 的地方读当前解析结果。 */
export const readBilibiliMv = (songKey: string) => useBilibiliMvStore.getState().bySongKey[songKey];
