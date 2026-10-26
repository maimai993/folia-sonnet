// src/services/mediaCacheStore.ts
/**
 * 媒体缓存的安卓后端：字节放在 App 私有目录里，经本机回环服务读写。
 *
 * 为什么不能留在 IndexedDB：那里取出来的字节只能变成 `blob:` 地址，而原生播放器
 * （ExoPlayer）吃不下 `blob:` —— 于是「有缓存的歌」恰恰是最该交给原生播的那些，
 * 反而整首回落到 <audio>，均衡器与网页音频图照旧在工作，看上去就是「开了没生效」。
 * 放进私有目录后播放拿的是 `http://127.0.0.1:<port>/media-cache/<名字>`，
 * 原生播放器与 <audio> 都能读，开关怎么拨都用得上这份缓存。
 *
 * 为什么字节走 HTTP 而不是 Capacitor 桥：桥只有一条，几 MB 的 base64 压上去，
 * 其它平台会集体超时。回环服务（`LocalAudioServer`）本来就有，Range / CORS 都是现成的。
 *
 * 非安卓（网页 / 桌面）上端口拿不到，这里每一个函数都安静地返回空值，
 * 缓存照旧走 Electron 文件缓存或 IndexedDB。
 */

/*
 * 为什么不用 nativeLocalMusic 里那个 resolveNativeAudioServerPort：
 * 它 import 了 db，而 db 现在要 import 这个文件（统计与清除），绕起来就是一个环。
 * 端口解析本身很便宜、服务端 start 也幂等，这里自己缓存一份更省事。
 */
type FoliaNativeBridge = {
    localAudioServerPort?: () => Promise<{ port?: number }>;
    mediaCacheStats?: () => Promise<{ size?: number; count?: number }>;
    clearMediaCache?: () => Promise<void>;
    cacheAudioFromUrl?: (options: {
        cacheKey: string;
        url: string;
        limitBytes?: number;
        minDurationMs?: number;
    }) => Promise<{ stored?: number }>;
};

let cachedPort = 0;

const getNativePlugin = (): FoliaNativeBridge | null => {
    if (typeof window === 'undefined') return null;
    return ((window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } })
        .Capacitor?.Plugins?.FoliaNative as FoliaNativeBridge | undefined) ?? null;
};

const resolvePort = async (): Promise<number> => {
    if (cachedPort > 0) return cachedPort;
    const plugin = getNativePlugin();
    if (!plugin || typeof plugin.localAudioServerPort !== 'function') return 0;
    try {
        const response = await plugin.localAudioServerPort();
        const port = Number(response?.port) || 0;
        if (port > 0) cachedPort = port;
        return port;
    } catch {
        return 0;
    }
};

const MEDIA_CACHE_PATH = '/media-cache/';

const fnv1a = (value: string): string => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
};

/**
 * 把缓存 key 变成文件名。
 *
 * key 里带着歌名（`audio_qq_123_某某歌`），中文、空格、斜杠都有，绝不能直接拼进路径 ——
 * 所以先编码成 base64url（只含 `[A-Za-z0-9_-]`，服务端按白名单收口，路径穿越无从谈起）。
 * 极长的 key（超长歌名）退化为哈希，免得撞上文件系统的名字长度上限。
 */
const cacheFileName = (cacheKey: string): string => {
    if (!cacheKey) return '';
    if (typeof btoa !== 'function' || typeof TextEncoder === 'undefined') return '';
    let binary = '';
    try {
        // TextEncoder 一次给回 UTF-8 字节，btoa 只认 Latin-1，中间这步不能省。
        for (const byte of new TextEncoder().encode(cacheKey)) binary += String.fromCharCode(byte);
        const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        return encoded.length <= 200 ? encoded : `h${fnv1a(cacheKey)}`;
    } catch {
        return `h${fnv1a(cacheKey)}`;
    }
};

