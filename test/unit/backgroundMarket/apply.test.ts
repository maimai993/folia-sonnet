// @vitest-environment jsdom
// test/unit/backgroundMarket/apply.test.ts
//
// 「勾 N 处只下载一次」这条约束钉在这里（#428）。
//
// 以前每个目标各自下载：只勾桌面壁纸时不走图片共用的那份，勾「App 内 + 莫奈」时
// 同一张图会走两遍网络。现在下载与应用分成两步，下载在 applyMarketBackground 里
// 只发生一次；这里把取字节的入口换成计数用的假实现，数它被调了几次。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const capacitorState = vi.hoisted(() => ({
    native: true,
    platform: 'android',
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        isNativePlatform: () => capacitorState.native,
        getPlatform: () => capacitorState.platform,
        isPluginAvailable: () => false,
        convertFileSrc: (path: string) => path,
    },
    // 各平台插件在模块加载时 registerPlugin，用不到真的实现。
    registerPlugin: () => new Proxy({}, { get: (_, key) => (key === 'addListener' ? async () => ({ remove: async () => {} }) : async () => undefined) }),
}));

// 视频那一半依赖视频层 store（卸载旧文件、写回环地址）。它的重置与落盘都跟单测无关，
// 这里只留最小可用的形状 —— 测的是「下载发生几次」和「有没有碰视频层」，不是 store 怎么存。
vi.mock('@/stores/useVideoLayerSettingsStore', () => {
    const state = {
        localFileUrl: null as string | null,
        localFileName: null as string | null,
        videoLayerUrl: '',
        videoLayerEnabled: false,
        /*
         * 这两个是**只有「App 内」才会用到**的写入点，单列出来计数：
         * 只勾桌面壁纸时它们一次都不该被调用。
         */
        setVideoLayerUrl: vi.fn(),
        setVideoLayerEnabled: vi.fn(),
        clearLocalFile: async () => {},
        setLocalFileDropped: () => {},
        setVideoLayerOpacity: () => {},
        setVideoLayerFit: () => {},
    };
    return { useVideoLayerSettingsStore: { getState: () => state } };
});

// 可视化设置 store 里的那两个上传 action 不走真实现（会去写 IndexedDB、发提示）。
vi.mock('@/components/visualizer/backgrounds/monet/imageUpload', () => ({
    uploadMonetBackgroundImage: async () => ({ ok: true }),
}));

/*
 * 设成「App 内」的图片这一路会写索引库，只留最小可用的形状。
 * 走真正的 store 会连带加载整个设置 store 的依赖图（二十多秒），
 * 而这条用例要钉的是「下载发生几次」，不是那张图最后存在哪儿。
 */
vi.mock('@/stores/useVisualizerSettingsStore', () => {
    const state = {
        monetBackgroundTuning: { backgroundSource: 'cover-derived' },
        monetTuning: { portraitSource: 'cover' },
        visualizerBackgroundMode: 'sora',
        handleUploadMonetPortraitImage: async () => ({ ok: true }),
        handleUploadMonetBackgroundImage: async () => ({ ok: true }),
        handleSetVisualizerBackgroundMode: (mode: string) => { state.visualizerBackgroundMode = mode; },
        handleSetMonetTuning: (tuning: unknown) => { state.monetTuning = tuning as typeof state.monetTuning; },
        handleSetMonetBackgroundTuning: (tuning: unknown) => { state.monetBackgroundTuning = tuning as typeof state.monetBackgroundTuning; },
        handleSetLyricsWallpaperBackground: () => {},
        handleSetWallpaperVideoRotation: () => {},
    };
    return { useVisualizerSettingsStore: { getState: () => state } };
});

const platform = vi.hoisted(() => ({
    adoptVideo: vi.fn(async () => true),
    downloadWallpaperImage: vi.fn(async () => true),
    downloadWallpaperVideo: vi.fn(async () => true),
    openPicker: vi.fn(async () => 'ok' as const),
}));

vi.mock('@/platform/foliaWallpaper', () => ({
    adoptDownloadedVideoAsWallpaperFile: platform.adoptVideo,
    downloadWallpaperImageFromUrl: platform.downloadWallpaperImage,
    downloadWallpaperVideoFromUrl: platform.downloadWallpaperVideo,
    openLyricsWallpaperPicker: platform.openPicker,
}));

import type { BackgroundMarketItem } from '@/services/backgroundMarket';
import type { BackgroundTarget } from '@/components/modal/settings/pages/integration/market/useBackgroundApplyTarget';
import type { MarketAsset, MarketAssetSource } from '@/services/backgroundMarket/assetSource';

/**
 * 计数用的假取字节实现。
 *
 * 每次 download 都记一笔，返回的素材可以按需注入（视频带不带本地路径）。
 */
