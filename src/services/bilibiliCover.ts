import { nativeHttpRequest } from './nativeAndroidBridge';

// src/services/bilibiliCover.ts
//
// B 站的封面摆到 <img> 上为什么走 data URL：
//
// i0.hdslb.com 的图床按热点封来源，WebView 的 <img> 直连隔三差五 403（探索页、
// 歌单、番剧季的封面全是这主机）。`<img>` 没法带 Referer，而 fetch 虽然能经原生桥
// 拿到字节（桥上没有同源限制，还能带上 B 站认的那个来源），但那张图每次渲染都要
// 再走一遍网络。所以这里把「封面地址 → data URL」包一层：字节经原生桥取回、当场
// 转 base64，`<img src>` 拿到的是一段自足的数据，图床的封禁从此和界面无关。
//
// 同一张封面在列表里会出现很多次（探索墙、歌单卡、播放条），所以按地址记一份：
// 在飞的那次不重复取，取完的记忆在页面活着期间一直有效 —— 封面不会变，失效的
// 概念只属于接口地址，不属于图。

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();
/** 记忆别无限涨：封面上百张时按插入序丢最老的。 */
const MAX_ENTRIES = 300;

const isHdslb = (url: string): boolean => {
    try {
        const host = new URL(url, location.href).hostname;
        return host === 'hdslb.com' || host.endsWith('.hdslb.com');
    } catch {
        return false;
    }
};

/**
 * B 站封面的展示地址。
 *
 * 是这家的图床就换 data URL（取不到回原地址，让它按老样子试）；别家的原样返回。
 * 异步 —— 第一次见到这张图时要等原生桥那一趟。
 */
export const bilibiliCoverUrl = async (url: string | null | undefined): Promise<string | null> => {
    if (!url) return null;
    if (!isHdslb(url)) return url;
    const hit = cache.get(url);
    if (hit) return hit;
    const running = inflight.get(url);
    if (running) return running;
    const task = (async (): Promise<string | null> => {
        try {
            const response = await nativeHttpRequest(url, {
                headers: { Referer: 'https://www.bilibili.com/', Origin: 'https://www.bilibili.com' },
            });
            if (!response.ok) throw new Error(`cover ${response.status}`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            // 图床只出 jpeg/png/webp/gif 这几种，类型看响应头，没有就按字节猜 jpeg。
            const mime = response.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
            let binary = '';
            const CHUNK = 0x8000;
            for (let i = 0; i < bytes.length; i += CHUNK) {
                binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
            }
            const dataUrl = `data:${mime};base64,${btoa(binary)}`;
            if (cache.size >= MAX_ENTRIES) {
                const oldest = cache.keys().next();
                if (!oldest.done) cache.delete(oldest.value);
            }
            cache.set(url, dataUrl);
            return dataUrl;
        } catch {
            // 取不到就给原地址：直连偶尔也通，总比没有图强。
            return url;
        } finally {
            inflight.delete(url);
        }
    })();
    inflight.set(url, task);
    return task;
};

/** 组件卸载等场合清一条的记忆；不给参数就全清。 */
export const forgetBilibiliCover = (url?: string): void => {
    if (url) cache.delete(url);
    else cache.clear();
};