const buildUrl = async (
    cacheKey: string,
    query?: Record<string, string | number>,
): Promise<string | null> => {
    const port = await resolvePort();
    if (port <= 0) return null;
    const name = cacheFileName(cacheKey);
    if (!name) return null;
    let search = '';
    if (query) {
        for (const [key, value] of Object.entries(query)) {
            if (value === undefined || value === null || value === '') continue;
            search += `${search ? '&' : '?'}${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
        }
    }
    return `http://127.0.0.1:${port}${MEDIA_CACHE_PATH}${name}${search}`;
};

/** 这台机器上有没有这份私有目录缓存后端。 */
export const hasNativeMediaCache = async (): Promise<boolean> => (await resolvePort()) > 0;

/**
 * 这份缓存的播放地址；不存在时返回 null。
 *
 * 原生播放器与 <audio> 都能读它 —— 所以调用方不需要先问「原生播放开了没有」。
 */
export const readNativeMediaCacheUrl = async (cacheKey: string): Promise<string | null> => {
    const url = await buildUrl(cacheKey);
    if (!url) return null;
    try {
        const response = await fetch(url, { method: 'HEAD' });
        return response.ok ? url : null;
    } catch {
        return null;
    }
};

/** 副本的字节数；不存在返回 0。 */
export const statNativeMediaCache = async (cacheKey: string): Promise<number> => {
    const url = await buildUrl(cacheKey);
    if (!url) return 0;
    try {
        const response = await fetch(url, { method: 'HEAD' });
        if (!response.ok) return 0;
        return Number(response.headers.get('content-length')) || 0;
    } catch {
        return 0;
    }
};

/** 把整首歌的字节写进私有目录。`limitBytes` 是写完之后要裁到的上限，0 表示不裁。 */
export const writeNativeMediaCache = async (
    cacheKey: string,
    blob: Blob,
    limitBytes: number,
): Promise<boolean> => {
    const url = await buildUrl(cacheKey, { limit: Math.max(0, Math.round(limitBytes)) });
    if (!url) return false;
    try {
        const response = await fetch(url, {
            method: 'PUT',
            // Content-Type 决定落盘的扩展名，也就决定了读回时的 Content-Type。
            headers: { 'Content-Type': blob.type || 'audio/mpeg' },
            body: blob,
        });
        return response.ok;
    } catch {
        return false;
    }
};

/**
 * 读回字节（分析、分离音轨那些路要的是真字节，不是地址）。
 * 不存在或读失败返回 null，让调用方退回 IndexedDB 那一层。
 */
export const readNativeMediaCacheBlob = async (cacheKey: string): Promise<Blob | null> => {
    const url = await buildUrl(cacheKey);
    if (!url) return null;
    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const blob = await response.blob();
        return blob.size > 0 ? blob : null;
    } catch {
        return null;
    }
};

/**
 * 删掉这份副本。
 *
 * 给了 `size` 时只在这个长度上才删：调用方要删的是它读到的那一份，
 * 期间被写进来的新副本（一首歌播完时写的）不是它 —— 服务端按长度比对，不等就回冲突。
 */
export const deleteNativeMediaCache = async (cacheKey: string, size?: number): Promise<boolean> => {
    const url = await buildUrl(cacheKey, size && size > 0 ? { size } : undefined);
    if (!url) return false;
    try {
        const response = await fetch(url, { method: 'DELETE' });
        return response.ok;
    } catch {
        return false;
    }
};

/*
 * 占用统计与整体清除。
 *
 * 字节搬出 IndexedDB 之后，那边按数据库算出来的占用会恒为 0 —— 设置页看起来就像
 * 「缓存里什么都没有」。这两个走桥（只传两个数字，很轻），和上面那些走 HTTP 的分开。
 */

/** 私有目录里有多少份副本、共多少字节。拿不到（非安卓 / 老版本包）返回 null。 */
export const getNativeMediaCacheStats = async (): Promise<{ size: number; count: number } | null> => {
    const plugin = getNativePlugin();
    if (!plugin || typeof plugin.mediaCacheStats !== 'function') return null;
    try {
        const result = await plugin.mediaCacheStats();
        return { size: Number(result?.size) || 0, count: Number(result?.count) || 0 };
    } catch {
        return null;
    }
};

/** 清空整个私有目录缓存。 */
export const clearNativeMediaCache = async (): Promise<void> => {
    const plugin = getNativePlugin();
    if (!plugin || typeof plugin.clearMediaCache !== 'function') return;
    try {
        await plugin.clearMediaCache();
    } catch {
        // 清不掉就留着，下次「清除缓存」还会再清一遍。
    }
};

/**
 * 原生侧整首歌落盘：让原生自己从 URL 下载，不经 Web 的手。
 *
 * 以前写缓存的是 Web（fetch 字节再 PUT 回回环服务），应用退后台 / WebView 冻结时
 * 这条路经常没机会跑完。挪到原生之后谁叫一声都能存；文件名编码两边一致，
 * 存出来的就是同一批文件，读回路径不用改。
 *
 * `minDurationMs` 是防试听片段的：原生会用 MediaExtractor 探下载文件的时长，
 * 不足歌长一半的不落盘（stored 回 0）。
 */
export const cacheNativeMediaFromUrl = async (
    cacheKey: string,
    url: string,
    limitBytes: number,
    minDurationMs?: number,
): Promise<boolean> => {
    const plugin = getNativePlugin();
    if (!plugin || typeof plugin.cacheAudioFromUrl !== 'function') return false;
    try {
        const result = await plugin.cacheAudioFromUrl({
            cacheKey,
            url,
            limitBytes: Math.max(0, Math.round(limitBytes)),
            ...(minDurationMs && minDurationMs > 0 ? { minDurationMs: Math.round(minDurationMs) } : {}),
        });
        return Number(result?.stored) > 0;
    } catch {
        return false;
    }
};
