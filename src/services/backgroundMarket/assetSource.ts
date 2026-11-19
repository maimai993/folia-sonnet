// src/services/backgroundMarket/assetSource.ts
//
// 背景市场：一张资源「从哪里取字节」。
//
// 下载与应用是两件事（见 apply.ts）：这里只负责把同一份字节交出去，
// 怎么落到各个目标上由 apply 决定。图片走 WebView 的 fetch 拿成 File，
// 两条上传链路（莫奈背景 / 莫奈肖像）收的都是 File，这是唯一可行的形式。
//
// 抽成接口是为了能在单测里换掉网络：见 test/unit/backgroundMarket/apply.test.ts
// 那条「勾 N 个目标只下载一次」的用例。

import { downloadNativeVideoLayerFile } from '../../platform/foliaNative';
import { emitBackgroundProgress } from './progress';

/** 市场资源在应用时用得到的全部信息。 */
export interface MarketAssetRef {
    /** 条目 id，用来给下载下来的文件起名。 */
    id: string;
    /** 下载地址（已经由 resolveMarketMediaUrl 解析好）。 */
    mediaUrl: string;
}

/** 一次下载的产出：图片是 File，视频是原生落盘后的本地路径。 */
export type MarketAsset =
    | { kind: 'image'; file: File }
    | { kind: 'video'; path: string | null; url: string | null };

/** 取字节的唯一入口。同一张资源在一次应用里只会调它一次。 */
export interface MarketAssetSource {
    /**
     * 把资源下到本地。
     *
     * 「下到了没有」由抛错表示，不返回 null —— 下载失败是整批失败，
     * 每个目标各报一次「下载失败」只会让用户看到同一句话三遍。
     */
    download(asset: MarketAssetRef): Promise<MarketAsset>;
}

const extensionOf = (mime: string): string => {
    if (mime.includes('png')) return 'png';
    if (mime.includes('webp')) return 'webp';
    if (mime.includes('gif')) return 'gif';
    return 'jpg';
};

/**
 * 把网络图抓成 File。
 *
 * 为什么不直接把远程 URL 塞进 <img>：站点图片地址带防盗链与临时签名，
 * 今天能看、过两天就 403。落成本地文件才稳，而且能和用户手选上传的图走同一条路。
 */
const fetchAsFile = async (url: string, name: string): Promise<File | null> => {
    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const total = Number(response.headers.get('content-length') || 0);
        if (!response.body) {
            const fallback = await response.blob();
            const type = fallback.type || 'image/jpeg';
            return new File([fallback], `${name}.${extensionOf(type)}`, { type });
        }
        /*
         * 按流读、边读边报进度：总长已知就报真实比例，不知道就按已读字节
         * 缓慢逼近 0.9（留出编码与写库那一段，和 progress.ts 的 5% 同一个道理）。
         */
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.byteLength;
            if (total > 0) {
                emitBackgroundProgress(Math.min(0.95, received / total));
            } else {
                emitBackgroundProgress(Math.min(0.9, received / (received + 2_000_000)));
            }
        }
        const type = response.headers.get('content-type') || 'image/jpeg';
        const blob = new Blob(chunks as BlobPart[], { type });
        /*
         * 读完了报满。图片通常只有几百 KB，一轮流可能一帧都刷不出来 ——
         * 不补这一下，进度条会停在 0% 或者停在某个中间值，看起来就是「没动」。
         */
        emitBackgroundProgress(0.95);
        return new File([blob], `${name}.${extensionOf(type)}`, { type });
    } catch {
        return null;
    }
};

/**
 * 真机上用的取字节方式。
 *
 * 视频一律走原生 `downloadVideoLayerFile`（落进视频层自己的 cache 目录）：
 *   · 几十上百 MB 的视频不方便在 WebView 里整个拿成 Blob；
 *   · 壁纸层要用同一份文件时，adoptDownloadedVideo 收的就是这个目录下的绝对路径。
 *
 * 注意这里**不碰视频层 store**：下载和应用分开之后，只有勾了「App 内」才该动那一层
 * （见 apply.ts 的 applyVideoToVisualizer）。
 */
export const createNativeMarketAssetSource = (): MarketAssetSource => ({
    download: async (asset) => {
        /*
         * 必须带 progressId：原生那边没有它就直接跳过发进度事件，
         * 几十 MB 的视频在界面上就是「一直转圈、进度条不动」。
         * 和桌面壁纸那条路用的是同一个 id —— 同一时刻只会有一个背景在下载。
         */
        const video = await downloadNativeVideoLayerFile(asset.mediaUrl, 'background-market');
        if (!video.ok || !video.url) {
            throw new Error(video.error ?? '视频下载失败');
        }
        return { kind: 'video', path: video.path, url: video.url };
    },
});

/**
 * 静图用的取字节方式：在 WebView 里把图抓成 File。
 *
 * 图片几百 KB，过不了桥也无所谓；两条上传链路（莫奈背景 / 莫奈肖像）收的都是 File。
 */
export const createImageMarketAssetSource = (): MarketAssetSource => ({
    download: async (asset) => {
        const file = await fetchAsFile(asset.mediaUrl, asset.id);
        if (!file) throw new Error('图片下载失败');
        return { kind: 'image', file };
    },
});
