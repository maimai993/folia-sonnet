import { getStoredString, setStoredString } from '../../stores/storagePrimitives';
import {
    deleteNativeMediaCache,
    hasNativeMediaCache,
    readNativeMediaCacheUrl,
    statNativeMediaCache,
} from '../mediaCacheStore';
import { cacheLimitBytes } from '../audioCache';
import type { BilibiliMvStream } from '../../types/bilibili';

// src/services/bilibili/mvMediaCache.ts
//
// MV 的音轨与画面**一起**缓存，并且绑定同一份身份。
//
// 为什么要有它：MV 模式下一条投稿的画面和声音都只是「经本机中转的签名直链」，
// 一个字节都不落盘（VideoStreamProxy.kt 只转发）。于是每次进播放页、每次切回来、
// 每次重启都要重新取流、重新从 CDN 下载一遍 —— 一条 MV 十几到几十兆。
//
// 为什么必须**绑定**：bilibili 的 DASH 把画面与声音拆成两条流，地址各自带签名、
// 各自会过期。如果两半分别缓存，就可能出现「画面是这条投稿的、声音是上一条的」，
// 听起来是音画对不上、甚至是另一首歌。所以一份缓存条目里两半同进同出：
// 身份（bvid + cid + 清晰度）任一项与当前要放的 MV 不符，整份作废、重新拉。
//
// 只服务「给一首非 B 站平台的歌配 MV」这一条路。用户直接在 B 站平台下点开当歌听的
// 投稿（BilibiliVideoStage 那一类）不参与 —— 那些是看一遍就不看的素材，不该占缓存。

/** 一份 MV 缓存的绑定：这四样一致才复用，少一样都算不属于当前这首歌。 */
export interface MvMediaIdentity {
    bvid: string;
    cid: number;
    /** 画面高度（360 / 480 / 720 / 1080 …）。换档就是另一条流。 */
    quality: number;
}

/**
 * 这一条 MV 该不该进缓存。
 *
 * 只服务「给一首**别的平台**的歌找一条 MV」这条路径（BilibiliMvLayer → loadStreamForBvid）。
 * 用户在 B 站平台下直接点开当歌听的投稿（BilibiliVideoStage 那一类，「歌就是视频」）
 * **绝不进这里**：那些是他自己找来看的素材，看一遍就不看了，缓存它们只是白占空间、
 * 还会把真正想复用的 MV 按 LRU 挤掉。
 *
 * 这条判断在此处再表述一次（而不是只靠「没有调用方」），是因为将来的调用方未必知道
 * 这个边界 —— 准入条件写在缓存自己不依赖任何调用方约定的地方才守得住。
 *
 * @param songIsBilibiliPost 这首歌本身是不是一条 B 站投稿
 */
export const shouldCacheAsMv = (songIsBilibiliPost: boolean): boolean => !songIsBilibiliPost;

/** 绑定落盘的键：它记着「缓存的这一份属于哪条 MV」。 */
const BINDING_STORAGE_KEY = 'bilibili_mv_media_binding_v1';

/**
 * 当前盘上那一份 MV 缓存的绑定。
 *
 * 只存一个（而不是按 songKey 存一张表）：同一时刻只有一个背景在放，留多了就是几份
 * 十几兆的视频互相挤，而 LRU 又说不清该丢哪一份。切歌时新的一份直接覆盖旧的。
 */
interface StoredBinding extends MvMediaIdentity {
    /** 这条 MV 属于哪首歌（`title|||artist` 归一化后的 key）。 */
    songKey: string;
    /** 写进来的时刻（毫秒）。 */
    storedAt: number;
}

const readBinding = (): StoredBinding | null => {
    try {
        const raw = getStoredString(BINDING_STORAGE_KEY, '');
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        const value = parsed as Partial<StoredBinding>;
        if (!value.bvid || typeof value.cid !== 'number' || typeof value.quality !== 'number') return null;
        return {
            songKey: value.songKey ?? '',
            bvid: value.bvid,
            cid: value.cid,
            quality: value.quality,
            storedAt: typeof value.storedAt === 'number' ? value.storedAt : 0,
        };
    } catch {
        return null;
    }
};

const writeBinding = (binding: StoredBinding): void => {
    try {
        setStoredString(BINDING_STORAGE_KEY, JSON.stringify(binding));
    } catch {
        // 存不下：这一份缓存下次会被当成「不知道属于谁」而作废，不影响这次播放。
    }
};

const clearBinding = (): void => {
    try {
        setStoredString(BINDING_STORAGE_KEY, '');
    } catch {
        // 清不掉就留着，下次比对时照样会因为不一致而作废。
    }
};

/** 音轨与画面各自的缓存键。绑定信息在键里，天然不会串到另一条投稿上。 */
export const mvVideoCacheKey = (identity: MvMediaIdentity): string =>
    `bili_mv_v_${identity.bvid}_${identity.cid}_${identity.quality}`;

