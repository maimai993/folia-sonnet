// src/services/backgroundMarket/rotation.ts
//
// 背景随机轮换的执行器。
//
// 每一步都要**保证看得见**，这是这个功能最容易做错的地方：
//   · 桌面壁纸：下载文件只代表素材到位，还得让壁纸层知道「现在用视频 / 用图片」。
//   · 可视化页面：素材要挂到 `customImage` 上，并把背景模式切到莫奈（mode='monet'）
//     —— 莫奈是吃自定义图片的那一档；停在别的模式上，图传下去了也画不出来。
//
// 所以这里不是「下载完就算」，而是下载 → 设素材 → 切模式，三步都做完才算成功。

import { useVisualizerSettingsStore } from '../../stores/useVisualizerSettingsStore';
import { useVisualizerAssetStore } from '../../stores/useVisualizerAssetStore';
import { useMarketRotationStore, rotationAllows } from '../../stores/useMarketRotationStore';
import { getMarketSource } from './index';
import { fetchMarketPage, resolveMarketMediaUrl, type BackgroundMarketItem } from './index';
import { isCapacitorAndroid } from '../../platform/runtime';
import {
    downloadWallpaperImageFromUrl,
    downloadWallpaperVideoFromUrl,
} from '../../platform/foliaWallpaper';

/**
 * 各源浅取一页来凑候选池。
 *
 * 轮换不需要完整目录，一页就够抽出差异明显的几张；
 * 多取几个源是因为单一源可能整页都是同一种类型（比如 Moewalls 全视频）。
 */
const SOURCE_PAGES = [
    { source: 'moewalls' as const, category: '' },
    { source: 'haowallpaper' as const, category: '' },
    { source: 'bizhihui' as const, category: '' },
];

/** 背景模式里能吃自定义图片的那一档。 */
const CUSTOM_IMAGE_MODE = 'monet';

export interface RotationStepResult {
    ok: boolean;
    /** 这一轮选中的条目，用于界面上显示「刚换成什么」。 */
    item: BackgroundMarketItem | null;
    error: string | null;
}

/**
 * 把一张背景设进可视化页面。
 *
 * 网页层没有原生那种「壁纸背景」的概念，它读的是 `customImage` + 背景模式。
 * 所以这里必须两步都做：素材挂上去，模式切到莫奈。
 */
const applyToVisualizer = (item: BackgroundMarketItem, mediaUrl: string): void => {
    /*
     * 可视化页面只能显示静态图。视频在网页层要额外接一套播放器，
     * 所以视频轮换只落到桌面壁纸上 —— 这里如实跳过，不假装成功。
     */
    useVisualizerAssetStore.getState().setMonetBackgroundImage({
        id: item.id,
        name: item.name,
        url: mediaUrl,
    });
    useVisualizerSettingsStore.getState().handleSetVisualizerBackgroundMode(CUSTOM_IMAGE_MODE);
};

/** 把一张背景设进桌面壁纸（原生那层）。 */
const applyToWallpaper = async (item: BackgroundMarketItem, mediaUrl: string): Promise<boolean> => {
    if (item.kind === 'video') {
        const ok = await downloadWallpaperVideoFromUrl(mediaUrl);
        if (ok) {
            useVisualizerSettingsStore.getState().handleSetLyricsWallpaperBackground('video');
        }
        return ok;
    }
    const ok = await downloadWallpaperImageFromUrl(mediaUrl);
    if (ok) {
        useVisualizerSettingsStore.getState().handleSetLyricsWallpaperBackground('image');
    }
    return ok;
};

/**
 * 执行一次轮换。
 *
 * 会自己从市场里挑一条符合当前设置的背景并应用。挑不到就算失败，
 * 不静默留着上一张 —— 那样用户会以为功能坏了。
 */
export const runRotationStep = async (): Promise<RotationStepResult> => {
    const settings = useMarketRotationStore.getState();
    if (!settings.enabled) {
        return { ok: false, item: null, error: null };
    }
    if (!isCapacitorAndroid()) {
        return { ok: false, item: null, error: '背景轮换目前只支持安卓' };
    }

    // 1. 凑候选池
    const candidates: BackgroundMarketItem[] = [];
    for (const entry of SOURCE_PAGES) {
        try {
            const page = await fetchMarketPage({ source: entry.source, page: 1, category: entry.category });
            for (const item of page.items) {
                if (rotationAllows(settings.mediaKind, item.kind)) {
                    candidates.push(item);
                }
            }
        } catch {
            // 某个源挂了不该让整轮失败，继续用其它源。
        }
    }
    if (candidates.length === 0) {
        return { ok: false, item: null, error: '没有符合条件的背景' };
    }

    // 2. 按 cursor 推进，避免连着抽到同一张。
    const item = candidates[settings.cursor % candidates.length];
    useMarketRotationStore.getState().advanceCursor();

    // 3. 拿真实地址
    let mediaUrl: string | null = null;
    try {
        mediaUrl = await resolveMarketMediaUrl(item);
    } catch {
        return { ok: false, item, error: '解析下载地址失败' };
    }
    if (!mediaUrl) {
        return { ok: false, item, error: '拿不到可下载的地址' };
    }

    // 4. 按目标落地
    let applied = false;
    for (const target of settings.targets) {
        if (target === 'wallpaper') {
            applied = (await applyToWallpaper(item, mediaUrl)) || applied;
        } else if (target === 'visualizer' && item.kind === 'image') {
            // 视频没法在网页可视化里播，只有图片能挂上去。
            applyToVisualizer(item, mediaUrl);
            applied = true;
        }
    }

    return applied
        ? { ok: true, item, error: null }
        : { ok: false, item, error: '应用失败' };
};

/** 一个源显示用（轮换提示里写「来自哪」）。 */
export const sourceLabelOf = (item: BackgroundMarketItem): string => (
    getMarketSource(item.source)?.label ?? item.source
);