const createCountingSource = (asset: MarketAsset) => {
    const downloads: string[] = [];
    const source: MarketAssetSource = {
        download: async (ref) => {
            downloads.push(ref.mediaUrl);
            return asset;
        },
    };
    return { source, downloads };
};

const imageFile = () => new File([new Uint8Array([1, 2, 3])], 'a.jpg', { type: 'image/jpeg' });

const imageItem: BackgroundMarketItem = {
    id: 'item-1',
    source: 'haowallpaper',
    sourceLabel: '壁纸汇',
    kind: 'image',
    name: '示例图片',
    mediaUrl: 'https://cdn.example.com/a.jpg',
    thumbnailUrl: 'https://cdn.example.com/a_thumb.jpg',
    detailUrl: 'https://cdn.example.com/a.html',
};

const videoItem: BackgroundMarketItem = {
    ...imageItem,
    id: 'item-2',
    kind: 'video',
    name: '示例视频',
    mediaUrl: 'https://cdn.example.com/b.mp4',
};

const ALL_TARGETS: BackgroundTarget[] = ['wallpaper', 'app', 'monet'];

/** 枚举所有非空的目标组合。 */
const combinations = (targets: BackgroundTarget[]): BackgroundTarget[][] => {
    const result: BackgroundTarget[][] = [];
    for (let mask = 1; mask < (1 << targets.length); mask += 1) {
        result.push(targets.filter((_, index) => Boolean(mask & (1 << index))));
    }
    return result;
};

const resetPlatform = async () => {
    capacitorState.native = true;
    capacitorState.platform = 'android';
    platform.adoptVideo.mockClear();
    platform.downloadWallpaperImage.mockClear();
    platform.downloadWallpaperVideo.mockClear();
    platform.openPicker.mockClear();
    /*
     * 视频层那两个写入点也是跨用例累积的 vi.fn —— 不清的话，
     * 「只勾桌面壁纸不该碰视频层」这条会被前面用例的调用数顶掉。
     */
    const { useVideoLayerSettingsStore } = await import('@/stores/useVideoLayerSettingsStore');
    const writes = useVideoLayerSettingsStore.getState() as unknown as Record<string, { mockClear?: () => void }>;
    writes.setVideoLayerUrl?.mockClear?.();
    writes.setVideoLayerEnabled?.mockClear?.();
};

describe('applyMarketBackground：下载只发生一次', () => {
    beforeEach(async () => {
        await resetPlatform();
    });

    it('图片：任意目标组合都只下载一次', async () => {
        const { applyMarketBackground } = await import('@/services/backgroundMarket/apply');
        for (const targets of combinations(ALL_TARGETS)) {
            const { source, downloads } = createCountingSource({ kind: 'image', file: imageFile() });
            const result = await applyMarketBackground(imageItem, targets, 0, source);
            expect(result.ok, `${targets.join('+')} 应当应用成功`).toBe(true);
            expect(downloads, `${targets.join('+')} 只该下载一次`).toHaveLength(1);
        }
    });

    it('视频：任意目标组合都只下载一次', async () => {
        const { applyMarketBackground } = await import('@/services/backgroundMarket/apply');
        const videoTargets: BackgroundTarget[] = ['wallpaper', 'app'];
        for (const targets of combinations(videoTargets)) {
            const { source, downloads } = createCountingSource({
                kind: 'video',
                path: '/data/videos/background-market.mp4',
                url: 'http://127.0.0.1:9300/video-layer',
            });
            const result = await applyMarketBackground(videoItem, targets, 270, source);
            expect(result.ok, `${targets.join('+')} 应当应用成功`).toBe(true);
            expect(downloads, `${targets.join('+')} 只该下载一次`).toHaveLength(1);
        }
    });

    it('只勾桌面壁纸：图片也走那一次下载，不再另外拉一遍', async () => {
        const { applyMarketBackground } = await import('@/services/backgroundMarket/apply');
        const { source, downloads } = createCountingSource({ kind: 'image', file: imageFile() });
        const result = await applyMarketBackground(imageItem, ['wallpaper'], 0, source);
        expect(result.ok).toBe(true);
        expect(downloads).toHaveLength(1);
        // 壁纸层自己那一次（原生压成 JPEG 落盘）仍然要有，但它是「应用」，不是下载。
        expect(platform.downloadWallpaperImage).toHaveBeenCalledTimes(1);
    });

    it('视频同时勾桌面壁纸和 App 内：壁纸层装的是那份已经下好的文件', async () => {
        const { applyMarketBackground } = await import('@/services/backgroundMarket/apply');
        const { source, downloads } = createCountingSource({
            kind: 'video',
            path: '/data/videos/background-market.mp4',
            url: 'http://127.0.0.1:9300/video-layer',
        });
        await applyMarketBackground(videoItem, ['wallpaper', 'app'], 270, source);
        expect(downloads).toHaveLength(1);
        expect(platform.adoptVideo).toHaveBeenCalledWith('/data/videos/background-market.mp4');
        expect(platform.downloadWallpaperVideo).not.toHaveBeenCalled();
    });

    it('视频只勾桌面壁纸：下载一次、不碰视频层、直接装那份文件', async () => {
        const { applyMarketBackground } = await import('@/services/backgroundMarket/apply');
        const { useVideoLayerSettingsStore } = await import('@/stores/useVideoLayerSettingsStore');
        const { source, downloads } = createCountingSource({
            kind: 'video',
            path: '/data/videos/background-market.mp4',
            url: 'http://127.0.0.1:9300/video-layer',
        });
        await applyMarketBackground(videoItem, ['wallpaper'], 270, source);
        expect(downloads).toHaveLength(1);
        expect(platform.adoptVideo).toHaveBeenCalledTimes(1);
        /*
         * 视频层是「App 内」那一处的东西，只设桌面壁纸不该碰它：
         * 回环地址写进去、开关打开，用户就会看到「只选了桌面壁纸，播放页也换了」。
         */
        const writes = useVideoLayerSettingsStore.getState() as unknown as {
            setVideoLayerUrl: ReturnType<typeof vi.fn>;
            setVideoLayerEnabled: ReturnType<typeof vi.fn>;
        };
        expect(writes.setVideoLayerUrl).not.toHaveBeenCalled();
        expect(writes.setVideoLayerEnabled).not.toHaveBeenCalled();
    });

    it('视频原生没回本地路径时，壁纸层退回按地址下载（唯一兜底）', async () => {
        const { applyMarketBackground } = await import('@/services/backgroundMarket/apply');
        const { source, downloads } = createCountingSource({
            kind: 'video',
            path: null,
            url: 'http://127.0.0.1:9300/video-layer',
        });
        await applyMarketBackground(videoItem, ['wallpaper', 'app'], 270, source);
        expect(downloads).toHaveLength(1);
        expect(platform.adoptVideo).not.toHaveBeenCalled();
        expect(platform.downloadWallpaperVideo).toHaveBeenCalledTimes(1);
    });
});

