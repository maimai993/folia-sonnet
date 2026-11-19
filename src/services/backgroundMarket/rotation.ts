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
import { useMarketRotationStore, rotationAllows, type RotationTarget } from '../../stores/useMarketRotationStore';
import { getMarketSource } from './index';
import { applyMarketBackground } from './apply';
import { fetchMarketPage, resolveMarketMediaUrl, type BackgroundMarketItem } from './index';
import { isCapacitorAndroid } from '../../platform/runtime';
import type { BackgroundTarget } from '../../components/modal/settings/pages/integration/market/useBackgroundApplyTarget';

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

export interface RotationStepResult {
    ok: boolean;
    /** 这一轮选中的条目，用于界面上显示「刚换成什么」。 */
    item: BackgroundMarketItem | null;
    error: string | null;
}

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
    return applyRotationStep(item, settings.targets);
};

/**
 * 把挑中的一条应用到轮换选中的每一处。
 *
 * 「App 内」和「桌面壁纸」两个目标都交给 apply.ts 的 applyMarketBackground ——
 * 它先下载一次，再把同一份素材分发给每一处（#428）。
 * 以前这里对两个目标各走一条下载：两边都勾时同一个视频/图片下两遍。
 *
 * apply.ts 不收 mediaUrl（它自己解析），所以这里在调它之前先确认地址拿得到：
 * 解析失败就是这一轮失败，不必让它再解析一次同一件事。
 */
const applyRotationStep = async (
    item: BackgroundMarketItem,
    rotationTargets: readonly RotationTarget[],
): Promise<RotationStepResult> => {
    const targets: BackgroundTarget[] = [];
    if (rotationTargets.includes('visualizer')) targets.push('app');
    if (rotationTargets.includes('wallpaper')) targets.push('wallpaper');
    if (targets.length === 0) {
        return { ok: false, item, error: '没有选中要应用到的地方' };
    }

    let mediaUrl: string | null;
    try {
        mediaUrl = await resolveMarketMediaUrl(item);
    } catch {
        return { ok: false, item, error: '解析下载地址失败' };
    }
    if (!mediaUrl) {
        return { ok: false, item, error: '拿不到可下载的地址' };
    }

    /*
     * 轮换没有界面，壁纸角度沿用设置里已经存着的那个（没有则 0）。
     * 手动应用那条路会把用户在裁剪界面选的角度传下来，这里没有这一步。
     */
    const rotation = useVisualizerSettingsStore.getState().wallpaperVideoRotation;
    const result = await applyMarketBackground(item, targets, rotation);
    return result.ok
        ? { ok: true, item, error: null }
        : { ok: false, item, error: result.error };
};

/** 一个源显示用（轮换提示里写「来自哪」）。 */
export const sourceLabelOf = (item: BackgroundMarketItem): string => (
    getMarketSource(item.source)?.label ?? item.source
);
