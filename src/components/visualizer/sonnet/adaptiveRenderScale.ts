// src/components/visualizer/sonnet/adaptiveRenderScale.ts
// Sonnet 的自动降级阶梯（issue H12）。
//
// Sonnet 的分辨率原来完全由设置决定：设置面板允许拖到 2 倍，而低端机把 2 倍像素画满一屏
// 就是直接卡死 —— 用户并不知道该去哪一栏把倍数调下来。同仓的 machi 早就有按帧时逐级降级的
// 做法，Sonnet 一直没有，于是同一个产品里两个渲染器的性能策略是分叉的。
//
// 这里只做**决定**（把「降了几格」换算成一个更低的倍数），不做帧时采集，也不碰渲染：
// 判定复用 machi 的 stepMachiDegrade（它要处理动态刷新率、屏幕卡顿这些边界，没必要抄一份），
// 采集接在运行时的 ticker 上。纯函数才好在单测里把边界钉死。

import type { LyricRenderScale } from '../../../types';
import { LYRIC_RENDER_SCALES } from '../../../utils/lyricRenderQuality';

/**
 * 从用户选的倍数往下降的次序。
 *
 * `LYRIC_RENDER_SCALES` 是升序的档位表，降级就是往它前面走：2 → 1.5 → 1 → 0.75 → 0.5。
 * 走到 0.5 就到头了 —— 再往下画面糊得没法看，那时候该认命的是性能而不是画质。
 */
export const SONNET_DEGRADE_LADDER: readonly LyricRenderScale[] = LYRIC_RENDER_SCALES;

/**
 * 用户选的倍数降了 steps 格之后是多少。
 *
 * 只降不升：降级后的倍数永远不高于用户选的那个（用户没选 2 倍时，不会因为「降级」反而
 * 变成更清晰的画质）。已经到底或者本来就很低时原样返回。
 */
export const lowerRenderScale = (chosen: LyricRenderScale, steps: number): LyricRenderScale => {
    if (!Number.isFinite(steps) || steps <= 0) return chosen;
    const index = SONNET_DEGRADE_LADDER.indexOf(chosen);
    /* 不在档位表里（旧存档 / 手改 localStorage）：拿最接近的不超过它的档位。 */
    if (index < 0) {
        const fallback = SONNET_DEGRADE_LADDER
            .filter(value => value <= chosen)
            .reduce<LyricRenderScale | null>((best, value) => (best === null || value > best ? value : best), null);
        return fallback ?? SONNET_DEGRADE_LADDER[0]!;
    }
    const target = Math.max(0, index - Math.floor(steps));
    return SONNET_DEGRADE_LADDER[target]!;
};

/**
 * 这次该用哪个倍数。
 *
 * @param chosen      用户在设置里选的倍数（预览模式下调用方传 1）。
 * @param degrade     已经降了几格。
 * @param adaptive    用户有没有开「自动降级」。关着时一律用 chosen —— 有人就是要最高画质，
 *                    卡是他自己的选择，不该被系统悄悄改掉。
 * @param previewMode 预览（样式架小图、样式窗口、主题乐园）不参与降级：那是十几秒的小图，
 *                    降了也看不出省了什么，反而会和主画面不一致。
 */
export const resolveSonnetRenderScale = (
    chosen: LyricRenderScale,
    degrade: number,
    adaptive: boolean,
    previewMode: boolean,
): LyricRenderScale => {
    if (previewMode || !adaptive) return chosen;
    return lowerRenderScale(chosen, degrade);
};
