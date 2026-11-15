import React from 'react';
import { motion } from 'framer-motion';

// src/components/app/listeningArchive/ArchiveBars.tsx
// 一组竖条（内联 SVG，照 SpectrumChart 的写法）：单曲轨迹里的月度名次、星期分布、小时分布都用它。
//
// 值可以是「秒数」也可以是「名次」这类已经反过来算好的数：调用方给的是**条越高越靠前**的
// 相对量，这里只按最大值归一。0 的条仍然画一条底线，免得那张图看着像缺了几格。
//
// 低性能模式不播入场动画。

/** 条顶留白：满格不顶到框线。 */
const TOP_HEADROOM = 96;
/** 一条都不占的空白格画多高：一点点，表示「有这一格，只是没有量」。 */
const ZERO_BAR = 1.5;

type ArchiveBarsProps = {
    values: number[];
    /** 条下面的刻度；给了就按 `labelEvery` 稀疏显示。 */
    labels?: string[];
    /** 每隔几条显示一个刻度（0 与最后一条总会显示）。 */
    labelEvery?: number;
    animate: boolean;
    /** 每一条的说明（提示与读屏用）。 */
    barLabel?: (index: number) => string;
    /** 一条都没有值时压在图中间的那句话。 */
    emptyLabel?: string;
};

const ArchiveBars: React.FC<ArchiveBarsProps> = ({
    values,
    labels,
    labelEvery = 1,
    animate,
    barLabel,
    emptyLabel,
}) => {
    const count = values.length;
    const max = count > 0 ? Math.max(...values, 0) : 0;
    const hasData = max > 0;
    const band = count > 0 ? 100 / count : 100;
    const barWidth = band * 0.62;
    const offset = (band - barWidth) / 2;

    return (
        <div className="relative">
            <motion.svg
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                className="h-[104px] w-full overflow-visible"
                initial={animate ? { opacity: 0 } : false}
                animate={{ opacity: 1 }}
                transition={animate ? { duration: 0.36, ease: 'easeOut' } : { duration: 0 }}
            >
                <line
                    x1={0}
                    x2={100}
                    y1={100}
                    y2={100}
                    stroke="var(--st-line2)"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                />
                {values.map((value, index) => {
                    const height = hasData && value > 0
                        ? Math.max(ZERO_BAR, Math.min(1, value / max) * TOP_HEADROOM)
                        : ZERO_BAR;
                    return (
                        <rect
                            key={index}
                            x={index * band + offset}
                            y={100 - height}
                            width={barWidth}
                            height={height}
                            fill="var(--st-accent)"
                            fillOpacity={value > 0 ? 0.55 : 0.18}
                        >
                            <title>{barLabel?.(index)}</title>
                        </rect>
                    );
                })}
            </motion.svg>
            {!hasData && emptyLabel && (
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-[color:var(--st-t3)]">
                    {emptyLabel}
                </span>
            )}
            {labels && labels.length > 0 && (
                <div className="relative mt-1 h-4 text-[10px] leading-4 text-[color:var(--st-t3)]">
                    {labels.map((label, index) => {
                        if (index !== 0 && index !== labels.length - 1 && index % Math.max(1, labelEvery) !== 0) {
                            return null;
                        }
                        return (
                            <span
                                key={`${label}-${index}`}
                                className="absolute -translate-x-1/2 whitespace-nowrap"
                                style={{ left: `${index * band + band / 2}%` }}
                            >
                                {label}
                            </span>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default ArchiveBars;
