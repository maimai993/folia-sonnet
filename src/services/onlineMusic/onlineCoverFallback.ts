import type { SongResult, UnifiedSong } from '../../types';
import type { OmniProviderId } from '../../types/onlineMusic';
import { getPlaybackSourceRef } from '../../utils/appPlaybackGuards';
import { loadCachedOrFetchCover } from '../coverCache';
import { announceLocalCoverReady } from '../localCoverReadyEvent';
import { proxyNativeScopedResourceUrl, unregisterNativeRemoteAudioUrl } from '../nativeRemoteAudio';
import { getFeiniuResourceSession, isFeiniuCoverUrl, onFeiniuResourceSessionChange } from './feiniuTransport';
import type { FeiniuResourceSession } from './feiniuTransport';

// src/services/onlineMusic/onlineCoverFallback.ts
// 缺封面的歌，按名字去网络平台搜一张来顶。
//
// 起因是飞牛：它只是把 NAS 上的文件读成曲库，文件没嵌封面、目录里没有 cover.jpg，
// 接口就给不出 coverId —— 一整墙磁贴是占位图，播放页背景、控制面板背景、莫奈背景
// 也一起空着（它们取的都是同一张封面）。飞牛只负责出声，元数据谁有就用谁的：
// 拿歌名去别的平台搜一次，把匹配最高的那条的封面借过来。
//
// 为什么挂在**取封面**那一处、而不是某一个 provider 的出口：网格布局、墙面布局、队列
// 磁贴、控制面板、几处背景，全都经过 `getSongCoverUrl` 这一个入口。只在 provider 出口
// 补，队列里那份「建队时烤进去的快照」和就地算出来的那些背景照样是空的。
//
// 三条约束：
// 1. 结果一律缓存，**搜不到也缓存**（存空串）—— 否则每次渲染都要搜一遍；
// 2. 有预算 + 串行：搜索请求同样过那条共用的桥，一次并发几十个会把别的平台又挤一遍；
// 3. 拿到之后要**广播**：封面是异步来的，而队列磁贴的 `album.coverUrl` 是建队那一刻
//    烤进去的快照，不通知它就永远看不见（见 localCoverReadyEvent 里的说明）。

/** 按这个顺序借封面：网易的曲库最全，酷狗兜底。 */
const FALLBACK_PROVIDERS: OmniProviderId[] = ['netease', 'qq', 'kugou'];

/** 一次会话最多搜这么多次（命中缓存不算）。 */
const SEARCH_BUDGET = 120;

/** 一个列表一次最多同步等这么多首，剩下的交给异步那一路。 */
const PER_PAGE_LIMIT = 6;

/** 一个列表一次最多换这么多张封面地址（换地址很轻，但还是别一次几十个过桥）。 */
const PROXY_PER_PAGE_LIMIT = 24;

/** 一批最多处理这么多首：整页都过一遍，但别把一次翻页变成几百个请求。 */
const MAX_PER_BATCH = 60;

const coverCache = new Map<string, string>();
const pendingKeys = new Set<string>();

/** 走字节缓存那一路的封面：原地址 → 缓存出来的 blob URL（见 resolveByteFallbackCover）。 */
const byteFallbackCovers = new Map<string, string>();
/** 正在取的那批，避免同一张图在首屏被十几处同时触发下载。 */
const pendingByteFallback = new Set<string>();

let budget = SEARCH_BUDGET;

/** 串行闸门：渲染时一次会撞进来十几首，不能让它们同时去搜。 */
let chain: Promise<unknown> = Promise.resolve();

const cacheKey = (name: string, artist: string): string => `${name} ${artist}`;

/**
 * 搜到的结果是不是同一首歌。
 * 平台会给出一堆同名不同版本（live、翻唱、remix），所以互相包含就算 ——
 * 宁可借到一张近似封面，也不要整墙占位图。
 */
const isSameSong = (candidate: string, target: string): boolean => {
    const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, '');
    const left = normalize(candidate);
    const right = normalize(target);
    if (!left || !right) return false;
    return left === right || left.includes(right) || right.includes(left);
};

const artistNameOf = (song: SongResult | null | undefined): string => (
    Array.isArray(song?.artists) ? String(song?.artists?.[0]?.name ?? '') : ''
);

// ---------------------------------------------------------------------------
// 飞牛封面的「取得到」问题：地址是对的，但拿不到字节。
//
// 飞牛的封面地址形如 `http://NAS:5666/music/api/v1/static/cover?coverId=...`，
// 服务端**要 Cookie（music-token）才给图**。而拿它的两个地方都带不上：
//   · <img>/<audio> 这类元素根本没法挂请求头；
//   · 通知栏那一路是原生自己去下载的，它同样不知道 music-token 是什么。
// 于是界面上一片空、通知栏回落成 Folia 自己的图标 —— 看着就像「没有封面」。
//
// 项目里本来就有给音频用的回环代理（`registerRemoteAudio`）：注册一个地址，
// 由本地服务代转并带上指定的请求头。它是纯粹的字节转发，对图片一样成立，
// 而且换出来的地址是本机回环，原生下载它不需要任何凭据。
// ---------------------------------------------------------------------------

