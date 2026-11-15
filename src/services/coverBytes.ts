import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';

import { createNativeFetch, isNativeHttpFetchAvailable } from './nativeHttpFetch';

// src/services/coverBytes.ts
// 取**封面字节**这一件事，供「要把封面交给原生」的那几处共用。
//
// 要它的人都不在乎 URL，只在乎拿到像素：原生歌词壁纸要把它编成 base64 当模糊底图，
// 通知栏要一张 Bitmap（系统进程渲染通知，拿不到 WebView 的缓存也带不上鉴权）。两处
// 以前各写了一遍 `fetch(url, { credentials: 'include' })`，犯的是同一个错（见下）。
//
// ⭐**第一跳不带凭据**（`credentials` 默认 same-origin，跨域请求因此不带 cookie）。
//
// 封面图床从来不需要 cookie，而带凭据的请求撞上一个 `Access-Control-Allow-Origin: *`
// 会被浏览器**直接判死**：带凭据的请求里通配符不作数，服务端必须回具体的源（Fetch 规范
// 那次 CORS 检查的第 3 步）。于是那一家回通配符的图床在这一步必然 `TypeError: Failed to
// fetch` —— 壁纸 / 通知栏拿不到图，而别的平台看着好好的：它们有的走缓存里那份 blob 地址
// （同源），有的压根不下发 CORS 头、走的是下面那条原生路。
//
// 取不到再让**原生把图下载到磁盘**（#262）：一张封面动辄几 MB，整段过桥等于在 Java heap
// 里再放一份 1.33× 的 base64 副本 —— 那条路的峰值是响应体的 6~8 倍，256MB 堆的机器
// 几十 MB 就 OOM（#261）。下载到缓存目录后只回一个文件地址，字节不进桥。
//
// 自建服务（要 cookie 才给图的地址）下不了：Filesystem 的下载不带 WebView
// 的 cookie。所以最后仍保留一条过桥的兜底，但带上明确的上限。

/** 一张封面而已：卡住就换下一条路，别拖着调用方。 */
const COVER_FETCH_TIMEOUT_MS = 20_000;

/** 单张封面的上限。超过它就不是封面了，当没取到。 */
const COVER_MAX_BYTES = 12 * 1024 * 1024;

/** 封面缓存目录（Capacitor 的 Cache 目录下）、保留张数与总字节上限。 */
const COVER_CACHE_DIR = 'covers';
const COVER_CACHE_MAX_FILES = 96;
const COVER_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/** blob: / data: 只有页内这一条路可走（原生那边不认这两个协议）。 */
const isLocalBlobUrl = (url: string): boolean => (
    url.startsWith('blob:') || url.startsWith('data:')
);

/**
 * 文件头是不是一张图。
 *
 * 原生下载这条路**不带 WebView 的 cookie**，所以「要登录才给图」的地址会拿到一张
 * 200 的登录页 / 占位图；不校验就落盘，那份坏文件还会按 URL 哈希被永久复用，
 * 表现就是「这个平台的封面一直是空的」（而且比改动前更糟：以前那条路带 cookie）。
 * 只读前 16 字节判断，代价可以忽略。
 */
const isImageHeader = (bytes: number[]): boolean => {
    const at = (index: number): number => bytes[index] ?? -1;
    if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return true;                    // JPEG
    if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return true;  // PNG
    if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return true;                    // GIF
    if (at(0) === 0x42 && at(1) === 0x4d) return true;                                      // BMP
    if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46
        && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return true; // WEBP
    if (at(4) === 0x66 && at(5) === 0x74 && at(6) === 0x79 && at(7) === 0x70) return true;  // ftyp：AVIF / HEIC
    /*
     * 刻意不认 `<`（SVG）：HTML 登录页也以 `<` 开头，而登录页恰恰是这条路最容易拿到的
     * 东西。SVG 封面几乎没有，真遇到就交给带 cookie 的桥那条兜底。
     */
    return false;
};

/** 读文件头 16 字节判断它是不是图（读失败一律当「不是」）。 */
const looksLikeImage = async (path: string): Promise<boolean> => {
    try {
        const head = await Filesystem.readFile({ directory: Directory.Cache, path, offset: 0, length: 16 });
        const data = head.data;
        if (typeof data !== 'string' || data.length === 0) return false;
        const binary = atob(data);
        const bytes: number[] = [];
        for (let index = 0; index < binary.length; index += 1) bytes.push(binary.charCodeAt(index));
        return isImageHeader(bytes);
    } catch {
        return false;
    }
};

/**
 * 同一个 URL 落到同一个文件名，重复取直接命中磁盘缓存。
 *
 * 用 FNV-1a 而不是把 URL 编进文件名：URL 里有 `?` `/` `:`，当文件名用不了。
 */
