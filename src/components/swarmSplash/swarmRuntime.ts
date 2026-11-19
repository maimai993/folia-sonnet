// src/components/swarmSplash/swarmRuntime.ts
// 启动动画的运行时：把物理、绘制、编排串成一个 canvas + requestAnimationFrame 的循环。
//
// 为什么不用 React 渲染：每帧要动的是几十只光标的位置、正在画的框、正在打的字——全是连续量。
// 按 frontend-runtime-guardrails 的硬规矩，连续量不能进 React state，所以这里整体交给 canvas，
// React 只在动画结束（一个离散事件）时收到一次回调。

import { buildFallbackBlueprint, measureBlueprint, type BlueprintBlock } from './swarmBlueprint';
import { cursorColor, drawCursor, drawGrowingRect, drawTypedText } from './swarmDraw';
import { createSwarm, releaseSwarm, stepSwarm, type SwarmCursor, type SwarmField } from './swarmPhysics';

/** 动画的三个阶段。 */
type Phase = 'gather' | 'build' | 'leave' | 'done';

export type SwarmRuntimeOptions = {
    canvas: HTMLCanvasElement;
    /** 全部结束（含撤离）后调用一次。 */
    onDone: () => void;
    /** 允许的总时长上限（毫秒）：到点无论建到哪都收尾，别让用户卡在启动画面上。 */
    maxDurationMs?: number;
};

export type SwarmRuntime = {
    start: () => void;
    destroy: () => void;
};

/** 一群光标先聚多久（毫秒）。太短看不出「群体」，太长显得慢。 */
const GATHER_MS = 900;
/** 一块本身要多久画完（毫秒）。 */
const BLOCK_DRAW_MS = 520;
/** 撤离最长给多久，超时直接结束。 */
const LEAVE_MAX_MS = 700;
/** 一帧最多推进多少秒：页面切回来时 rAF 的 dt 会是好几秒，钳住才不会一帧跳飞。 */
const MAX_DT_S = 0.05;

/**
 * 创建运行时。canvas 尺寸在这里按 devicePixelRatio 设好，之后每帧不再改尺寸。
 */
