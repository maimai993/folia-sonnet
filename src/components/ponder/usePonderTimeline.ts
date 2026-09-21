import { useEffect, useRef, type RefObject } from 'react';
import { createTimeline, type Timeline } from 'animejs';
import { readReducedMotion } from '../../stores/useMotionSettingsStore';
import { anchorPointToPx } from '../../utils/ponder/resolvePonderAnchors';
import { keyframeIndexAt, nextKeyframeAt, prevKeyframeAt } from '../../utils/ponder/ponderKeyframes';
import { PONDER_HIGHLIGHT_MAX_OPACITY, type PonderRect, type PonderTimelinePlan } from '../../types/ponder';
import type { PonderStageNodes } from './ponderStageNodes';

// src/components/ponder/usePonderTimeline.ts
// 把编译好的 plan 翻译成 anime.js v4 的 timeline，并提供播放控制。
//
// 这是整个功能里唯一 import animejs 的文件，且只被懒加载的 PonderStage 引用 —— animejs
// 约 38KB gz，不能进 bootstrap chunk（同 App.tsx:20-22 对 AutomixTransitionAnimation 的处理）。
//
// 进度条和当前关键帧都由 onUpdate 直接写 DOM，不经过 React：它们是每帧值。

type UsePonderTimelineParams = {
    plan: PonderTimelinePlan;
    rects: Record<string, PonderRect>;
    nodesRef: RefObject<PonderStageNodes>;
    /** 一段跑完时通知外面把「下一章」卡片放出来。 */
    onComplete: () => void;
};

export type PonderTimelineControls = {
    toggle: () => boolean;
    restart: () => void;
    isCompleted: () => boolean;
    seekPrevKeyframe: () => void;
    seekNextKeyframe: () => void;
    seekToTick: (index: number) => void;
};

/** 光标步骤的落点；锚点解析不出来时退回视口中心，宁可演得不准也不要飞到左上角。 */
const pointOrCenter = (
    point: Parameters<typeof anchorPointToPx>[0] | undefined,
    rects: Record<string, PonderRect>,
) => (point ? anchorPointToPx(point, rects) : null)
    ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 };