export const mvAudioCacheKey = (identity: MvMediaIdentity): string =>
    `bili_mv_a_${identity.bvid}_${identity.cid}_${identity.quality}`;

const identityOf = (stream: BilibiliMvStream): MvMediaIdentity => ({
    bvid: stream.bvid,
    cid: stream.cid,
    quality: stream.quality,
});

/** 两份身份是不是同一条 MV、同一档。 */
export const sameMvIdentity = (a: MvMediaIdentity, b: MvMediaIdentity): boolean => (
    a.bvid === b.bvid && a.cid === b.cid && a.quality === b.quality
);

/**
 * 盘上那份缓存还配不配当前这条 MV。
 *
 * 任一项不符就是不配：换了投稿、换了清晰度、换了歌 —— 三种都当作「没有缓存」，
 * 调用方据此整份重拉。过期时间也在这里判：一条 MV 的字节虽然不会过期，但放太久了
 * 我们宁可重新取一次（与匹配结果那份缓存同一个取舍口径）。
 */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const isMvCacheBindingCurrent = (
    binding: StoredBinding | null,
    identity: MvMediaIdentity,
    songKey: string,
    now: number,
): boolean => {
    if (!binding) return false;
    if (!sameMvIdentity(binding, identity)) return false;
    // 绑定记着是哪首歌的：同一首歌才复用（换歌就算 bvid 撞了也不该用）。
    if (binding.songKey && binding.songKey !== songKey) return false;
    if (binding.storedAt > 0 && now - binding.storedAt >= MAX_AGE_MS) return false;
    return true;
};

/** 一份 MV 缓存命中后拿到的两个可播放地址。 */
export interface CachedMvMedia {
    videoUrl: string;
    audioUrl: string;
}

/**
 * 读一份**完整且匹配**的 MV 缓存：画面和声音都在、绑定也对，才一起返回。
 *
 * 只有一半命中也算没命中 —— 这正是「音视频一致性」的要求：宁可整份重拉，
 * 也不要放出一条画面配另一条声音的 MV。
 */
export const readCachedMvMedia = async (
    stream: BilibiliMvStream,
    songKey: string,
): Promise<CachedMvMedia | null> => {
    if (!stream.videoUrl) return null;
    const identity = identityOf(stream);
    const binding = readBinding();
    if (!isMvCacheBindingCurrent(binding, identity, songKey, Date.now())) {
        // 绑定对不上：这一份不属于当前这条 MV，整份丢掉再拉（见文件头的「为什么必须绑定」）。
        await dropCachedMvMedia();
        return null;
    }
    const videoUrl = await readNativeMediaCacheUrl(mvVideoCacheKey(identity));
    if (!videoUrl) {
        await dropCachedMvMedia();
        return null;
    }
    /*
     * 声音可能本来就没有：老投稿只有 durl，没有独立音轨（stream.audioUrl 为空）。
     * 那种情况画面有就够了 —— 发声交给歌曲本身，与没有缓存时同一条路。
     */
    const wantsAudio = Boolean(stream.audioUrl);
    const audioUrl = wantsAudio ? await readNativeMediaCacheUrl(mvAudioCacheKey(identity)) : '';
    if (wantsAudio && !audioUrl) {
        await dropCachedMvMedia();
        return null;
    }
    return { videoUrl, audioUrl: audioUrl ?? '' };
};

/**
 * 把这条 MV 的画面与声音一起落盘。
 *
 * `videoUrl` / `audioUrl` 是**已经能直接下载**的地址（调用方传原始 CDN 地址，不要传
 * 本机中转地址：中转是给播放器流式读的，不是给一次性整份下载用的 —— 那条路会下到
 * 一段 404 文本，缓存里于是躺着一份放不出来的东西）。
 *
 * 两半任一写失败就整份作废（连同已经写进去的那一半），不留「只有画面」的半份，
 * 否则下一次命中就会是半个 MV。
 */
export const writeCachedMvMedia = async (
    stream: BilibiliMvStream,
    songKey: string,
    sources: { videoUrl: string; audioUrl: string },
    options: { songIsBilibiliPost?: boolean } = {},
): Promise<boolean> => {
    if (!stream.bvid || !sources.videoUrl) return false;
    /*
     * 准入：这首歌本身是 B 站投稿时不缓存。
     *
     * 那是「歌就是视频」那条路（BilibiliVideoStage）：用户直接在 B 站点开当歌听的素材，
     * 看一遍就不看了 —— 缓存它只会白占空间、并按 LRU 把真正想复用的 MV 挤掉。
     * 见 [shouldCacheAsMv]。
     */
    if (!shouldCacheAsMv(Boolean(options.songIsBilibiliPost))) return false;
    if (!await hasNativeMediaCache()) return false;
    const identity = identityOf(stream);
    const limit = cacheLimitBytes();
    // 先清掉旧的：换了一条 MV 时旧的那份已经没用了，留着只是占地方。
    await dropCachedMvMedia();
    const videoOk = await writeMediaFromUrl(mvVideoCacheKey(identity), sources.videoUrl, limit);
    if (!videoOk) {
        await dropCachedMvMedia();
        return false;
    }
    if (sources.audioUrl) {
        const audioOk = await writeMediaFromUrl(mvAudioCacheKey(identity), sources.audioUrl, limit);
        if (!audioOk) {
            // 音轨写不进去就当整份没有：只有画面的一份会让下一次命中变成「有画面没声音」。
            await dropCachedMvMedia();
            return false;
        }
    }
    writeBinding({ ...identity, songKey, storedAt: Date.now() });
    return true;
};

