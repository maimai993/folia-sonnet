import { describe, expect, it } from 'vitest';
import { keyframeIndexAt, keyframeTicks, nextKeyframeAt, prevKeyframeAt } from '@/utils/ponder/ponderKeyframes';
import type { PonderTimelinePlan } from '@/types/ponder';

// test/unit/ponder/ponderKeyframes.test.ts
// 死区是这组函数存在的理由：刚跳到某帧之后再按一次方向键必须继续走，
// 不能因为「当前时间正好等于该帧」而卡住。

const plan: PonderTimelinePlan = {
    totalMs: 1000,
    entries: [],
    keyframes: [
        { stepId: 'a', atMs: 0 },
        { stepId: 'b', atMs: 400 },
        { stepId: 'c', atMs: 800 },
    ],
};

describe('keyframeTicks', () => {
    it('按总时长归一化', () => {
        expect(keyframeTicks(plan)).toEqual([0, 0.4, 0.8]);
    });

    it('总时长为 0 时返回空，不产生 NaN', () => {
        expect(keyframeTicks({ totalMs: 0, entries: [], keyframes: [{ stepId: 'a', atMs: 0 }] })).toEqual([]);
    });
});

describe('keyframeIndexAt', () => {
    it('落在区间内取该区间的序号', () => {
        expect(keyframeIndexAt(plan, 0)).toBe(0);
        expect(keyframeIndexAt(plan, 500)).toBe(1);
        expect(keyframeIndexAt(plan, 950)).toBe(2);
    });
});

describe('nextKeyframeAt', () => {
    it('从区间中段跳到下一帧', () => {
        expect(nextKeyframeAt(plan, 500)).toBe(800);
    });

    it('刚跳到某帧后再按一次仍然前进（死区）', () => {
        expect(nextKeyframeAt(plan, 400)).toBe(800);
    });

    it('越过最后一帧后绕回开头', () => {
        expect(nextKeyframeAt(plan, 900)).toBe(0);
    });
});

describe('prevKeyframeAt', () => {
    it('从区间中段回到上一帧', () => {
        expect(prevKeyframeAt(plan, 700)).toBe(400);
    });

    it('刚过某帧不到死区时长时，视为仍停在该帧上，继续往前退', () => {
        expect(prevKeyframeAt(plan, 500)).toBe(0);
    });

    it('刚跳到某帧后再按一次仍然后退（死区）', () => {
        expect(prevKeyframeAt(plan, 800)).toBe(400);
    });

    it('已在开头时停在 0', () => {
        expect(prevKeyframeAt(plan, 0)).toBe(0);
    });
});
