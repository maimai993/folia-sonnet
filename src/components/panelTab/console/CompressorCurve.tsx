import React from 'react';

// src/components/panelTab/console/CompressorCurve.tsx
// 一段压缩的静态曲线：横轴输入电平，纵轴输出电平，都是 -48 ~ 0 dB。
//
// 画的是「如果信号停在这个电平上，会被压到多少」—— 与原生 MultibandCompressor 里
// 那条逐块计算的曲线是同一组公式（阈值 / 比率 / 软拐点宽度），所以图上看到的折点
// 就是耳朵听到的拐点。
//
// 不画网格文字以外的装饰：Folia 的图都是「一条线 + 一条参考线」，靠颜色和刻度说话。

type CompressorCurveProps = {
    /** 阈值（dB）。 */
    thresholdDb: number;
    ratio: number;
    /** 补偿增益（dB）。 */
    makeupDb: number;
    /** 软拐点宽度（dB）：2 硬，18 软。 */
    kneeDb: number;
    /** 关闭的段画成灰的。 */
    dimmed?: boolean;
    /** 图上要不要标当前增益衰减的读数（右下角）。 */
    gainReductionDb?: number;
};

const MIN_DB = -48;
const MAX_DB = 0;

/** dB → 0..1 的纵向位置（0 = 顶部）。 */
const toUnit = (db: number) => 1 - (Math.min(MAX_DB, Math.max(MIN_DB, db)) - MIN_DB) / (MAX_DB - MIN_DB);

/** 与原生一致的软拐点过渡：以阈值为中心、宽 kneeDb，二次曲线接直线。 */
const transferDb = (inputDb: number, thresholdDb: number, ratio: number, makeupDb: number, kneeDb: number): number => {
    const knee = Math.max(2, kneeDb);
    const over = inputDb - thresholdDb;
    const reduction = over <= -knee / 2
        ? 0
        : over < knee / 2
            ? (1 / ratio - 1) * (over + knee / 2) * (over + knee / 2) / (2 * knee)
            : (1 / ratio - 1) * over;
    return inputDb + reduction + makeupDb;
};

const CompressorCurve: React.FC<CompressorCurveProps> = ({
    thresholdDb,
    ratio,
    makeupDb,
    kneeDb,
    dimmed = false,
    gainReductionDb,
}) => {
    const points: string[] = [];
    const steps = 48;
    for (let index = 0; index <= steps; index += 1) {
        const inputDb = MIN_DB + (index / steps) * (MAX_DB - MIN_DB);
        const outputDb = transferDb(inputDb, thresholdDb, ratio, makeupDb, kneeDb);
        points.push(`${(index / steps) * 100},${toUnit(outputDb) * 100}`);
    }

    const thresholdX = ((Math.min(MAX_DB, Math.max(MIN_DB, thresholdDb)) - MIN_DB) / (MAX_DB - MIN_DB)) * 100;
    const accent = dimmed ? 'var(--st-t3)' : 'var(--st-accent)';

    return (
        <>
            <div className="relative">
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-[132px] w-full overflow-visible">
                {/* 三条水平参考线：0 / -24 / -48 dB */}
                {[-0, 50, 100].map(y => (
                    <line key={y} x1={0} x2={100} y1={y} y2={y} stroke="var(--st-line2)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                ))}
                {/* 1:1 参考线：压与不压的分界就在这条线上 */}
                <line x1={0} y1={100} x2={100} y2={0} stroke="var(--st-line2)" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
                <line
                    x1={thresholdX}
                    x2={thresholdX}
                    y1={0}
                    y2={100}
                    stroke="var(--st-line2)"
                    strokeWidth={1}
                    strokeDasharray="2 4"
                    vectorEffect="non-scaling-stroke"
                />
                <polyline
                    points={points.join(' ')}
                    fill="none"
                    stroke={accent}
                    strokeWidth={1.6}
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                />
            </svg>
            <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-between font-mono text-[10px] leading-3 text-[color:var(--st-t3)]">
                <span>0 dB</span>
                <span>输出</span>
            </div>
            </div>
            {/* 底部的刻度写在图外面：曲线是从左下角那条 1:1 线起步的，压在图上会叠在一起。 */}
            <div className="mt-1 flex justify-between font-mono text-[10px] leading-3 text-[color:var(--st-t3)]">
                <span>{MIN_DB} dB</span>
                {gainReductionDb !== undefined && gainReductionDb < -0.05 && (
                    <span className="text-[color:var(--st-t2)]">{gainReductionDb.toFixed(1)} dB</span>
                )}
                <span>输入 0 dB</span>
            </div>
        </>
    );
};

export default CompressorCurve;
