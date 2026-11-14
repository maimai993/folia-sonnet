import { isBilibiliNativeAvailable, requestBilibiliNative } from '../../platform/foliaNative';

// src/services/bilibili/hdslbImage.ts
//
// B 站图床（hdslb.com）图片的取用层：字节经原生代理取回（带 B 站的 Referer，登录后
// 桥统一注入 cookie —— 风控认的是这套头），转成本地 blob URL 给 <img> / decode。
//
// 为什么不直连：i0.hdslb.com 按热点封来源，WebView 里 <img> 直连隔三差五 403（探索页、
// 歌单、番剧季的封面全是这主机），而 <img> 没法带 Referer / Cookie。
//
// 生命周期：blob URL 按「原地址 → blob」记一份，全页面共享 —— 探索墙同一张封面会
// 出现在多个卡片上，只取一次。撤销（revokeObjectURL）没有合适的时机（页面活着期间
// 随时可能再画），所以不做：一张封面几百 KB，300 张上限淘汰最老的，内存可控。

const MAX_ENTRIES = 300;

const blobUrls = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

const isHdslb = (url: string): boolean => {
    try {
        const host = new URL(url, location.href).hostname;
        return host === 'hdslb.com' || host.endsWith('.hdslb.com');
    } catch {
        return false;
    }
};

/** 是这家的图床吗（要换本地 blob 才能稳定显示）。 */
export const isHdslbImageUrl = (url: string | null | undefined): boolean => Boolean(url && isHdslb(url));

const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
};

const fetchAsBlobUrl = async (url: string): Promise<string | null> => {
    if (!isBilibiliNativeAvailable()) return null;
    const response = await requestBilibiliNative(url, {
        // 图床认的来源 —— 原生端默认就是 www.bilibili.com，这里显式写一遍免得以后变了。
        Referer: 'https://www.bilibili.com/',
    }, false);
    if (!response.ok) throw new Error(`hdslb image ${response.status}`);
    // 原生端按 content-type 分流：image/* 回 bodyBase64（FoliaBilibiliPlugin onResponse）。
    const base64 = response.bodyBase64;
    if (!base64) throw new Error('hdslb image: no body');
    const byteString = atob(base64);
    const bytes = new Uint8Array(byteString.length);
    for (let i = 0; i < byteString.length; i += 1) bytes[i] = byteString.charCodeAt(i);
    const mime = response.contentType?.split(';')[0]?.trim() || 'image/jpeg';
    const blob = new Blob([bytes], { type: mime });
    const blobUrl = URL.createObjectURL(blob);
    if (blobUrls.size >= MAX_ENTRIES) {
        const oldest = blobUrls.keys().next();
        if (!oldest.done) {
            const stale = blobUrls.get(oldest.value);
            if (stale) URL.revokeObjectURL(stale);
            blobUrls.delete(oldest.value);
        }
    }
    blobUrls.set(url, blobUrl);
    return blobUrl;
};

/**
 * B 站图床图片的本地展示地址。
 *
 * 取回过 → 直接给 blob URL；没有 → 异步取，取到后调用方下一次渲染就能拿到
 * （渲染路径不能 await，所以这一趟先回 null）。
 */
export const hdslbImageBlobUrl = (url: string): Promise<string | null> => {
    const cached = blobUrls.get(url);
    if (cached) return Promise.resolve(cached);
    const running = inflight.get(url);
    if (running) return running;
    const task = fetchAsBlobUrl(url)
        .catch(() => null)
        .finally(() => { inflight.delete(url); });
    inflight.set(url, task);
    return task;
};

/** 渲染出口的同步版：缓存里有就给，没有回 null（别处先排异步取）。 */
export const hdslbImageBlobUrlSync = (url: string): string | null => blobUrls.get(url) ?? null;

/** 预热：后台取一张，不问结果。 */
export const prewarmHdslbImage = (url: string): void => {
    if (blobUrls.has(url) || inflight.has(url)) return;
    void hdslbImageBlobUrl(url);
};

let fixerInstalled = false;

/**
 * 全局兜底：任何一张 <img> 加载失败且 src 是 B 站图床时，换成本地 blob 重试。
 *
 * 覆盖所有不走 useWallPosterArtwork 的渲染口（搜索结果卡、首页歌单卡、番剧季卡……）：
 * 逐个组件接 hook 不现实，就在 document 上用捕获阶段的 error 监听统一接。
 * 换不过来（桥不在、网络失败）就维持坏图 —— 和以前一样，不会更糟。
 */
export const installHdslbImageFixer = (): void => {
    if (fixerInstalled || typeof document === 'undefined') return;
    fixerInstalled = true;
    document.addEventListener('error', (event) => {
        const target = event.target as HTMLImageElement | null;
        const src = target?.src;
        if (!target || target.tagName !== 'IMG' || !src || !isHdslb(src)) return;
        // 已经是 blob（不该发生）就放手。
        if (src.startsWith('blob:') || src.startsWith('data:')) return;
        void hdslbImageBlobUrl(src).then((local) => {
            if (local && target.isConnected) target.src = local;
        });
    }, true);
};