/** 代理只在当前会话内复用；歌曲保留原地址，避免队列快照携带旧账号代理。 */
const proxiedCovers = new Map<string, string>();
const pendingCovers = new Map<string, Promise<string>>();
onFeiniuResourceSessionChange(() => {
    for (const proxied of proxiedCovers.values()) void unregisterNativeRemoteAudioUrl(proxied);
    proxiedCovers.clear();
    proxiedCollectionCovers.clear();
    pendingCovers.clear();
});

const coverSession = (song: SongResult, url: string): FeiniuResourceSession | null => {
    const source = getPlaybackSourceRef(song);
    if (source.kind !== 'online' || source.providerId !== 'feiniu') return null;
    const session = getFeiniuResourceSession();
    return session && isFeiniuCoverUrl(url, session) ? session : null;
};

const proxyFeiniuCoverUrl = (url: string, session: FeiniuResourceSession): Promise<string> => {
    const cached = proxiedCovers.get(url);
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = pendingCovers.get(url);
    if (pending) return pending;
    const work = proxyNativeScopedResourceUrl(url, {
        headers: session.headers,
        credentialOrigin: session.origin,
    }).then(async (proxied) => {
        if (getFeiniuResourceSession() !== session) {
            if (proxied !== url) await unregisterNativeRemoteAudioUrl(proxied);
            return url;
        }
        // 无插件/注册失败不负缓存：稍后重试安全入口。
        if (proxied !== url) {
            proxiedCovers.set(url, proxied);
            // 原生注册表有容量上限；这里也限制持有量并撤销不再使用的凭据代理。
            while (proxiedCovers.size > 64) {
                const oldest = proxiedCovers.keys().next().value!;
                void unregisterNativeRemoteAudioUrl(proxiedCovers.get(oldest)!);
                proxiedCovers.delete(oldest);
            }
        }
        return proxied;
    }).finally(() => {
        if (pendingCovers.get(url) === work) pendingCovers.delete(url);
    });
    pendingCovers.set(url, work);
    return work;
};

/**
 * 同步换出「能真正拿到字节」的封面地址。
 *
 * 缓存里有就用缓存里的；没有就先返回原地址，同时**排一次代理** —— 拿到之后缓存
 * 并广播，界面下一次渲染就是代理地址（歌曲本身仍保留原地址）。渲染路径不能 await（那会把界面卡住），
 * 列表出口那一侧（见 {@link backfillSongCovers}）是 await 的，所以首屏通常直接就是好的。
 */
/** 集合（歌单 / 专辑）封面的代理缓存：与歌曲共用同一套换址逻辑，只是没有 song 可写回。 */
const proxiedCollectionCovers = new Map<string, string>();

/**
 * 集合封面的代理地址。与 {@link resolveProxiedSongCover} 同样的三条规矩（缓存、串行、广播），
 * 但集合没有可写回的对象，所以这里只回缓存：命中的下一次渲染就拿到代理地址，没命中先给原地
 * 址并排一次换址。
 */
export const resolveProxiedCollectionCover = (coverUrl: string | null | undefined): string => {
    const url = String(coverUrl ?? '').trim();
    const session = getFeiniuResourceSession();
    if (!url || !session || !isFeiniuCoverUrl(url, session)) return url;
    const cached = proxiedCollectionCovers.get(url);
    if (cached !== undefined) return cached;
    void proxyFeiniuCoverUrl(url, session).then((proxied) => {
        if (proxied === url || getFeiniuResourceSession() !== session) return;
        proxiedCollectionCovers.set(url, proxied);
    }).catch(() => {
        // 换不到就继续用原地址：下一次渲染会再试一次。
    });
    return url;
};

/**
 * 出列表时预热一批集合封面（{@link resolveProxiedCollectionCover} 的 await 版）：
 * 等前 {@link PROXY_PER_PAGE_LIMIT} 张换好，首屏直接就有图，不必等异步那一趟回来。
 */
export const prewarmCollectionCovers = async (
    covers: ReadonlyArray<string | null | undefined>,
): Promise<void> => {
    const session = getFeiniuResourceSession();
    if (!session) return;
    const targets = covers
        .map(cover => String(cover ?? '').trim())
        .filter(url => url && isFeiniuCoverUrl(url, session) && !proxiedCollectionCovers.has(url))
        .slice(0, PROXY_PER_PAGE_LIMIT);
    await Promise.all(targets.map(url => proxyFeiniuCoverUrl(url, session).then((proxied) => {
        if (proxied !== url && getFeiniuResourceSession() === session) {
            proxiedCollectionCovers.set(url, proxied);
        }
    }).catch(() => undefined)));
};

