import React, { useLayoutEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { anchorPointToPx } from '../../utils/ponder/resolvePonderAnchors';
import type { PonderRect, PonderTimelinePlan } from '../../types/ponder';
import type { PonderStageNodes } from './ponderStageNodes';
import PonderCaptionPointers from './PonderCaptionPointers';

// src/components/ponder/PonderActors.tsx
// 会动的那几个：光标、按下时的扩散圈、字幕、按键胶片。
//
// 全部预渲染在 opacity 0 并登记进节点表，由时间线按绝对时间点亮 —— 组件本身不随播放
// 重渲染一次。字幕和胶片一个步骤一个节点，这样时间线能按 step.id 精确找到演员。

type PonderActorsProps = {
    plan: PonderTimelinePlan;
    rects: Record<string, PonderRect>;
    nodes: PonderStageNodes;
    theme?: { accentColor?: string };
    isDaylight: boolean;
};

/**
 * 带指向的字幕摆在它所讲的那个东西旁边，而不是屏幕底部。
 *
 * 原版 Ponder 的说明文字总是紧挨着目标，连接线只有短短一截。字幕固定在底部会让这条线
 * 横跨全屏，读起来像连线图而不是标注，视线要在屏幕两端来回跑。
 * 目标太靠下就改放上方，免得被进度条和图例压住。
 */
const CAPTION_MAX_WIDTH_PX = 384;
const CAPTION_MARGIN_PX = 16;

const captionSpotFor = (target: { x: number; y: number }) => {
    const width = typeof window === 'undefined' ? 1440 : window.innerWidth;
    const height = typeof window === 'undefined' ? 900 : window.innerHeight;
    const below = target.y < height * 0.62;

    // 贴边钳位。目标靠近屏幕边缘时，以它为中心的字幕会有一半跑到屏幕外去；
    // 按 max-w-sm 的一半留出余量。字幕被推开之后指向线仍然对得上 ——
    // 线是按量出来的字幕盒真实位置画的，不是按这里算的理想位置。
    const half = CAPTION_MAX_WIDTH_PX / 2;
    const min = half + CAPTION_MARGIN_PX;
    const max = width - half - CAPTION_MARGIN_PX;
    const left = max > min ? Math.min(Math.max(target.x, min), max) : width / 2;

    return {
        left,
        // 56 而不是紧贴：骨架框的名字标签就画在框的上下沿，贴太近会压住它。
        top: below ? target.y + 56 : target.y - 56,
        translate: below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
    };
};

const PonderActors: React.FC<PonderActorsProps> = ({ plan, rects, nodes, theme, isDaylight }) => {
    const { t } = useTranslation();
    const accent = theme?.accentColor || (isDaylight ? '#27272a' : '#fafafa');
    const chipSurface = isDaylight ? 'rgba(255, 255, 255, 0.96)' : 'rgba(39, 39, 42, 0.96)';
    const chipText = isDaylight ? '#27272a' : '#fafafa';
    const captionSurface = isDaylight ? 'rgba(255, 255, 255, 0.94)' : 'rgba(24, 24, 27, 0.94)';

    const captionSteps = plan.entries.filter(entry => entry.step.kind === 'caption');
    const keypressSteps = plan.entries.filter(entry => entry.step.kind === 'keypress');

    // 指向线要从字幕盒的边上引出来，所以得先知道盒子在哪。字幕是预渲染在 opacity 0 的，
    // 已经参与布局，量得到。只在挂载后量一次，之后位置不再变。
    const [captionBoxes, setCaptionBoxes] = useState<Record<string, PonderRect>>({});
    useLayoutEffect(() => {
        const boxes: Record<string, PonderRect> = {};
        nodes.captions.forEach((node, id) => {
            const rect = node.getBoundingClientRect();
            boxes[id] = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        });
        setCaptionBoxes(boxes);
    }, [plan, rects, nodes]);

    return (
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
            <PonderCaptionPointers
                plan={plan}
                rects={rects}
                captionBoxes={captionBoxes}
                nodes={nodes}
                accent={accent}
            />

            {captionSteps.map(({ step }) => {
                if (step.kind !== 'caption') return null;
                // 显式给了 at 就按 at 放；只给了 pointTo 就贴着目标放；都没有才落到底部。
                const explicit = step.at === 'bottom' ? null : anchorPointToPx(step.at, rects);
                const pointed = !explicit && step.pointTo ? anchorPointToPx(step.pointTo, rects) : null;
                const spot = explicit
                    ? { left: explicit.x, top: explicit.y + 40, translate: 'translate(-50%, 0)' }
                    : pointed ? captionSpotFor(pointed) : null;
                return (
                    <div
                        key={step.id}
                        ref={node => {
                            if (node) nodes.captions.set(step.id, node);
                            else nodes.captions.delete(step.id);
                        }}
                        className={spot
                            ? 'absolute max-w-sm rounded-lg px-3.5 py-2 text-sm shadow-lg'
                            : 'absolute bottom-32 left-1/2 max-w-xl -translate-x-1/2 rounded-lg px-4 py-2 text-center text-sm shadow-md'}
                        style={spot
                            ? {
                                left: spot.left,
                                top: spot.top,
                                transform: spot.translate,
                                opacity: 0,
                                backgroundColor: captionSurface,
                                color: chipText,
                            }
                            : { opacity: 0, backgroundColor: captionSurface, color: chipText }}
                    >
                        {t(step.textKey)}
                    </div>
                );
            })}

            {keypressSteps.map(({ step }) => {
                if (step.kind !== 'keypress') return null;
                const point = step.at === 'bottom' ? null : anchorPointToPx(step.at, rects);
                return (
                    <div
                        key={step.id}
                        ref={node => {
                            if (node) nodes.keyChips.set(step.id, node);
                            else nodes.keyChips.delete(step.id);
                        }}
                        className={point
                            ? 'absolute flex -translate-x-1/2 gap-1'
                            : 'absolute bottom-52 left-1/2 flex -translate-x-1/2 gap-1'}
                        style={point ? { left: point.x, top: point.y, opacity: 0 } : { opacity: 0 }}
                    >
                        {step.keys.map(key => (
                            <kbd
                                key={key}
                                className="rounded-md border px-2 py-1 text-xs font-medium shadow-sm"
                                style={{ backgroundColor: chipSurface, color: chipText, borderColor: accent }}
                            >
                                {key}
                            </kbd>
                        ))}
                    </div>
                );
            })}

            {/* 光标。transform 由时间线写，这里只给初始形态。 */}
            <div
                ref={node => { nodes.cursor = node; }}
                className="absolute left-0 top-0"
                style={{ transform: 'translate(-100px, -100px)' }}
            >
                <div
                    ref={node => { nodes.cursorRing = node; }}
                    className="absolute -left-4 -top-4 h-8 w-8 rounded-full border-2"
                    style={{ borderColor: accent, opacity: 0 }}
                />
                <svg width="20" height="20" viewBox="0 0 20 20" className="relative -left-1 -top-1 drop-shadow">
                    <path d="M3 2 L3 15 L7 11.5 L9.5 17 L12 16 L9.5 10.5 L14.5 10.5 Z" fill={accent} stroke={isDaylight ? '#fff' : '#18181b'} strokeWidth="1" />
                </svg>
            </div>
        </div>
    );
};

export default PonderActors;