const coverFileName = (url: string): string => {
    let hash = 2166136261;
    for (let index = 0; index < url.length; index += 1) {
        hash ^= url.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    const ext = (url.match(/\.(png|jpe?g|webp|avif|gif)(?:[?#]|$)/i)?.[1] ?? 'img').toLowerCase();
    return `${(hash >>> 0).toString(36)}.${ext}`;
};

/**
 * 缓存目录按「张数」和「总字节」双上限清，超出从最旧的开始删。
 *
 * 只看张数不够：一张封面最大 12MiB，96 张最坏能到 1GB 级。失败不影响取图。
 */
const pruneCoverCache = async (): Promise<void> => {
    try {
        const listing = await Filesystem.readdir({ directory: Directory.Cache, path: COVER_CACHE_DIR });
        const sized = listing.files
            .filter((entry) => entry.type === 'file')
            .map((entry) => ({
                name: entry.name,
                at: Number(entry.mtime ?? 0),
                size: Number(entry.size ?? 0),
            }))
            .sort((left, right) => left.at - right.at);
        let total = sized.reduce((sum, entry) => sum + entry.size, 0);
        let count = sized.length;
        let index = 0;
        while (index < sized.length && (count > COVER_CACHE_MAX_FILES || total > COVER_CACHE_MAX_BYTES)) {
            const victim = sized[index];
            index += 1;
            total -= victim.size;
            count -= 1;
            await Filesystem.deleteFile({
                directory: Directory.Cache,
                path: `${COVER_CACHE_DIR}/${victim.name}`,
            }).catch(() => undefined);
        }
    } catch {
        /* 清缓存失败不该影响取图。 */
    }
};

/**
 * 原生下载封面到缓存目录，再按同源地址读回字节。
 *
 * 字节始终在原生那一侧落盘，进 WebView 的只有一张图 —— 这正是 #262 要的分流。
 */
const fetchCoverViaNativeDownload = async (url: string): Promise<Blob | null> => {
    if (!Capacitor.isNativePlatform()) return null;
    const name = coverFileName(url);
    const path = `${COVER_CACHE_DIR}/${name}`;
    try {
        let uri: string | null = null;
        try {
            const kept = await Filesystem.stat({ directory: Directory.Cache, path });
            const keptSize = Number(kept.size);
            // 复用之前也要确认它真的是图：上一版可能已经把一张登录页写在这儿了。
            if (keptSize > 0 && keptSize <= COVER_MAX_BYTES && await looksLikeImage(path)) uri = kept.uri;
        } catch {
            /* 还没下过：往下走。 */
        }
        if (!uri) {
            await Filesystem.mkdir({ directory: Directory.Cache, path: COVER_CACHE_DIR, recursive: true })
                .catch(() => undefined);
            /*
             * ⚠️ `Filesystem.downloadFile` 没有「边下边数」的上限参数：它先把整份写进 Cache，
             * 之后才由下面的 stat 判断大小。所以真正拦住超大文件的是事后这一删 —— 与原生
             * `readCappedBody` 的边读边数不对称，但 Cache 目录本来就能被系统回收，可以接受。
             *
             * 请求头与桥那条兜底保持一致：有的图床见到没有 UA 的请求直接不给图。
             */
            const done = await Filesystem.downloadFile({
                url,
                directory: Directory.Cache,
                path,
                connectTimeout: 15_000,
                readTimeout: COVER_FETCH_TIMEOUT_MS,
                headers: {
                    Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
                    'User-Agent': typeof navigator !== 'undefined' ? navigator.userAgent : '',
                },
            });
            const stat = await Filesystem.stat({ directory: Directory.Cache, path });
            const size = Number(stat.size);
            if (!(size > 0) || size > COVER_MAX_BYTES || !(await looksLikeImage(path))) {
                // 不是图（登录页 / 占位图 / 半截文件）：删掉，交给下面带 cookie 的兜底。
                await Filesystem.deleteFile({ directory: Directory.Cache, path }).catch(() => undefined);
                return null;
            }
            uri = done.path ? `file://${done.path}` : stat.uri;
            void pruneCoverCache();
        }
        const response = await fetch(Capacitor.convertFileSrc(uri));
        if (!response.ok) return null;
        return await response.blob();
    } catch {
        return null;
    }
};

export const fetchCoverBytes = async (url: string): Promise<Blob | null> => {
    if (typeof fetch !== 'function' || !url) return null;
    const local = isLocalBlobUrl(url);

    try {
        const response = await fetch(url);
        if (response.ok) return await response.blob();
        if (local) return null;
    } catch {
        if (local) return null;
        /* 跨域被拦：交给下面那条原生路。 */
    }

    if (!local) {
        const downloaded = await fetchCoverViaNativeDownload(url);
        if (downloaded) return downloaded;
    }

    if (!local && isNativeHttpFetchAvailable()) {
        try {
            // 兜底才走桥（自建服务要 cookie），并且按封面的上限夹住 —— 不让一张图把 heap 撑爆。
            const response = await createNativeFetch(COVER_FETCH_TIMEOUT_MS, COVER_MAX_BYTES)(url, {
                headers: {
                    Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
                    /* OkHttp 不像浏览器那样自己补 UA，有的图床见到没有 UA 的请求直接不给图。 */
                    'User-Agent': typeof navigator !== 'undefined' ? navigator.userAgent : '',
                },
            });
            if (response.ok) return await response.blob();
        } catch {
            /* 原生那条也没拿到：走最后一次页内尝试。 */
        }
    }

    try {
        const response = await fetch(url, { credentials: 'include' });
        if (response.ok) return await response.blob();
    } catch {
        /* 三条路都拿不到：这一首就是没有封面可取。 */
    }
    return null;
};