export const resolveProxiedSongCover = (song: SongResult, coverUrl: string): string => {
    const session = coverSession(song, coverUrl);
    if (!session) {
        // 这个平台之外的封面：地址本身是好的，但直连有时拿不到字节 —— 那些图床会按
        // Referer 防盗链、或者没下发 CORS 头，WebView 里 <img> 拉不下来就是空白或占位图。
        // 这里走一遍 coverCache：fetch 取字节存进 IndexedDB，回一个 blob URL。
        // 取不到就原样返回原地址，下一次渲染再试（和上面那条路同一个兜底姿势）。
        return resolveByteFallbackCover(song, coverUrl);
    }
    const cached = proxiedCovers.get(coverUrl);
    if (cached !== undefined) return cached;
    void proxyFeiniuCoverUrl(coverUrl, session).then((proxied) => {
        if (proxied === coverUrl || getFeiniuResourceSession() !== session) return;
        announceLocalCoverReady({ songId: String(song.id ?? ''), coverUrl: proxied });
    });
    return coverUrl;
};

/**
 * 其余平台的封面：用 coverCache 把字节存下来，换成 blob URL。
 *
 * 只在**真的拿不到**时才需要它，但「拿不到」在浏览器里没有可提前判断的信号
 * （`<img>` 的 onerror 我们不接管），所以这里对每个地址做一次尽力而为的缓存。
 * 缓存是幂等的：命中就立刻回同一个 blob URL，不会重复下载。
 */
function resolveByteFallbackCover(song: SongResult, coverUrl: string): string {
    const url = String(coverUrl || '').trim();
    // data:/blob: 已经是本地字节，没什么可代理的。
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) return coverUrl;
    const cacheKey = `cover_fallback_${url}`;
    const cached = byteFallbackCovers.get(url);
    if (cached !== undefined) return cached;
    if (!pendingByteFallback.has(url)) {
        pendingByteFallback.add(url);
        void loadCachedOrFetchCover(cacheKey, url).then((resolved) => {
            pendingByteFallback.delete(url);
            if (!resolved) return;
            byteFallbackCovers.set(url, resolved);
            // 和上面那条路一样要广播：队列磁贴存的是建队时的快照，不通知就看不到。
            if (resolved !== url) {
                announceLocalCoverReady({ songId: String(song.id ?? ''), coverUrl: resolved });
            }
        }).catch(() => {
            pendingByteFallback.delete(url);
        });
    }
    return coverUrl;
}

/**
 * 搜一次，取**匹配最高**的那条的封面。
 *
 * 搜索结果本身已按相关性排过序，所以「第一条有封面的」就是匹配最高的那个；
 * 只有当它连名字都对不上时，才退而求其次再找一条同名的。
 */
const searchBestCover = async (name: string, artist: string): Promise<string> => {
    // 动态 import：omni → providerRegistry → 各 provider → 本文件，顶层 import 会绕成环。
    const { omni } = await import('./omni');
    // 先只按歌名搜（带上歌手容易一条都搜不到），没结果再带歌手补一次。
    const queries = artist ? [name, `${name} ${artist}`] : [name];
    for (const query of queries) {
        for (const providerId of FALLBACK_PROVIDERS) {
            if (budget <= 0) return '';
            budget -= 1;
            try {
                const page = await omni.searchProviderSongs(providerId, query, { limit: 8, offset: 0 });
                const withCover = page.items.filter(item => typeof item?.album?.coverUrl === 'string' && item.album.coverUrl);
                if (withCover.length === 0) continue;
                const exact = withCover.find(item => isSameSong(String(item.name ?? ''), name));
                return String((exact ?? withCover[0]).album?.coverUrl ?? '');
            } catch (error) {
                // 这个平台没登录 / 搜不到，换下一个，不该影响出列表。
                // 但要留一句话：借不到封面时，这是唯一能看出「卡在哪个平台」的线索。
                console.warn('[CoverFallback] search failed on', providerId, 'for', name, error);
            }
        }
    }
    return '';
};

/**
 * 只按「歌名」借一张封面（歌单封面兜底用）。
 *
 * 与 {@link requestSongCoverFallback} 共用缓存与预算，只是入口从「一首歌」换成「一个名字」：
 * 汽水的歌单封面取不到字节（协议层已换成第一首歌的封面），而那一首自己也可能没封面，
 * 于是协议层把它的名字带出来，由这里去别的平台搜一张。没有 song 对象可写回，
 * 所以只返回地址、不广播 —— 调用方自己填进去。
 */
