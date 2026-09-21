import React from 'react';
import { useTranslation } from 'react-i18next';
import type { PonderAnchorRole, PonderAnchorSource, PonderRect } from '../../types/ponder';
import type { PonderStageNodes } from './ponderStageNodes';

// src/components/ponder/PonderSkeletonLayer.tsx
// 骨架：每个解析出来的锚点画一个框。
//
// 框本身是静态的 —— 位置在进入瞬间量一次就定了。会动的只有每个框里那层高亮填充，
// 由时间线的 highlight 步骤驱动，所以它要把自己登记进节点表。
//
// 按角色分别画，而不是清一色的圆角矩形：一块纯色方块读起来是「一块色」，
// 而带标题栏和几行占位内容的面才读得出是「一个面板」。这是骨架能不能替代真实界面的关键。

type PonderSkeletonLayerProps = {
    rects: Record<string, PonderRect>;
    anchors: Record<string, PonderAnchorSource>;
    nodes: PonderStageNodes;
    theme?: { accentColor?: string };
    isDaylight: boolean;
};

/** 面板内部那几条占位内容线，让空面板看起来像界面而不是色块。 */
const SurfaceContents: React.FC<{ line: string }> = ({ line }) => (
    <div className="absolute inset-x-0 top-0 bottom-0 flex flex-col gap-2 p-3">
        <div className="h-5 rounded" style={{ backgroundColor: line, width: '42%' }} />
        <div className="mt-1 flex flex-col gap-1.5">
            {[88, 74, 81, 62].map((width, index) => (
                <div key={index} className="h-2.5 rounded" style={{ backgroundColor: line, width: `${width}%` }} />
            ))}
        </div>
    </div>
);

const PonderSkeletonLayer: React.FC<PonderSkeletonLayerProps> = ({
    rects,
    anchors,
    nodes,
    theme,
    isDaylight,
}) => {
    const { t } = useTranslation();
    const accent = theme?.accentColor || (isDaylight ? '#27272a' : '#fafafa');
    const outline = isDaylight ? 'rgba(24, 24, 27, 0.22)' : 'rgba(255, 255, 255, 0.24)';
    const face = isDaylight ? 'rgba(24, 24, 27, 0.04)' : 'rgba(255, 255, 255, 0.05)';
    const line = isDaylight ? 'rgba(24, 24, 27, 0.1)' : 'rgba(255, 255, 255, 0.1)';
    const labelColor = isDaylight ? 'rgba(24, 24, 27, 0.5)' : 'rgba(255, 255, 255, 0.5)';

    const shapeFor = (role: PonderAnchorRole) => {
        if (role === 'marker') {
            return { className: 'absolute', style: { backgroundColor: accent, opacity: 0.35 } };
        }
        if (role === 'rail') {
            return {
                className: 'absolute rounded-full border border-dashed',
                style: { borderColor: outline, backgroundColor: face },
            };
        }
        if (role === 'surface') {
            return { className: 'absolute overflow-hidden rounded-xl border', style: { borderColor: outline, backgroundColor: face } };
        }
        return { className: 'absolute overflow-hidden rounded-lg border', style: { borderColor: outline, backgroundColor: face } };
    };

    return (
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
            {Object.entries(rects).map(([name, rect]) => {
                const source = anchors[name];
                const role: PonderAnchorRole = source?.role ?? 'control';
                const shape = shapeFor(role);
                // 量到了真实圆角就照搬，角色自带的那套圆角只是没量到时的兜底。
                const radiusStyle = rect.radius ? { borderRadius: rect.radius } : {};

                return (
                    <div key={name}>
                        <div
                            className={shape.className}
                            style={{
                                ...shape.style,
                                ...radiusStyle,
                                left: rect.left,
                                top: rect.top,
                                width: rect.width,
                                height: rect.height,
                            }}
                        >
                            {role === 'surface' && <SurfaceContents line={line} />}
                            <div
                                ref={node => {
                                    if (node) {
                                        nodes.highlights.set(name, node);
                                    } else {
                                        nodes.highlights.delete(name);
                                    }
                                }}
                                className="absolute inset-0"
                                style={{ backgroundColor: accent, opacity: 0, ...radiusStyle }}
                            />
                        </div>

                        {/* 标签画在框外，不进 overflow-hidden 的框里，短框也不会被裁掉。
                            嵌套的框要靠 labelPlacement 显式错开，否则两个标签会叠成一团。 */}
                        {source?.labelKey && (() => {
                            const placement = source.labelPlacement
                                ?? (role === 'surface' ? 'inside' : 'above');
                            const top = placement === 'below' ? rect.top + rect.height + 6
                                : placement === 'inside' ? rect.top - 20
                                : rect.top - 18;
                            return (
                                <div
                                    className="absolute whitespace-nowrap text-[11px] tracking-wide"
                                    style={{ left: rect.left, top, color: labelColor }}
                                >
                                    {t(source.labelKey)}
                                </div>
                            );
                        })()}
                    </div>
                );
            })}
        </div>
    );
};

export default PonderSkeletonLayer;
