import React from 'react';
import { motion } from 'framer-motion';

// src/components/app/listeningArchive/ArchiveLineChart.tsx
// 累计听歌时长的折线图（内联 SVG，照 panelTab/console/SpectrumChart 的写法）。
//
// 画的是「到这一天为止一共听了多少」，不是每天的量：顶部留 6% 余量，纵轴按最后一个桶的
// 累计值归一，所以它只增不减、不会被某一天的尖峰压平。点某一段回传下标，由页面展开那一段的记录。
//
// 低性能模式（设置页那一颗开关）下不播入场动画：几百个点的折线在弱 GPU 上重绘一次就是一次掉帧。

/** 柱 / 点的高度留白：满格不顶到框线。 */
const TOP_HEADROOM = 94;

export type ArchiveChartTick = {
    text: string;
    /** 0 到 1 之间的位置（左对齐）。 */
    position: number;
};

type ArchiveLineChartProps = {
    /** 每个桶的累计秒数，按桶顺序升序。 */
    values: number[];
    /** 下方刻度，由页面挑几条稀疏的给。 */
    ticks: ArchiveChartTick[];
    animate: boolean;
    /** 点某一段：给它的下标。没有这个回调时不可点。 */
    onSelect?: (index: number) => void;
    /** 每段的无障碍名字（给读屏与提示用）。 */
    segmentLabel?: (index: number) => string;
    /** 没有数据时压在图中间的那句话。 */
    emptyLabel: string;
};

const ArchiveLineChart: React.FC<ArchiveLineChartProps> = ({
    values,
    ticks,
    animate,
    onSelect,
    segmentLabel,
    emptyLabel,
}) => {
    const count = values.length;
    const max = count > 0 ? Math.max(...values, 0) : 0;
    const hasData = count > 1 && max > 0;
    const xOf = (index: number) => (count <= 1 ? 0 : (index / (count - 1)) * 100);
    const yOf = (value: number) => 100 - Math.min(1, Math.max(0, value / max)) * TOP_HEADROOM;

    const points = hasData
        ? values.map((value, index) => `${xOf(index).toFixed(3)},${yOf(value).toFixed(3)}`).join(' ')
        : '0,100 100,100';
    const area = `0,100 ${points} 100,100`;
    /**
     * 点击带：一段一条，宽度是相邻两点之间的距离。首尾两条各只有半条 —— 它们的中心落在
     * 0 和 100 上，硬撑成整条会越出画布，压住邻居那半条（量出来第一段被第二段吃了 19px）。
     */
    const bandWidth = count > 1 ? 100 / (count - 1) : 100;
    const bandStart = (index: number) => Math.max(0, xOf(index) - bandWidth / 2);
    const bandSize = (index: number) => Math.max(
        0.0001,
        Math.min(100, xOf(index) + bandWidth / 2) - bandStart(index),
    );

    return (
        <div className="relative">
            <motion.svg
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                className="h-[140px] w-full overflow-visible"
                initial={animate ? { opacity: 0 } : false}
                animate={{ opacity: 1 }}
                transition={animate ? { duration: 0.36, ease: 'easeOut' } : { duration: 0 }}
            >
                {/* 三条参考线：1/4、1/2、3/4 处，读的是相对满值的比例。 */}
                {[25, 50, 75].map(y => (
                    <line
                        key={y}
                        x1={0}
                        x2={100}
                        y1={y}
                        y2={y}
                        stroke="var(--st-line2)"
                        strokeWidth={1}
                        vectorEffect="non-scaling-stroke"
                    />
                ))}
                <polygon points={area} fill="var(--st-accent)" fillOpacity={0.12} />
                <polyline
                    points={points}
                    fill="none"
                    stroke="var(--st-accent)"
                    strokeWidth={1.4}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                />
                {/* 点击带：一段一个透明矩形，比让折线本身去命中可靠得多。 */}
                {hasData && onSelect && values.map((value, index) => (
                    <rect
                        key={index}
                        x={bandStart(index)}
                        y={0}
                        width={bandSize(index)}
                        height={100}
                        fill="transparent"
                        role="button"
                        tabIndex={0}
                        aria-label={segmentLabel?.(index)}
                        className="cursor-pointer"
                        onClick={() => onSelect(index)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                onSelect(index);
                            }
                        }}
                    />
                ))}
            </motion.svg>
            {!hasData && (
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-[color:var(--st-t3)]">
                    {emptyLabel}
                </span>
            )}
            {ticks.length > 0 && (
                <div className="relative mt-1 h-4 text-[10px] leading-4 text-[color:var(--st-t3)]">
                    {ticks.map(tick => (
                        <span
                            key={`${tick.text}-${tick.position}`}
                            className="absolute -translate-x-1/2 whitespace-nowrap"
                            style={{ left: `${Math.min(96, Math.max(4, tick.position * 100))}%` }}
                        >
                            {tick.text}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
};

export default ArchiveLineChart;
