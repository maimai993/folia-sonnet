import type { PonderTimelinePlan } from '../../types/ponder';

// src/utils/ponder/ponderKeyframes.ts
// 关键帧刻度的位置换算，以及 ←/→ 跳转要落到哪一帧。

/**
 * 死区。没有它，刚跳到某个关键帧后再按一次 ←，会因为「当前时间就等于该帧」而原地不动，
 * 连按两次只前进一帧。
 */
const SEEK_TOLERANCE_MS = 250;

/** 每根刻度在进度条上的比例位置，0..1。 */
export const keyframeTicks = (plan: PonderTimelinePlan): number[] => {
    if (plan.totalMs <= 0) {
        return [];
    }
    return plan.keyframes.map(keyframe => keyframe.atMs / plan.totalMs);
};

/** 当前时间落在第几个关键帧区间内；一个都没过则为 -1。 */
export const keyframeIndexAt = (plan: PonderTimelinePlan, nowMs: number): number => {
    let index = -1;
    plan.keyframes.forEach((keyframe, i) => {
        if (keyframe.atMs <= nowMs + 1) {
            index = i;
        }
    });
    return index;
};

/** 下一个关键帧的时间；已经在最后一个之后则绕回开头。 */
export const nextKeyframeAt = (plan: PonderTimelinePlan, nowMs: number): number => {
    const next = plan.keyframes.find(keyframe => keyframe.atMs > nowMs + SEEK_TOLERANCE_MS);
    return next ? next.atMs : 0;
};

/** 上一个关键帧的时间；已经在第一个之前则回到开头。 */
export const prevKeyframeAt = (plan: PonderTimelinePlan, nowMs: number): number => {
    const earlier = plan.keyframes.filter(keyframe => keyframe.atMs < nowMs - SEEK_TOLERANCE_MS);
    return earlier.length > 0 ? earlier[earlier.length - 1].atMs : 0;
};
