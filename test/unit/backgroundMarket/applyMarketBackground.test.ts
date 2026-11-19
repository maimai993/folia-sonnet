// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundMarketItem } from '@/services/backgroundMarket';
import type { BackgroundTarget } from '@/components/modal/settings/pages/integration/market/useBackgroundApplyTarget';

// test/unit/backgroundMarket/applyMarketBackground.test.ts
//
// 应用市场背景之后，画面上真的会变（#434）：勾了莫奈 / 漫游，可视化背景要切到那一档；
// 两档互斥，勾了一个另一个就被取消；两档吃的是同一份自定义图，只存一份、只下一次网络。
//
// 这个功能最容易出的错不是「没下载」，而是下载了却没切样式 ——
// 用户勾了但画面没变，只会以为功能坏了。

const mocks = vi.hoisted(() => ({
    fetchAsFileResponse: vi.fn(),
    resolveMarketMediaUrl: vi.fn(),
    downloadWallpaperImageFromUrl: vi.fn(),
    downloadWallpaperVideoFromUrl: vi.fn(),
    adoptDownloadedVideoAsWallpaperFile: vi.fn(),
    openLyricsWallpaperPicker: vi.fn(),
    downloadNativeVideoLayerFile: vi.fn(),
    uploadMonetBackgroundImage: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/platform/runtime', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/platform/runtime')>()),
    // 背景市场只认安卓；测试里就当自己是安卓。
    isCapacitorAndroid: () => true,
}));
// 只换掉真正写库的那个上传口，tuning.ts 还要的 monetBackgroundImageActions 保持原样。
vi.mock('@/components/visualizer/backgrounds/monet/imageUpload', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/visualizer/backgrounds/monet/imageUpload')>()),
    uploadMonetBackgroundImage: mocks.uploadMonetBackgroundImage,
}));
// 莫奈肖像那一份：写库的路（IndexedDB）在 jsdom 里没有，这里只认它被叫过没有。
vi.mock('@/services/monetPortraitImage', () => ({
    getMonetPortraitImage: vi.fn(async () => null),
    saveMonetPortraitImage: vi.fn(async () => undefined),
    clearMonetPortraitImage: vi.fn(async () => undefined),
    isSupportedMonetPortraitFile: () => true,
    buildStoredMonetPortraitImage: (file: File) => ({ id: 'portrait', name: file.name, mimeType: file.type, blob: file }),
}));
vi.mock('@/platform/foliaWallpaper', () => ({
    downloadWallpaperImageFromUrl: mocks.downloadWallpaperImageFromUrl,
    downloadWallpaperVideoFromUrl: mocks.downloadWallpaperVideoFromUrl,
    adoptDownloadedVideoAsWallpaperFile: mocks.adoptDownloadedVideoAsWallpaperFile,
    openLyricsWallpaperPicker: mocks.openLyricsWallpaperPicker,
}));
vi.mock('@/platform/foliaNative', () => ({
    downloadNativeVideoLayerFile: mocks.downloadNativeVideoLayerFile,
}));
vi.mock('@/services/backgroundMarket/progress', () => ({ emitBackgroundProgress: vi.fn() }));
vi.mock('@/services/backgroundMarket/index', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/services/backgroundMarket/index')>()),
    resolveMarketMediaUrl: mocks.resolveMarketMediaUrl,
}));

const { applyMarketBackground } = await import('@/services/backgroundMarket/apply');
const { useVisualizerSettingsStore } = await import('@/stores/useVisualizerSettingsStore');
const { useVideoLayerSettingsStore } = await import('@/stores/useVideoLayerSettingsStore');

/*
 * 应用里取图走 fetch 的流式读取，这里按同一条路给一份最小可用的响应
 * （一个 body reader + 一张小图）；流式进度本身不是这个测试要管的。
 *
 * 只在这里装一次，不进 beforeEach：`vi.unstubAllGlobals()` 在 afterEach 里，
 * 它会把 stub 整个摘掉，而 `clearAllMocks()` 又会把实现清空 ——
 * 两者叠加之下，在 beforeEach 里装好的实现第二遍就没了。
 */
vi.stubGlobal('fetch', mocks.fetchAsFileResponse);
mocks.fetchAsFileResponse.mockImplementation(async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
    let sent = false;
    return {
        ok: true,
        headers: { get: (name: string) => (name === 'content-type' ? 'image/jpeg' : '3') },
        body: {
            getReader: () => ({
                read: async () => {
                    if (sent) return { done: true, value: undefined };
                    sent = true;
                    return { done: false, value: new Uint8Array([1, 2, 3]) };
                },
            }),
        },
        blob: async () => blob,
    } as unknown as Response;
});

