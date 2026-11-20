// test/unit/visualizer/sonnetAdaptiveRenderScale.test.ts
// Sonnet 的自动降级阶梯（issue H12）。
//
// Sonnet 的分辨率原来完全由设置决定，低端机上没有任何自动收敛 —— 用户得自己知道去
// 「动画与性能」里把倍数拖下来，而这类用户通常不知道该调哪一项。machi 早就有逐级降级，
// Sonnet 没有，同一个产品两种策略。
//
// 这里钉住阶梯本身的行为：只降不升、到底就停、预览与「关掉自动降级」时原样不动。

import { describe, expect, it } from 'vitest';

import {
    lowerRenderScale,
    resolveSonnetAdaptiveTarget,
    resolveSonnetRenderScale,
    SONNET_DEGRADE_LADDER,
} from '@/components/visualizer/sonnet/adaptiveRenderScale';

describe('Sonnet 降级阶梯（H12）', () => {
    it('降 0 格就是原值', () => {
        expect(lowerRenderScale(2, 0)).toBe(2);
        expect(lowerRenderScale(0.5, 0)).toBe(0.5);
    });

    it('按档位表一格格往下走', () => {
        /* 2 → 1.5 → 1 → 0.75 → 0.5 */
        expect(lowerRenderScale(2, 1)).toBe(1.5);
        expect(lowerRenderScale(2, 2)).toBe(1);
        expect(lowerRenderScale(2, 3)).toBe(0.75);
        expect(lowerRenderScale(2, 4)).toBe(0.5);
        expect(lowerRenderScale(1.5, 1)).toBe(1);
        expect(lowerRenderScale(1, 1)).toBe(0.75);
    });

    it('降到底就停在最低档，不会降成 0 或负数', () => {
        expect(lowerRenderScale(2, 99)).toBe(SONNET_DEGRADE_LADDER[0]);
        expect(lowerRenderScale(0.5, 5)).toBe(0.5);
    });

    /*
     * 只降不升：用户选了 1 倍，降 3 格不该变成「更清晰」；已经比最低还低时也不往上抬。
     * 这条容易写错 —— 用下标减法时负下标会取到数组尾部，正好是最高档。
     */
    it('永远不会高过用户选的那个倍数', () => {
        for (const chosen of SONNET_DEGRADE_LADDER) {
            for (let steps = 0; steps <= 6; steps += 1) {
                expect(lowerRenderScale(chosen, steps)).toBeLessThanOrEqual(chosen);
            }
        }
    });

    /* 负数 / NaN / 非整数：不该把画面搞坏。 */
    it('异常的 steps 不会让倍数变成怪值', () => {
        expect(lowerRenderScale(2, -1)).toBe(2);
        expect(lowerRenderScale(2, Number.NaN)).toBe(2);
        expect(lowerRenderScale(2, 1.9)).toBe(1.5);
    });

    /* 旧存档 / 手改 localStorage 里可能有不在档位表里的值。 */
    it('不在档位表里的倍数退到不超过它的最近一档', () => {
        expect(lowerRenderScale(1.2 as never, 1)).toBe(1);
        expect(lowerRenderScale(3 as never, 1)).toBe(2);
    });

    it('预览模式不降级', () => {
        expect(resolveSonnetRenderScale(2, 4, true, true)).toBe(2);
    });

    it('关掉自动降级时不降', () => {
        expect(resolveSonnetRenderScale(2, 4, false, false)).toBe(2);
    });

    it('开了自动降级就按格数降', () => {
        expect(resolveSonnetRenderScale(2, 2, true, false)).toBe(1);
    });
});

describe('降级的基准倍数（H12 接线时发现）', () => {
    /*
     * setRenderScale 会就地改生效倍数。每帧都拿生效值当基准，降一次之后基准跟着降，
     * 于是自己一格接一格往下走、直到压到 0.5 —— 用户选 2 倍，最后看到的却是最糊那一档。
     *
     * 这里钉的是「每一步都从用户选的值算出来」这个结果。真正的状态机在
     * createSonnetPixiRuntime.sampleAdaptiveQuality 里（每帧刷新基准），那部分要真机看行为：
     * 纯函数这一层没法证明它没在滚 —— 这一条只是把期望的映射关系写死。
     */
    it('每一步都从用户选的倍数算，不会自己滚下去', () => {
        const base = 2 as const;
        const ladder = [2, 1.5, 1, 0.75, 0.5];
        for (let steps = 0; steps < ladder.length; steps += 1) {
            expect(resolveSonnetAdaptiveTarget(base, steps, ladder.length - 1)).toBe(ladder[steps]);
        }
    });
});
