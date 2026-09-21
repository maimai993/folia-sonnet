import React, { useLayoutEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { anchorPointToPx } from '../../utils/ponder/resolvePonderAnchors';
import { pickCaptionSpot } from '../../utils/ponder/captionPlacement';
import type { PonderRect, PonderTimelinePlan } from '../../types/ponder';
import type { PonderStageNodes } from './ponderStageNodes';
import PonderCaptionPointers from './PonderCaptionPointers';
import { PonderKeyCombo, ponderModifierLabel } from './PonderKeyCap';

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
/** 两行中文的高度，故意往大了估：估小了字幕会贴上骨架框。 */
const CAPTION_EST_HEIGHT_PX = 84;

/** 上下外框占掉的横条。字幕压上去会挡住进度条和章节按钮。 */
const TOP_CHROME_PX = 84;
const BOTTOM_CHROME_PX = 156;

const PonderActors: React.FC<PonderActorsProps> = ({ plan, rects, nodes, theme, isDaylight }) => {
    const { t } = useTranslation();
    const accent = theme?.accentColor || (isDaylight ? '#27272a' : '#fafafa');
    const chipSurface = isDaylight ? 'rgba(255, 255, 255, 0.96)' : 'rgba(39, 39, 42, 0.96)';
    const chipText = isDaylight ? '#27272a' : '#fafafa';
    const captionSurface = isDaylight ? 'rgba(255, 255, 255, 0.94)' : 'rgba(24, 24, 27, 0.94)';

    // 摆位要用到视口尺寸。进入时采一次就定死，和骨架矩形同一个口径。
    const viewport = {
        width: typeof window === 'undefined' ? 1440 : window.innerWidth,
        height: typeof window === 'undefined' ? 900 : window.innerHeight,
    };
    const captionWidth = Math.min(CAPTION_MAX_WIDTH_PX, viewport.width - 32);

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
                // 显式给了 at 就按 at 放；只给了 pointTo 就在目标周围挑一处空地；都没有才落到底部。
                const explicit = step.at === 'bottom' ? null : anchorPointToPx(step.at, rects);
                const pointed = !explicit && step.pointTo ? anchorPointToPx(step.pointTo, rects) : null;
                const anchored = pointed ?? explicit;
                const spot = anchored
                    ? pickCaptionSpot({
                        target: anchored,
                        size: { width: captionWidth, height: CAPTION_EST_HEIGHT_PX },
                        obstacles: Object.values(rects),
                        viewport,
                        reserved: [
                            { left: 0, top: 0, width: viewport.width, height: TOP_CHROME_PX },
                            { left: 0, top: viewport.height - BOTTOM_CHROME_PX, width: viewport.width, height: BOTTOM_CHROME_PX },
                        ],
                    })
                    : null;
                return (
                    <div
                        key={step.id}
                        ref={node => {
                            if (node) nodes.captions.set(step.id, node);
                            else nodes.captions.delete(step.id);
                        }}
                        className={spot
                            ? 'absolute rounded-lg px-3.5 py-2 text-sm shadow-lg'
                            : 'absolute bottom-32 left-1/2 max-w-xl -translate-x-1/2 rounded-lg px-4 py-2 text-center text-sm shadow-md'}
                        style={spot
                            ? {
                                left: spot.left,
                                top: spot.top,
                                width: captionWidth,
                                opacity: 0,
                                backgroundColor: captionSurface,
                                color: chipText,
                            }
                            : { opacity: 0, backgroundColor: captionSurface, color: chipText }}
                    >
                        {t(step.textKey, { mod: ponderModifierLabel })}
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
                            <PonderKeyCombo key={key} combo={key} accent={accent} surface={chipSurface} text={chipText} />
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