const imageItem: BackgroundMarketItem = {
    id: 'pic-1',
    name: '一张图',
    kind: 'image',
    source: 'haowallpaper',
    thumbnailUrl: 'https://example.test/thumb.jpg',
} as BackgroundMarketItem;

const targets = (...entries: BackgroundTarget[]) => entries;

const activeMode = () => useVisualizerSettingsStore.getState().visualizerBackgroundMode;

beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocks.resolveMarketMediaUrl.mockResolvedValue('https://example.test/pic.jpg');
    mocks.openLyricsWallpaperPicker.mockResolvedValue('opened');
    mocks.downloadWallpaperImageFromUrl.mockResolvedValue(true);
    vi.stubGlobal('fetch', mocks.fetchAsFileResponse);
    // 先停在一档与莫奈 / 漫游都不同的背景上，才看得出「切过去了」。
    useVisualizerSettingsStore.getState().handleSetVisualizerBackgroundMode('sora');
    useVisualizerSettingsStore.getState().handleSetNomandBackgroundTuning({ imageSource: 'cover-derived' });
    useVisualizerSettingsStore.getState().handleSetMonetBackgroundTuning({ backgroundSource: 'cover-derived' });
    // 「App 内」那段会改视频层。这里让它保持开着，断言那边看它有没有被关掉。
    // force 一次而不是 setState：后者遇到值没变就不写，会被上一轮的值留着。
    useVideoLayerSettingsStore.setState({ videoLayerEnabled: true }, false);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('applyMarketBackground：应用后自动切到该背景', () => {
    it('勾「歌词样式·莫奈」之后，可视化背景切到 monet', async () => {
        const result = await applyMarketBackground(imageItem, targets('monet'));

        expect(`${result.ok}/${result.error}`).toBe('true/null');
        expect(activeMode()).toBe('monet');
    });

    it('勾「歌词样式·漫游」之后，可视化背景切到 nomand，且漫游的来源换成自定义图', async () => {
        const result = await applyMarketBackground(imageItem, targets('nomand'));

        expect(result.ok).toBe(true);
        expect(activeMode()).toBe('nomand');
        expect(useVisualizerSettingsStore.getState().nomandBackgroundTuning.imageSource).toBe('uploaded-global');
    });

    it('只勾桌面壁纸不动 App 内那一档背景样式', async () => {
        const result = await applyMarketBackground(imageItem, targets('wallpaper'));

        expect(result.ok).toBe(true);
        expect(activeMode()).toBe('sora');
    });

    it('莫奈 + 漫游同时传进来时只有一个结果，最后停在自己那一档上，不会来回跳', async () => {
        // 勾选规则（toggleApplyTarget）不会产出这种输入，这里兜底：仍然只有一个最终样式。
        await applyMarketBackground(imageItem, targets('monet', 'nomand'));

        expect(activeMode()).toBe('nomand');
    });

    it('应用失败时不切背景样式', async () => {
        mocks.resolveMarketMediaUrl.mockResolvedValue(null);

        const result = await applyMarketBackground(imageItem, targets('monet'));

        expect(result.ok).toBe(false);
        expect(activeMode()).toBe('sora');
    });
});

describe('applyMarketBackground：莫奈与漫游要的其实是同一张图', () => {
    it('勾漫游时图存进莫奈那份自定义图，漫游直接用它', async () => {
        await applyMarketBackground(imageItem, targets('nomand'));

        // 两档共用 `monetBackgroundImage`，单独勾漫游也要把它存上，否则漫游画不出这张图。
        expect(mocks.uploadMonetBackgroundImage).toHaveBeenCalledTimes(1);
        expect(useVisualizerSettingsStore.getState().nomandBackgroundTuning.imageSource).toBe('uploaded-global');
    });

    it('App 内 + 漫游同时勾时，同一张图只下一次网络', async () => {
        await applyMarketBackground(imageItem, targets('app', 'nomand'));

        expect(mocks.fetchAsFileResponse).toHaveBeenCalledTimes(1);
        expect(useVisualizerSettingsStore.getState().monetBackgroundTuning.backgroundSource).toBe('uploaded-global');
        expect(useVisualizerSettingsStore.getState().nomandBackgroundTuning.imageSource).toBe('uploaded-global');
        expect(activeMode()).toBe('nomand');
    });

    it('勾莫奈时会把盖在上面的视频层关掉', async () => {
        await applyMarketBackground(imageItem, targets('monet'));

        // 视频层不关的话，用户换了图也看不见 —— 看起来就是「换图没生效」。
        expect(useVideoLayerSettingsStore.getState().videoLayerEnabled).toBe(false);
    });

    it('勾漫游时同样会把叠在上面的视频层关掉', async () => {
        await applyMarketBackground(imageItem, targets('nomand'));

        expect(useVideoLayerSettingsStore.getState().videoLayerEnabled).toBe(false);
    });
});
