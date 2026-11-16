import { fetchBilibiliPlayUrl, fetchBilibiliVideoInfo } from './api';
import { bilibiliBvidOf, bilibiliCidOf, bilibiliEpIdOf } from './bilibiliNormalize';
import { isBilibiliAvailable, proxyBilibiliStream } from './transport';

// src/services/bilibili/streamPrefetch.ts
// 播放队列里那些投稿的取流地址，提前拿到手里。
//
// 不预取的话，切歌那一刻才开始问 bilibili（详情一次 + 取流一次），画面要等两个往返
// 才出来，听着就是「切过去先黑一下」。这里在队列一变就把整条队列的地址取回来，
// 切歌时直接命中。
//
// 地址是带时效的签名 URL，所以缓存要过期：太久的那条宁可重新取，也不要拿一条
// 已经失效的去喂 <video>（表现是画面裂开）。
//
// **缓存按清晰度分开**（key = bvid + 清晰度）。以前只按 bvid 记一条：用户把画质从
// 720P 调到 1080P，缓存里那条老的还在有效期内，于是「换了画质画面纹丝不动」。

/** 一条投稿取到的流。 */
export interface PrefetchedStream {
    videoUrl: string;
    /** 取到的时刻，用来判断还新不新鲜。 */
    fetchedAt: number;
    /** 按这一档取到的（缓存 key 的一部分）。 */
    quality: string;
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

/**
 * 缓存 key。
 *
 * 分P 投稿的每一集 cid 不同、流的地址也不同，所以 cid 也要进 key —— 只按 bvid
 * 记的话，多P 投稿的第二集拿到的是第一集的画面。
 */
const cacheKeyOf = (bvid: string, quality: string, cid?: number | null): string => (
    `${bvid}\u0000${typeof cid === 'number' && cid > 0 ? cid : 'first'}\u0000${quality}`
);

/** 一首歌的（bvid, cid, epId）：与播放取流用的是同一份解析。 */
export interface StreamTarget {
    bvid: string;
    cid: number | null;
    epId: number | null;
}

/** 从一首歌（或者一个播放队列条目）里取出取流要用的三元组。 */
export const streamTargetOf = (song: unknown): StreamTarget | null => {
    const bvid = bilibiliBvidOf(song as { id?: string } | null);
    const epId = bilibiliEpIdOf(song as { id?: string } | null);
    if (!bvid && !epId) return null;
    return { bvid, cid: bilibiliCidOf(song as { id?: string } | null), epId };
};

const isFresh = (entry: PrefetchedStream | undefined): entry is PrefetchedStream => (
    Boolean(entry) && Date.now() - (entry as PrefetchedStream).fetchedAt < TTL_MS
);

/** 已经取好、还能用的那条；没有就返回 null（不发起请求）。 */
export const peekStream = (
    bvid: string,
    quality = 'standard',
    cid?: number | null,
): string | null => {
    const entry = cache.get(cacheKeyOf(bvid, quality, cid));
    return isFresh(entry) ? entry.videoUrl : null;
};

/**
 * 取一条的流地址，已经有新鲜的就直接给。失败返回 null，不抛。
 *
 * `quality` 是用户当前选的那一档：调用方在切歌 / 换画质时一定要把它传进来，
 * 否则拿到的可能还是上一档的那条老地址。
 */
export const ensureStream = (
    bvid: string,
    quality = 'standard',
    cid?: number | null,
    epId?: number | null,
): Promise<PrefetchedStream | null> => {
    const key = cacheKeyOf(bvid, quality, cid);
    const cached = cache.get(key);
    if (isFresh(cached)) return Promise.resolve(cached);
    const running = inflight.get(key);
    if (running) return running;

    const task = (async (): Promise<PrefetchedStream | null> => {
        try {
            const info = cid ? null : await fetchBilibiliVideoInfo(bvid);
            const track = await fetchBilibiliPlayUrl(
                bvid,
                cid ?? info?.cid ?? 0,
                quality,
                epId,
            );
            /*
             * 画面也走原生中转。
             *
             * 直链有风险：同一条流会给出主地址加若干备用，其中总有几个节点对某些投稿
             * 回 403，抽到坏节点就是「画面出不来」。中转由原生按顺序试，403 换下一台 ——
             * `<video>` 只看到一个本机地址，不必知道这一层。
             *
             * 中转起不来（比如插件没注册）就退回直链，至少还有一次机会。
             */
            const local = await proxyBilibiliStream(track.urls.length > 0 ? track.urls : [track.url], {
                Referer: 'https://www.bilibili.com/',
                Origin: 'https://www.bilibili.com',
            });
            const entry: PrefetchedStream = {
                videoUrl: local ?? track.url,
                fetchedAt: Date.now(),
                quality,
            };
            cache.set(key, entry);
            // 地址到手就开始预热：切过去时第一帧已经在缓存里了。
            void warmStreamCache(entry.videoUrl);
            return entry;
        } catch (error) {
            // 取不到就是取不到：切到这首时再试一次，不要在这里打断队列。
            console.warn('[Bilibili] Stream prefetch failed', error);
            return null;
        } finally {
            inflight.delete(key);
        }
    })();

    inflight.set(key, task);
    return task;
};

/**
 * 换一档画面之后把这一首**同一个 cid** 的其它档都丢掉。
 *
 * 留着没意义：地址是签名 URL，用户既然换了档就不会再换回旧的那条；而留在表里
 * 会让下一次切换命中一条不对档的地址。
 */
export const forgetStreamQuality = (bvid: string, cid?: number | null): void => {
    const suffix = `\u0000${typeof cid === 'number' && cid > 0 ? cid : 'first'}\u0000`;
    for (const key of [...cache.keys()]) {
        if (key.startsWith(`${bvid}${suffix}`)) cache.delete(key);
    }
};

/**
 * 把一条队列里所有投稿的流都取回来。
 *
 * 串行没有必要（它们互不依赖），但也不该一次全发出去 —— 一下就几十个请求。
 * 这里分小批推，先取靠前的几首（下一首最可能要），再补后面。
 */
export const prefetchQueueStreams = (songs: readonly unknown[], quality = 'standard'): void => {
    if (!isBilibiliAvailable()) return;
    const targets: StreamTarget[] = [];
    const seen = new Set<string>();
    for (const song of songs) {
        const target = streamTargetOf(song);
        if (!target) continue;
        const key = cacheKeyOf(target.bvid || `ep${target.epId}`, quality, target.cid);
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push(target);
    }
    if (targets.length === 0) return;

    void (async () => {
        const BATCH = 3;
        for (let i = 0; i < targets.length; i += BATCH) {
            const slice = targets.slice(i, i + BATCH).filter(target =>
                !isFresh(cache.get(cacheKeyOf(target.bvid || `ep${target.epId}`, quality, target.cid))));
            if (slice.length > 0) {
                await Promise.all(slice.map(target =>
                    ensureStream(target.bvid, quality, target.cid, target.epId)));
            }
        }
    })();
};

/** 队列里某首已经不在了，就把它的缓存丢掉（歌单会一直变）。 */
export const dropStreamsExcept = (songs: readonly unknown[]): void => {
    const keep = new Set<string>();
    for (const song of songs) {
        const target = streamTargetOf(song);
        if (target) keep.add(target.bvid || `ep${target.epId}`);
    }
    for (const key of [...cache.keys()]) {
        if (!keep.has(key.split('\u0000')[0])) cache.delete(key);
    }
};

/**
 * 先替播放器把开头那一段取回来。
 *
 * 光把地址拿在手里还不够：`<video>` 换源之后仍要自己发起请求，从「拿到地址」到
 * 「第一帧出来」这段时间就是切歌时那块黑屏 / 转圈。这里提前取开头一小段，让浏览器的
 * 缓存里已经有货，切过去时立刻就有一帧可画。
 *
 * 只取开头，不取整条：一条 1080P 是几十上百兆，预取整条既费流量又没必要。播放器
 * 自己会接着往后要，而那时画面已经出来了。
 *
 * 失败一律不管：预热只是快一点，不是能不能播的前提。
 */
export const warmStreamCache = async (url: string, bytes = 512 * 1024): Promise<void> => {
    if (!url || !/^https?:/i.test(url)) return;
    try {
        await fetch(url, {
            headers: { Range: `bytes=0-${bytes - 1}` },
            // 要浏览器那份缓存，不要一个没人读的 Response。
            cache: 'default',
        });
    } catch {
        // 预热失败不影响播放。
    }
};
