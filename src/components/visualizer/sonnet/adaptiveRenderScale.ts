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
import {
    createMachiDegradeState,
    stepMachiDegrade,
    type MachiDegradeState,
} from '../machi/engine/quality';

/**
 * 从用户选的倍数往下降的次序。
 *
 * `LYRIC_RENDER_SCALES` 是升序的档位表，降级就是往它前面走：2 → 1.5 → 1 → 0.75 → 0.5。
 * 走到 0.5 就到头了 —— 再往下画面糊得没法看，那时候该认命的是性能而不是画质。
 */
export const SONNET_DEGRADE_LADDER: readonly LyricRenderScale[] = LYRIC_RENDER_SCALES;

/**
 * 两次检查之间至少隔这么久（毫秒）。
 *
 * 和 machi 的 `DEGRADE_WINDOW_MS` 取同一个值：短了会把偶发掉帧当成卡顿。
 */
const SONNET_DEGRADE_WINDOW_MS = 2500;

/** 一次检查至少要攒够这么多个帧间隔（60fps 下约 1 秒），样本太少判不准。 */
const SONNET_DEGRADE_MIN_SAMPLES = 60;

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
 * 降级时该换成哪个倍数。
 *
 * 基准必须是**用户选的那个倍数**，不是当前生效的：`setRenderScale` 会就地改生效值，
 * 每帧都拿生效值当基准的话，降一次之后基准跟着降，于是自己一格接一格往下走，直到压到底。
 *
 * `maxSteps` 只做说明用 —— `lowerRenderScale` 自己会把格数钳到阶梯底部。
 */
export const resolveSonnetAdaptiveTarget = (
    base: LyricRenderScale,
    steps: number,
    maxSteps: number,
): LyricRenderScale => resolveSonnetRenderScale(base, Math.min(steps, maxSteps), true, false);

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

/**
 * 帧时采样与降级判定（issue H12）。
 *
 * 每帧喂一个帧间隔进来，超过门槛连着几次就返回「该降一格了」。判定本身复用 machi 的
 * `stepMachiDegrade` —— 动态刷新率、屏幕自己降帧率那些边界它都处理过了，抄一份只会分叉。
 *
 * 检查的纪律也和 machi 一致：**每 2.5 秒才看一次、并且攒够 60 个帧间隔**。少了这道节流，
 * 每帧都拿最近这一小段去判，会把「偶尔掉一帧」当成卡顿，一路降到底。
 *
 * 这个类不碰渲染、不认识 Pixi，所以能在单测里用假的帧间隔把行为钉死。
 */
export class SonnetAdaptiveQuality {
    private state: MachiDegradeState = createMachiDegradeState();
    private intervals: number[] = [];
    private degrade = 0;
    private lastFrameAt = 0;
    private checkedAt = 0;

    /** 换屏 / 换歌之后重新开始学：旧的帧间隔对新画面没有意义。 */
    reset(): void {
        this.state = createMachiDegradeState();
        this.intervals = [];
        this.degrade = 0;
        this.lastFrameAt = 0;
        this.checkedAt = 0;
    }

    get steps(): number {
        return this.degrade;
    }

    /**
     * 记一帧，返回「这次是否刚好降了一格」。
     *
     * @param now 这一帧的 performance.now()。
     * @param maxSteps 最多能降几格（阶梯长度 - 1）。
     */
    sample(now: number, maxSteps: number): boolean {
        const previous = this.lastFrameAt;
        this.lastFrameAt = now;
        if (previous <= 0) {
            this.checkedAt = now;
            return false;
        }
        const interval = now - previous;
        /*
         * 丢掉明显异常的间隔：`< 100ms` 排除的是一帧之外的空档（页面切走、JS 长时间阻塞），
         * 那些不是「渲染跟不上」，拿它们当证据会一路降到底。
         */
        if (!(interval > 0) || interval >= 100) {
            this.intervals.length = 0;
            this.checkedAt = now;
            return false;
        }
        this.intervals.push(interval);
        if (now - this.checkedAt < SONNET_DEGRADE_WINDOW_MS || this.intervals.length < SONNET_DEGRADE_MIN_SAMPLES) {
            return false;
        }
        this.checkedAt = now;
        const { state, degrade } = stepMachiDegrade(this.state, this.intervals);
        this.state = state;
        /*
         * 只有**真的降了一格**才清空。
         *
         * stepMachiDegrade 要求连续两次检查都超门槛才判定降级；第一次检查之后这些慢帧
         * 还要留给下一次看。每轮都清空的话永远凑不满连续两次 —— 帧时再差也一格都不降。
         */
        if (degrade) this.intervals.length = 0;
        if (!degrade || this.degrade >= maxSteps) return false;
        this.degrade += 1;
        return true;
    }
}