export const createSwarmRuntime = ({ canvas, onDone, maxDurationMs = 4200 }: SwarmRuntimeOptions): SwarmRuntime => {
    const context = canvas.getContext('2d');
    if (!context) {
        // 拿不到 2d 上下文（极老的内核）：立刻交回控制权，启动流程不能因为它卡住。
        onDone();
        return { start: () => undefined, destroy: () => undefined };
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    /*
     * 量真实界面前先逼一次布局：覆盖层是刚挂上的，若不读一次样式，界面可能还没完成布局，
     * 量出来的矩形会全是 0（那样就只能退回兜底版式，用户看到的又变成「假装画」）。
     * 读一次 offsetHeight 就够了，代价是一次同步布局，发生在启动动画开始时。
     */
    void document.body.offsetHeight;
    /*
     * 蓝图是可变的：启动那一刻真实界面往往还没布局完（应用正在读库、渲染首页），
     * 这时量不到东西。所以先按真实布局再量一次，量不到就等几帧重试；
     * 真的量不到才用兜底版式。用户看到的就是「界面被一格一格画出来」。
     */
    let blocks = measureBlueprint();
    if (blocks.length < 3) {
        // 逼一次同步布局：不读样式的话，即便 DOM 在，矩形也可能还是 0。
        void document.body.offsetHeight;
        blocks = measureBlueprint();
    }
    let usingFallback = blocks.length < 3;
    if (usingFallback) blocks = buildFallbackBlueprint({ width, height });
    // 移动端少一些光标：每只都要画形状，36 只在低端机上会掉帧。
    const count = width * height > 900 * 1600 ? 32 : 20;
    const field: SwarmField = createSwarm({ count, radius: Math.min(width, height) * 0.18, spawn: { width, height } }, {
        x: width / 2,
        y: height / 2,
    });

    let phase: Phase = 'gather';
    let elapsedMs = 0;
    let lastFrame = 0;
    let frameId = 0;
    let destroyed = false;
    /** 当前在建的块下标，以及它已画了多久。 */
    let blockIndex = -1;
    let blockElapsed = 0;
    /** 已经画好的块（每帧照着重画）。 */
    const finished = new Set<number>();
    /** 文字块已经打出来的字数。 */
    const typed = new Map<number, number>();

    const finish = () => {
        if (destroyed) return;
        destroyed = true;
        if (frameId) cancelAnimationFrame(frameId);
        frameId = 0;
        onDone();
    };

    /** 当前该被围着的那一点：建到哪就围哪，没在建就围屏幕中心。 */
    const targetOf = (): { x: number; y: number } => {
        const block = blockIndex >= 0 ? blocks[blockIndex] : null;
        if (!block) return { x: width / 2, y: height / 2 };
        return { x: block.x + block.width / 2, y: block.y + block.height / 2 };
    };

    const drawBlock = (block: BlueprintBlock, progress: number, index: number) => {
        const color = CURSOR_COLORS_FOR_BLOCK(index);
        if (block.kind === 'rect') {
            drawGrowingRect(context, block, progress, color);
            return;
        }
        const full = block.text ?? '';
        const shown = Math.round(full.length * Math.min(1, progress));
        typed.set(index, shown);
        drawTypedText(context, full.slice(0, shown), { x: block.x, y: block.y }, block.fontSize ?? 20, color);
    };

    const paint = () => {
        context.clearRect(0, 0, width, height);

        // 已经建好的块：按最终形态静态重画。
        for (const index of finished) {
            const block = blocks[index];
            const color = CURSOR_COLORS_FOR_BLOCK(index);
            if (block.kind === 'rect') drawGrowingRect(context, block, 1, color);
            else drawTypedText(context, block.text ?? '', { x: block.x, y: block.y }, block.fontSize ?? 20, color);
        }
        // 正在建的那一块。
        if (blockIndex >= 0 && !finished.has(blockIndex)) {
            const progress = Math.min(1, blockElapsed / BLOCK_DRAW_MS);
            drawBlock(blocks[blockIndex], progress, blockIndex);
        }
        // 光标最后画，压在内容上面 —— 真实的协作光标也在最上层。
        for (const cursor of field.cursors) {
            drawCursor(context, cursor, cursorColor(cursor), phase === 'leave' ? 0.85 : 1);
        }
    };

    const tick = (timestamp: number) => {
        if (destroyed) return;
        if (!lastFrame) lastFrame = timestamp;
        const dtMs = timestamp - lastFrame;
        lastFrame = timestamp;
        const dt = Math.min(dtMs / 1000, MAX_DT_S);
        elapsedMs += dtMs;

        field.target = targetOf();
        stepSwarm(field, dt, Math.min(width, height) * 0.18);

        if (phase === 'gather') {
            /*
             * 还在用兜底版式：每帧再试一次量真实界面。一旦量到就换上，并把建造进度归零
             * —— 不然前几块会按兜底版式的位置画完，位置和真实界面对不上。
             */
            if (usingFallback && elapsedMs < GATHER_MS) {
                const measured = measureBlueprint();
                if (measured.length >= 3) {
                    blocks = measured;
                    usingFallback = false;
                    console.info(`[SwarmSplash] 量到真实界面 ${measured.length} 块`);
                }
            }
            if (elapsedMs >= GATHER_MS || elapsedMs >= maxDurationMs) {
                phase = 'build';
                blockIndex = 0;
                blockElapsed = 0;
            }
        } else if (phase === 'build') {
            blockElapsed += dtMs;
            if (blockElapsed >= BLOCK_DRAW_MS) {
                finished.add(blockIndex);
                blockElapsed = 0;
                blockIndex += 1;
                if (blockIndex >= blocks.length || elapsedMs >= maxDurationMs) {
                    blockIndex = -1;
                    phase = 'leave';
                }
            }
        } else if (phase === 'leave') {
            const remaining = releaseSwarm(field, dt, width, height);
            if (remaining === 0) {
                paint();
                finish();
                return;
            }
        }

        paint();
        frameId = requestAnimationFrame(tick);
    };

    return {
        start: () => {
            if (destroyed) return;
            // 先画一帧再进循环：空 canvas 呈现在屏幕上会闪一下白。
            paint();
            frameId = requestAnimationFrame(tick);
        },
        destroy: () => {
            destroyed = true;
            if (frameId) cancelAnimationFrame(frameId);
            frameId = 0;
        },
    };
};

/** 每块固定用同一个光标色，看起来像「这一块是这个人做的」。 */
const CURSOR_COLORS_FOR_BLOCK = (index: number): string => {
    const probe: SwarmCursor = {
        id: index, x: 0, y: 0, vx: 0, vy: 0, orbit: 0, spin: 1, curl: 0, age: 0,
    };
    return cursorColor(probe);
};

/** 撤离阶段的最长时间：超时就当飞走了。 */
export const swarmLeaveBudgetMs = LEAVE_MAX_MS;
