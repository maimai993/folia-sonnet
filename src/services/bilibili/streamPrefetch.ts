import { fetchBilibiliPlayUrl, fetchBilibiliVideoInfo } from './api';
import { bilibiliBvidOf } from './bilibiliNormalize';
import { isBilibiliAvailable } from './transport';

// src/services/bilibili/streamPrefetch.ts
// 播放队列里那些投稿的取流地址，提前拿到手里。
//
// 不预取的话，切歌那一刻才开始问 bilibili（详情一次 + 取流一次），画面要等两个往返
// 才出来，听着就是「切过去先黑一下」。这里在队列一变就把整条队列的地址取回来，
// 切歌时直接命中。
//
// 地址是带时效的签名 URL，所以缓存要过期：太久的那条宁可重新取，也不要拿一条
// 已经失效的去喂 <video>（表现是画面裂开）。

/** 一条投稿取到的流。 */
export interface PrefetchedStream {
    videoUrl: string;
    /** 取到的时刻，用来判断还新不新鲜。 */
    fetchedAt: number;
}

/**
 * 缓存活多久。
 *
 * bilibili 的取流地址一般能撑几个小时，但没必要留那么久：队列就那几十首，
 * 十几分钟已经覆盖了「从列表点一首、再点下一首」的全部节奏。过期之后重新取
 * 一次也就两百毫秒。
 */
const TTL_MS = 10 * 60 * 1000;

const cache = new Map<string, PrefetchedStream>();
/** 正在取的那些，避免同一首被并发取两次。 */
const inflight = new Map<string, Promise<PrefetchedStream | null>>();

const isFresh = (entry: PrefetchedStream | undefined): entry is PrefetchedStream => (
    Boolean(entry) && Date.now() - (entry as PrefetchedStream).fetchedAt < TTL_MS
);

/** 已经取好、还能用的那条；没有就返回 null（不发起请求）。 */
export const peekStream = (bvid: string): string | null => {
    const entry = cache.get(bvid);
    return isFresh(entry) ? entry.videoUrl : null;
};

/** 取一条的流地址，已经有新鲜的就直接给。失败返回 null，不抛。 */
export const ensureStream = (bvid: string): Promise<PrefetchedStream | null> => {
    const cached = cache.get(bvid);
    if (isFresh(cached)) return Promise.resolve(cached);
    const running = inflight.get(bvid);
    if (running) return running;

    const task = (async (): Promise<PrefetchedStream | null> => {
        try {
            const info = await fetchBilibiliVideoInfo(bvid);
            const track = await fetchBilibiliPlayUrl(bvid, info.cid);
            const entry: PrefetchedStream = { videoUrl: track.url, fetchedAt: Date.now() };
            cache.set(bvid, entry);
            return entry;
        } catch (error) {
            // 取不到就是取不到：切到这首时再试一次，不要在这里打断队列。
            console.warn('[Bilibili] Stream prefetch failed', error);
            return null;
        } finally {
            inflight.delete(bvid);
        }
    })();

    inflight.set(bvid, task);
    return task;
};

/**
 * 把一条队列里所有投稿的流都取回来。
 *
 * 串行没有必要（它们互不依赖），但也不该一次全发出去 —— 一下就几十个请求。
 * 这里分小批推，先取靠前的几首（下一首最可能要），再补后面。
 */
export const prefetchQueueStreams = (songs: readonly unknown[]): void => {
    if (!isBilibiliAvailable()) return;
    const bvids: string[] = [];
    for (const song of songs) {
        const bvid = bilibiliBvidOf(song as { id?: string } | null);
        if (bvid && !bvids.includes(bvid)) bvids.push(bvid);
    }
    if (bvids.length === 0) return;

    void (async () => {
        const BATCH = 3;
        for (let i = 0; i < bvids.length; i += BATCH) {
            const slice = bvids.slice(i, i + BATCH).filter(bvid => !isFresh(cache.get(bvid)));
            if (slice.length > 0) await Promise.all(slice.map(bvid => ensureStream(bvid)));
        }
    })();
};

/** 队列里某首已经不在了，就把它的缓存丢掉（歌单会一直变）。 */
export const dropStreamsExcept = (songs: readonly unknown[]): void => {
    const keep = new Set<string>();
    for (const song of songs) {
        const bvid = bilibiliBvidOf(song as { id?: string } | null);
        if (bvid) keep.add(bvid);
    }
    for (const bvid of [...cache.keys()]) {
        if (!keep.has(bvid)) cache.delete(bvid);
    }
};