/**
 * 让原生把一条地址整份下载进媒体缓存。
 *
 * 走原生而不是 Web 抓字节：应用退后台 / WebView 冻结时 Web 这条路常常跑不完，
 * 而 MV 是几十兆的东西。与 `mediaCacheStore.cacheNativeMediaFromUrl` 同一台后端，
 * 只是这里不设「试听片段」门槛 —— 视频站是 DASH 分片，时长探不准（见那边的注释）。
 */
const writeMediaFromUrl = async (cacheKey: string, url: string, limitBytes: number): Promise<boolean> => {
    // 有些地址已经是本机回环上的媒体缓存（重复缓存没有意义）。
    if (await readNativeMediaCacheUrl(cacheKey)) return true;
    return await cacheFromUrl(cacheKey, url, limitBytes);
};

/**
 * 原生「从 URL 下载进媒体缓存」的桥。
 *
 * 单独抽出来是为了让它成为**唯一**一处调用点：写 MV 缓存的两半只有它一条路，
 * 将来换成别的后端（桌面 / 网页）也只改这里。
 */
const cacheFromUrl = async (cacheKey: string, url: string, limitBytes: number): Promise<boolean> => {
    if (typeof window === 'undefined') return false;
    const plugin = (window as unknown as {
        Capacitor?: { Plugins?: Record<string, unknown> };
    }).Capacitor?.Plugins?.FoliaNative as {
        cacheAudioFromUrl?: (options: {
            cacheKey: string;
            url: string;
            limitBytes?: number;
            minDurationMs?: number;
        }) => Promise<{ stored?: number }>;
    } | undefined;
    if (!plugin || typeof plugin.cacheAudioFromUrl !== 'function') return false;
    try {
        /*
         * 视频站的 CDN 地址一律带取流签名（`deadline=` 那类），原生的「试听片段」判定
         * 对它们会放行（见 LocalAudioServer.storeMediaCacheFromUrl）—— 这里再显式不传
         * `minDurationMs`，避免 DASH 分片探不出时长被整份删掉。
         */
        const result = await plugin.cacheAudioFromUrl({
            cacheKey,
            url,
            limitBytes: Math.max(0, Math.round(limitBytes)),
        });
        return Number(result.stored) > 0;
    } catch (error) {
        console.warn('[MvCache] Failed to store the MV media', cacheKey, error);
        return false;
    }
};

/**
 * 丢掉这一份 MV 缓存（音轨 + 画面 + 绑定）。
 *
 * 三个地方会调：绑定对不上、只命中一半、缓存设置里清除。
 */
export const dropCachedMvMedia = async (): Promise<void> => {
    const binding = readBinding();
    clearBinding();
    if (!binding) return;
    const identity: MvMediaIdentity = {
        bvid: binding.bvid,
        cid: binding.cid,
        quality: binding.quality,
    };
    await deleteNativeMediaCache(mvVideoCacheKey(identity));
    await deleteNativeMediaCache(mvAudioCacheKey(identity));
};

/** 当前这份 MV 缓存占了多少字节（存储页那一行用）。量不到返回 0。 */
export const readMvMediaCacheBytes = async (): Promise<number> => {
    const binding = readBinding();
    if (!binding) return 0;
    const identity: MvMediaIdentity = {
        bvid: binding.bvid,
        cid: binding.cid,
        quality: binding.quality,
    };
    return await statBoth(identity);
};

const statBoth = async (identity: MvMediaIdentity): Promise<number> => {
    const video = await statNativeMediaCache(mvVideoCacheKey(identity));
    const audio = await statNativeMediaCache(mvAudioCacheKey(identity));
    return video + audio;
};

/** 给单测用：这份绑定是不是当前这条 MV 的（不碰磁盘）。 */
export const bindingMatches = (
    binding: StoredBinding | null,
    stream: BilibiliMvStream,
    songKey: string,
    now: number,
): boolean => isMvCacheBindingCurrent(binding, identityOf(stream), songKey, now);

export type { StoredBinding };
