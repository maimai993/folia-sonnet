import React from 'react';
import { motion } from 'framer-motion';
import type { ArchiveHeatCell } from '../../../services/listeningArchive/types';

// src/components/app/listeningArchive/ArchiveHeatmap.tsx
// 声浪热力：周一到周日 × 0–23 点，格子越深听的时间越长（内联 SVG，照 SpectrumChart 的写法）。
//
// 颜色只用主题的 --st-accent 加不透明度分五档（0 到 4）：档数按最大值相对分，绝对秒数阈值
// 在「偶尔听」和「天天听」两种人身上会给出完全不同的图。空档不画，底色就是界面的底色。
//
// 低性能模式：不播入场动画。

/** 每行高度（px）。SVG 的 7 条横带与左边的星期标签都按它对齐。 */
const ROW_PX = 14;
/** 格子之间的缝隙，按 viewBox 单位（1 = 一个格子）。 */
const CELL_INSET = 0.08;

const LEVELS = [0.1, 0.28, 0.48, 0.7, 0.95] as const;

type ArchiveHeatmapProps = {
    /** 7×24 全铺的格子（heatCells 的输出，index = weekday * 24 + hour）。 */
    cells: ArchiveHeatCell[];
    /** 周一在前，七条。 */
    weekdayLabels: string[];
    /** 每个格子的说明（提示与读屏用）。 */
    cellLabel: (cell: ArchiveHeatCell) => string;
    /** 横轴刻度：留哪几个小时。 */
    hourTicks: number[];
    animate: boolean;
};

const levelOf = (seconds: number, max: number): number => {
    if (seconds <= 0 || max <= 0) return -1;
    // 相对最大值分档：1 秒的格子在「只听过 3 秒」的图上也是第 1 档，在「听过 3 小时」的图上是空。
    const ratio = Math.min(1, seconds / max);
    if (ratio > 0.6) return 4;
    if (ratio > 0.3) return 3;
    if (ratio > 0.12) return 2;
    return 1;
};

const ArchiveHeatmap: React.FC<ArchiveHeatmapProps> = ({
    cells,
    weekdayLabels,
    cellLabel,
    hourTicks,
    animate,
}) => {
    const max = cells.reduce((peak, cell) => (cell.seconds > peak ? cell.seconds : peak), 0);

    return (
        <div>
            <div className="flex gap-2">
                <div className="shrink-0 text-[10px] text-[color:var(--st-t3)]">
                    {weekdayLabels.map(label => (
                        <div key={label} style={{ height: ROW_PX }} className="leading-[14px]">
                            {label}
                        </div>
                    ))}
                </div>
                <motion.svg
                    viewBox="0 0 24 7"
                    preserveAspectRatio="none"
                    className="w-full"
                    style={{ height: ROW_PX * 7 }}
                    initial={animate ? { opacity: 0 } : false}
                    animate={{ opacity: 1 }}
                    transition={animate ? { duration: 0.36, ease: 'easeOut' } : { duration: 0 }}
                >
                    {cells.map(cell => {
                        const level = levelOf(cell.seconds, max);
                        return (
                            <rect
                                key={`${cell.weekday}-${cell.hour}`}
                                x={cell.hour + CELL_INSET}
                                y={cell.weekday + CELL_INSET}
                                width={1 - CELL_INSET * 2}
                                height={1 - CELL_INSET * 2}
                                rx={0.1}
                                fill={level < 0 ? 'var(--st-fill)' : 'var(--st-accent)'}
                                fillOpacity={level < 0 ? 0.35 : LEVELS[level]}
                            >
                                <title>{cellLabel(cell)}</title>
                            </rect>
                        );
                    })}
                </motion.svg>
            </div>
            <div className="relative mt-1 ml-[28px] h-4 text-[10px] leading-4 text-[color:var(--st-t3)]">
                {hourTicks.map(hour => (
                    <span
                        key={hour}
                        className="absolute -translate-x-1/2 whitespace-nowrap"
                        style={{ left: `${((hour + 0.5) / 24) * 100}%` }}
                    >
                        {hour}
                    </span>
                ))}
            </div>
        </div>
    );
};

export default ArchiveHeatmap;