describe('applyMarketBackground：失败语义', () => {
    beforeEach(async () => {
        await resetPlatform();
    });

    it('下载失败：整批失败，报一次，不逐处重试同一个地址', async () => {
        const { applyMarketBackground } = await import('@/services/backgroundMarket/apply');
        const downloads: string[] = [];
        const source: MarketAssetSource = {
            download: async (ref) => {
                downloads.push(ref.mediaUrl);
                throw new Error('network down');
            },
        };
        const result = await applyMarketBackground(imageItem, ALL_TARGETS, 0, source);
        expect(result.ok).toBe(false);
        expect(result.error).toBe('图片下载失败');
        expect(downloads).toHaveLength(1);
        // 一处都没应用：下载都没成，不该去碰任何目标。
        expect(platform.downloadWallpaperImage).not.toHaveBeenCalled();
    });

    it('应用失败只影响那一处：壁纸层失败时「App 内」照常应用', async () => {
        const { applyMarketBackground } = await import('@/services/backgroundMarket/apply');
        platform.downloadWallpaperImage.mockResolvedValueOnce(false);
        const { source, downloads } = createCountingSource({ kind: 'image', file: imageFile() });
        const result = await applyMarketBackground(imageItem, ['wallpaper', 'app'], 0, source);
        expect(downloads).toHaveLength(1);
        // 有一处成功就算整体成功（和改之前一样）。
        expect(result.ok).toBe(true);
        expect(result.error).toBeNull();
    });

    it('每一处都失败时，报第一处的原因', async () => {
        const { applyMarketBackground } = await import('@/services/backgroundMarket/apply');
        platform.adoptVideo.mockResolvedValueOnce(false);
        platform.downloadWallpaperVideo.mockResolvedValueOnce(false);
        const { source } = createCountingSource({ kind: 'video', path: null, url: null });
        const result = await applyMarketBackground(videoItem, ['wallpaper', 'app'], 0, source);
        expect(result.ok).toBe(false);
        // 顺序上「App 内」先跑，它报的是视频下载失败。
        expect(result.error).toBe('视频下载失败');
    });

    it('非安卓环境直接拒绝，不下载', async () => {
        capacitorState.native = false;
        capacitorState.platform = 'web';
        const { applyMarketBackground } = await import('@/services/backgroundMarket/apply');
        const { source, downloads } = createCountingSource({ kind: 'image', file: imageFile() });
        const result = await applyMarketBackground(imageItem, ['app'], 0, source);
        expect(result.ok).toBe(false);
        expect(downloads).toHaveLength(0);
    });
});
