// src/services/onlineMusic/lxmusic/lxSquareCollections.ts
// 洛雪没有「我的账号」这件事：它的歌单页不该是空的。
//
// 选中洛雪时，首页「歌单」直接显示四家（网易云 / QQ / 酷狗 / 酷我）的歌单广场，四家交替排开，
// 点进去就是那家真实的歌单曲目 —— 打开用的是 lxmusic 的 catalog.getPlaylistTracks（id 形如 `kg:123`）。
//
// 取一次就落盘缓存，下次进 App 先拿缓存立刻画出来，再在后台刷新；取失败时保留上次的结果。

import type { MediaId, ProviderCollection } from '../../../types/onlineMusic';
import {
    LX_PUBLIC_PLATFORM_KEYS,
    lxApiPlaylistSquare,
    type LxApiCollection,
} from './lxPublicApi';

const CACHE_KEY = 'lxmusic_square_collections_v1';
const CACHE_TTL = 30 * 60 * 1000;
/** 每家取多少张：四家 × 15 已经能把一屏铺满，取太多反而拖慢首屏。 */
const PER_PLATFORM = 15;

type Cached = { at: number; items: ProviderCollection[] };

const readCache = (): Cached | null => {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Cached;
        if (!parsed || !Array.isArray(parsed.items)) return null;
        return parsed;
    } catch {
        return null;
    }
};

const writeCache = (items: ProviderCollection[]): void => {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), items }));
    } catch {
        // 存不下只是下次慢一点。
    }
};

const toCollection = (item: LxApiCollection): ProviderCollection => ({
    providerId: 'lxmusic',
    id: `${item.platform}:${item.id}` as MediaId,
    name: item.name,
    type: 'playlist',
    coverUrl: item.coverUrl,
    description: item.description,
    trackCount: item.trackCount,
    playCount: item.playCount,
    creator: item.creatorName ? { id: `${item.platform}-creator` as MediaId, nickname: item.creatorName } : undefined,
    updatedAt: item.updatedAt,
    providerData: { platform: item.platform, nativeId: item.id, kind: 'playlist' },
});

/** 四家交替排：一屏里能同时看到各家，而不是先看完网易云。 */
const interleave = (lists: ProviderCollection[][]): ProviderCollection[] => {
    const out: ProviderCollection[] = [];
    const max = Math.max(0, ...lists.map((list) => list.length));
    for (let index = 0; index < max; index += 1) {
        for (const list of lists) {
            if (index < list.length) out.push(list[index]);
        }
    }
    return out;
};

let snapshot: ProviderCollection[] = readCache()?.items ?? [];
let loadedAt = readCache()?.at ?? 0;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

const notify = (): void => {
    listeners.forEach((listener) => listener());
};

const load = async (): Promise<void> => {
    const results = await Promise.allSettled(
        LX_PUBLIC_PLATFORM_KEYS.map((platform) => lxApiPlaylistSquare(platform, PER_PLATFORM, 0)),
    );
    const lists: ProviderCollection[][] = [];
    results.forEach((result) => {
        if (result.status === 'fulfilled') {
            lists.push(result.value.items.map(toCollection));
        } else {
            console.warn('[lxmusic] 歌单广场取失败：', result.reason);
        }
    });
    if (lists.length === 0) return;
    const merged = interleave(lists);
    if (merged.length === 0) return;
    snapshot = merged;
    loadedAt = Date.now();
    writeCache(merged);
    notify();
};

/** 需要时加载（缓存过期或在后台刷新）。已在加载中则复用同一次请求。 */
export const ensureSquareCollections = (force = false): Promise<void> => {
    if (loading) return loading;
    if (!force && snapshot.length > 0 && Date.now() - loadedAt < CACHE_TTL) return Promise.resolve();
    loading = load()
        .catch((error) => {
            console.warn('[lxmusic] 歌单广场加载失败：', error);
        })
        .finally(() => {
            loading = null;
        });
    return loading;
};

export const getSquareCollections = (): ProviderCollection[] => snapshot;

export const subscribeSquareCollections = (listener: () => void): () => void => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};