export const usePonderTimeline = ({
    plan,
    rects,
    nodesRef,
    onComplete,
}: UsePonderTimelineParams): RefObject<PonderTimelineControls | null> => {
    const controlsRef = useRef<PonderTimelineControls | null>(null);

    useEffect(() => {
        const nodes = nodesRef.current;
        if (!nodes || plan.totalMs <= 0) {
            return;
        }

        const calm = readReducedMotion('uiMicroMotion');
        // 刻意不循环。无限循环既看不出「这一章讲完了」，也就无从提示还有下一章；
        // 跑完停在末帧，由 PonderStage 放出下一章卡片。
        const timeline: Timeline = createTimeline({
            defaults: { ease: calm ? 'linear' : 'outQuad' },
            autoplay: true,
        });

        // 光标先摆到第一个 cursor/drag 步骤的起点，免得第一帧从左上角窜出来。
        const firstMove = plan.entries.find(entry => entry.step.kind === 'cursor' || entry.step.kind === 'drag');
        if (nodes.cursor && firstMove) {
            const step = firstMove.step;
            const origin = step.kind === 'cursor' ? pointOrCenter(step.from ?? step.to, rects)
                : step.kind === 'drag' ? pointOrCenter(step.from, rects)
                : null;
            if (origin) {
                nodes.cursor.style.transform = `translate(${origin.x}px, ${origin.y}px)`;
            }
        }

        for (const { step, atMs, durationMs } of plan.entries) {
            if (step.kind === 'caption') {
                const node = nodes.captions.get(step.id);
                if (!node) continue;
                timeline.add(node, calm
                    ? { opacity: [0, 1], duration: 240 }
                    : { opacity: [0, 1], y: [8, 0], duration: 240 }, atMs);
                timeline.add(node, { opacity: 0, duration: 200 }, atMs + Math.max(durationMs - 200, 0));

                // 指向线挂在同一段时间上：文字在讲谁，线就指着谁，两者不能错开。
                const pointer = nodes.pointers.get(step.id);
                if (pointer) {
                    timeline.add(pointer, { opacity: [0, 1], duration: 300 }, atMs);
                    timeline.add(pointer, { opacity: 0, duration: 200 }, atMs + Math.max(durationMs - 200, 0));
                }
            } else if (step.kind === 'cursor' || step.kind === 'drag') {
                if (!nodes.cursor) continue;
                const to = pointOrCenter(step.to, rects);
                const from = step.kind === 'cursor'
                    ? (step.from ? pointOrCenter(step.from, rects) : null)
                    : pointOrCenter(step.from, rects);
                timeline.add(nodes.cursor, {
                    x: from ? [from.x, to.x] : to.x,
                    y: from ? [from.y, to.y] : to.y,
                    duration: calm ? 1 : durationMs,
                    ease: step.ease ?? (calm ? 'linear' : 'outCubic'),
                }, atMs);

                if (step.kind === 'cursor' && step.press && nodes.cursorRing) {
                    timeline.add(nodes.cursorRing, {
                        scale: [0.7, 1.6],
                        opacity: [0.9, 0],
                        duration: 420,
                    }, atMs);
                }
            } else if (step.kind === 'keypress') {
                const node = nodes.keyChips.get(step.id);
                if (!node) continue;
                timeline.add(node, calm
                    ? { opacity: [0, 1], duration: 180 }
                    : { opacity: [0, 1], scale: [0.82, 1], duration: 180 }, atMs);
                timeline.add(node, { opacity: 0, duration: 160 }, atMs + Math.max(durationMs - 160, 0));
            } else if (step.kind === 'highlight') {
                const node = nodes.highlights.get(step.anchor);
                if (!node) continue;
                // intensity 是 0..1 的「有多亮」，乘上限才落到画面 —— 直接画 1.0 会是一整块纯色。
                const [from, to] = step.intensity ?? [0, 1];
                timeline.add(node, {
                    opacity: [from * PONDER_HIGHLIGHT_MAX_OPACITY, to * PONDER_HIGHLIGHT_MAX_OPACITY],
                    duration: durationMs,
                }, atMs);
            } else {
                // pausePoint：时间线上的一段空隙。用裸 timer 占位，不动任何节点。
                timeline.add({ duration: durationMs }, atMs);
            }
        }

        // 进度条与当前关键帧：每帧直接写 DOM。keyframeIndexRef 也是 ←/→ 读的那个值，
        // 所以「现在在第几帧」从头到尾不需要是 React 状态。
        const keyframeIndexRef = { current: -1 };
        timeline.onUpdate = (self: Timeline) => {
            const fill = nodesRef.current?.progressFill;
            if (fill) {
                fill.style.transform = `scaleX(${self.iterationProgress})`;
            }
            const index = keyframeIndexAt(plan, self.iterationCurrentTime);
            if (index !== keyframeIndexRef.current) {
                keyframeIndexRef.current = index;
                nodesRef.current?.ticks.forEach((tick, i) => {
                    if (tick) tick.toggleAttribute('data-active', i === index);
                });
            }
        };

        timeline.onComplete = () => onComplete();

        controlsRef.current = {
            toggle: () => {
                if (timeline.paused) {
                    timeline.play();
                    return false;
                }
                timeline.pause();
                return true;
            },
            restart: () => {
                timeline.restart();
            },
            isCompleted: () => timeline.completed,
            // muteCallbacks，理由和 AutomixTransitionAnimation 里那次 seek 一样：
            // 卷过一个 marker 不该把它触发一遍。
            seekPrevKeyframe: () => {
                timeline.seek(prevKeyframeAt(plan, timeline.iterationCurrentTime), true);
            },
            seekNextKeyframe: () => {
                timeline.seek(nextKeyframeAt(plan, timeline.iterationCurrentTime), true);
            },
            seekToTick: index => {
                const keyframe = plan.keyframes[index];
                if (keyframe) timeline.seek(keyframe.atMs, true);
            },
        };

        // 无限循环开着就一直有 rAF，切到后台必须停 —— 否则在别的窗口里持续烧 CPU。
        const handleVisibility = () => {
            if (document.hidden) {
                timeline.pause();
            } else if (!timeline.completed) {
                // 已经播完的不要复活 —— 否则从后台切回来会把「下一章」卡片顶掉。
                timeline.play();
            }
        };
        document.addEventListener('visibilitychange', handleVisibility);

        return () => {
            document.removeEventListener('visibilitychange', handleVisibility);
            timeline.revert();
            controlsRef.current = null;
        };
    }, [plan, rects, nodesRef, onComplete]);

    return controlsRef;
};

export default usePonderTimeline;
