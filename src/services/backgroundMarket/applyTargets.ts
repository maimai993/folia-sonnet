// src/services/backgroundMarket/applyTargets.ts
//
// 背景市场「应用到哪」的目标列表与互斥规则（纯函数，不碰 store、不碰界面）。
//
// 为什么要有互斥：莫奈和漫游是两档吃同一张自定义图（`monetBackgroundImage`）的背景样式，
// 画面上同时只可能有一档在生效。两个都勾着，后应用的那个会把前一个换掉 ——
// 用户看到「勾了两个，只变了一个」，以为功能失灵。所以选了一个就自动取消另一个。
//
// 自动切换（应用完把可视化背景切到刚选的那一档）不在这里，它要碰 store，
// 在 apply.ts 的 applyMarketBackground 里做。

import type { BackgroundTarget } from '../../components/modal/settings/pages/integration/market/useBackgroundApplyTarget';

/** 「画面上的背景样式」这一组目标：互斥，application 时只切到其中一档。 */
const EXCLUSIVE_TARGETS: readonly BackgroundTarget[] = ['monet', 'nomand'];

/** 两档都吃这一份自定义图（见 useVisualizerBackgroundConfig 的 `customImage`）。 */
export const isExclusiveTarget = (target: BackgroundTarget): boolean => EXCLUSIVE_TARGETS.includes(target);

/**
 * 点一下某个目标之后的勾选结果。
 *
 * 普通目标照常来回切；莫奈与漫游互相顶掉 —— 勾上任一个，另一个就被取消，
 * 不会出现「两个都勾着」的状态。取消勾选不带连坐，点谁取消谁。
 */
export const toggleApplyTarget = <T extends BackgroundTarget>(picked: readonly T[], id: T): T[] => {
    if (picked.includes(id)) {
        return picked.filter(entry => entry !== id);
    }
    const kept = isExclusiveTarget(id)
        ? picked.filter(entry => !isExclusiveTarget(entry))
        : [...picked];
    return [...kept, id];
};

/**
 * 最终落到可视化页面上的那一档背景样式。
 *
 * 勾了哪一档就切到哪一档；勾着的那档不是图片（视频条目只给得出 `monet`）时也只有它。
 * 一个都没勾就返回 null，调用方照旧不动当前样式。
 */
export const visualizerBackgroundModeForTargets = (
    targets: readonly BackgroundTarget[],
): 'monet' | 'nomand' | null => {
    // 有 nomand 就用 nomand：toggleApplyTarget 保证两者不会同时在列表里，这里只是兜底。
    if (targets.includes('nomand')) return 'nomand';
    if (targets.includes('monet')) return 'monet';
    return null;
};
