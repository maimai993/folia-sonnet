import React from 'react';

// src/components/panelTab/console/SpectrumChart.tsx
// 后置链路的实时频谱：32 根对数分布的柱子，20 Hz ~ 20 kHz。
//
// 数据来自原生（SpectrumAnalyzer 算完、按帧取走），不是 Web Audio 的 AnalyserNode ——
// 原生播放时 Web 侧那条总线是静音的，只能这样拿。所以这里画的是**耳朵真正听到的**，
// 包含压缩、后置 EQ、混响与限幅之后的结果。
//
// 没有原生（网页播放）时画一条平线并说明原因，不要假装有数据。

type SpectrumChartProps = {
    /** 32 段，0..1。空数组表示还没有数据。 */
    bands: number[];
    /** 是否在等第一帧：给一句「正在取样」。 */
    waiting?: boolean;
};

/** 刻度的频率与它在 32 段里的位置。 */
const MARKS: ReadonlyArray<{ hz: number; label: string }> = [
    { hz: 20, label: '20' },
    { hz: 100, label: '100' },
    { hz: 1000, label: '1k' },
    { hz: 10000, label: '10k' },
    { hz: 20000, label: '20k' },
];

const positionOf = (hz: number): number => Math.min(1, Math.max(0, (Math.log(hz / 20) / Math.log(1000))));

const SpectrumChart: React.FC<SpectrumChartProps> = ({ bands, waiting = false }) => {
    const count = bands.length;
    const hasData = count > 0 && bands.some(value => value > 0.001);

    const points = count > 0
        ? bands.map((value, index) => {
            const x = ((index + 0.5) / count) * 100;
            // 顶部留 6% 的余量：满格的柱子不该顶到框线上。
            const y = 100 - Math.min(1, Math.max(0, value)) * 94;
            return `${x.toFixed(2)},${y.toFixed(2)}`;
        }).join(' ')
        : '0,100 100,100';

    const area = `0,100 ${points} 100,100`;

    return (
        <div className="px-4 pb-3 pt-3">
            <div className="relative">
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-[120px] w-full overflow-visible">
                    {/* 三条水平参考线：0 / -30 / -60 dB（相对满刻度） */}
                    {[0, 33, 66].map(y => (
                        <line key={y} x1={0} x2={100} y1={y} y2={y} stroke="var(--st-line2)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                    ))}
                    <polygon points={area} fill="var(--st-accent)" fillOpacity={0.12} />
                    <polyline
                        points={points}
                        fill="none"
                        stroke="var(--st-accent)"
                        strokeWidth={1.4}
                        strokeLinejoin="round"
                        vectorEffect="non-scaling-stroke"
                    />
                </svg>
                {!hasData && (
                    <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-[color:var(--st-t3)]">
                        {waiting ? '正在取样…' : '暂无已确认的输出'}
                    </span>
                )}
            </div>
            <div className="relative mt-1 h-4 font-mono text-[10px] leading-4 text-[color:var(--st-t3)]">
                {MARKS.map(mark => (
                    <span
                        key={mark.hz}
                        className="absolute -translate-x-1/2 whitespace-nowrap"
                        style={{ left: `${positionOf(mark.hz) * 100}%` }}
                    >
                        {mark.label}
                    </span>
                ))}
            </div>
        </div>
    );
};

export default SpectrumChart;
