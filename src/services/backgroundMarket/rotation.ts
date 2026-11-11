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
import { applyMarketBackground } from './apply';
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

/** 把一张背景设进桌面壁纸（原生那层）。 */
const applyToWallpaper = async (item: BackgroundMarketItem, mediaUrl: string): Promise<boolean> => {
    if (item.kind === 'video') {
        /*
         * 旋转要带上 —— 壁纸站的视频几乎全是横屏。
         *
         * 手动应用那条路（apply.ts）会把用户在裁剪界面选的角度传下来；
         * 轮换没有界面，就沿用设置里已经存着的那个角度（没有则 0）。
         * 不传的话这个参数默认 0，等价于「永远不转」。
         */
        const rotation = useVisualizerSettingsStore.getState().wallpaperVideoRotation ?? 0;
        const ok = await downloadWallpaperVideoFromUrl(mediaUrl, rotation);
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
    /*
     * 「App 内」直接复用 apply.ts 那条路，图片和视频都交给它：
     * 图片走莫奈自定义图，视频走歌词后方的视频层。
     *
     * 以前这里自己写了一套「只挂 customImage」，视频会被跳过 ——
     * 表现就是「自动轮换选了视频，App 内那边不动」。
     */
    const appTargets = settings.targets.includes('visualizer') ? (['app'] as const) : ([] as const);
    let appApplied = false;
    if (appTargets.length > 0) {
        const result = await applyMarketBackground(item, [...appTargets]);
        appApplied = result.ok;
    }

    let applied = appApplied;
    for (const target of settings.targets) {
        if (target === 'wallpaper') {
            applied = (await applyToWallpaper(item, mediaUrl)) || applied;
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