export const searchCoverBySongName = async (name: string, artist: string): Promise<string> => {
    const song = String(name ?? '').trim();
    if (!song || song === '未知标题') return '';
    const who = String(artist ?? '');
    const key = cacheKey(song, who);
    const cached = coverCache.get(key);
    if (cached !== undefined) return cached;
    if (budget <= 0) return '';
    const cover = await searchBestCover(song, who).catch(() => '');
    coverCache.set(key, cover);
    return cover;
};

/**
 * 异步给一首歌补封面。
 *
 * 拿到之后两件事都要做：原地写回 `song.album.coverUrl`（下一次同步读就有），
 * 以及广播「这首歌有封面了」—— 队列磁贴和几面墙要靠这一下才会重画。
 */
export const requestSongCoverFallback = (song: SongResult | null | undefined): void => {
    if (typeof window === 'undefined' || !song) return;
    const name = String(song.name ?? '').trim();
    if (!name || name === '未知标题') return;
    // 只补在线歌曲：本地歌有自己的一套（内嵌封面 / 在线匹配），别和它抢。
    if (getPlaybackSourceRef(song).kind !== 'online') return;

    const artist = artistNameOf(song);
    const key = cacheKey(name, artist);
    const cached = coverCache.get(key);
    // 缓存里已有结论：直接写回，不用再搜。
    if (cached !== undefined) {
        if (cached && song.album) song.album.coverUrl = cached;
        return;
    }
    if (pendingKeys.has(key) || budget <= 0) return;
    pendingKeys.add(key);

    const work = async () => {
        try {
            const cover = await searchBestCover(name, artist);
            coverCache.set(key, cover);
            if (!cover) return;
            if (song.album) song.album.coverUrl = cover;
            announceLocalCoverReady({ songId: String(song.id ?? ''), coverUrl: cover });
        } catch {
            coverCache.set(key, '');
        } finally {
            pendingKeys.delete(key);
        }
    };
    chain = chain.then(work, work).catch(() => undefined);
};

/**
 * 给一批曲目补封面（原地改，返回同一批）。
 *
 * 列表出口用：命中缓存的直接填上；没结论的交给异步那一路（它拿到之后会广播，
 * 界面自己重画），不在这里一首一首等 —— 等会把首屏拖住。
 */
export const backfillSongCovers = async <T extends UnifiedSong>(songs: T[], limit = PER_PAGE_LIMIT): Promise<T[]> => {
    let filled = 0;
    // 先整批把「有地址但取不到」的换成代理地址：注册很轻（不下字节），
    // 但一次几十个也会排队，所以还是给个上限，剩下的等翻页 / 渲染时那一路补。
    let proxied = 0;
    for (const song of songs) {
        if (proxied >= PROXY_PER_PAGE_LIMIT) break;
        const coverUrl = typeof song?.album?.coverUrl === 'string' ? song.album.coverUrl : '';
        const session = coverUrl ? coverSession(song, coverUrl) : null;
        if (!session) continue;
        const value = await proxyFeiniuCoverUrl(coverUrl, session);
        if (value !== coverUrl) proxied += 1;
    }

    // 整页都过一遍：头几首同步等（首屏就有图），其余的挂到异步那一路排队补齐 ——
    // 用户要的是「全部统一拉一遍缓存下来」，不是只补看得见的那几个。
    let processed = 0;
    for (const song of songs) {
        if (processed >= MAX_PER_BATCH) break;
        processed += 1;
        if (!song || song.album?.coverUrl) continue;
        const name = String(song.name ?? '').trim();
        if (!name || name === '未知标题') continue;

        const artist = artistNameOf(song);
        const key = cacheKey(name, artist);
        let cover = coverCache.get(key);
        // 同步等的那几位用完了就交给异步：它们拿到之后也会广播，界面自己会重画。
        if (cover === undefined && filled >= limit) {
            requestSongCoverFallback(song);
            continue;
        }
        if (cover === undefined && budget > 0) {
            // 同步等头几首：异步那一路要等界面重画才看得到，而列表 / 墙面在拿到数据后
            // 未必会再重画一次 —— 只靠广播的话，用户看到的就是「刷新了还是一片占位」。
            // 有缓存之后（第二次进同一个歌单）这里一次网络请求都不发。
            budget -= 1;
            cover = await searchBestCover(name, artist).catch(() => '');
            coverCache.set(key, cover);
            if (cover) announceLocalCoverReady({ songId: String(song.id ?? ''), coverUrl: cover });
        }
        if (!cover) {
            // 这一轮没轮到（超出限量）或预算用尽：挂到异步那一路，翻到 / 下次再补。
            requestSongCoverFallback(song);
            continue;
        }
        song.album = { ...(song.album ?? { id: '', name: '' }), coverUrl: cover };
        filled += 1;
    }
    return songs;
};
