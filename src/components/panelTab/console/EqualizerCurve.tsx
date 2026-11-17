import React from 'react';
import { AUDIO_EQUALIZER_BANDS, audioEqualizerBandShape } from '../../../utils/audioEqualizer';

// src/components/panelTab/console/EqualizerCurve.tsx
// 十段均衡器的频响曲线预览：把十段增益 + 曲线形状（GEQ 定 Q / PEQ 可调 Q）+ 总增益
// 叠成一条 20 Hz ~ 20 kHz 的曲线。
//
// 这是**预览**：用解析近似（搁架用一阶过渡、钟形用对数频率上的高斯），和原生 TenBandEq
// 的 biquad 系数不是逐样本一致，但形状、峰值位置、Q 的宽窄走势一致 —— 拖滑杆时看到的
// 就是听到的方向。

type EqualizerCurveProps = {
    gains: number[];
    mode: 'geq' | 'peq';
    q: number;
    globalGainDb: number;
    dimmed?: boolean;
};

const MIN_HZ = 20;
const MAX_HZ = 20000;
const MIN_DB = -12;
const MAX_DB = 12;

const toY = (db: number) => 100 - ((Math.min(MAX_DB, Math.max(MIN_DB, db)) - MIN_DB) / (MAX_DB - MIN_DB)) * 100;

/** 一个频段的近似增益（dB）：lowshelf / highshelf / peaking。 */
const bandGainDb = (frequency: number, center: number, gain: number, q: number, shape: 'lowshelf' | 'peaking' | 'highshelf'): number => {
    const ratio = frequency / center;
    if (shape === 'lowshelf') return gain * (1 / (1 + ratio * ratio));
    if (shape === 'highshelf') return gain * (ratio * ratio / (1 + ratio * ratio));
    // 钟形：在对数频率轴上的高斯，带宽由 Q 决定（Q 越大越窄）。
    const bwOctaves = Math.log(1 + 1 / (2 * q)) / Math.log(2);
    const distance = Math.log(ratio) / Math.log(2);
    const width = Math.max(bwOctaves, 0.05);
    return gain * Math.exp(-(distance * distance) / (2 * width * width));
};

const EqualizerCurve: React.FC<EqualizerCurveProps> = ({ gains, mode, q, globalGainDb, dimmed = false }) => {
    const effectiveQ = mode === 'peq' ? q : 1.4;
    const points: string[] = [];
    const steps = 80;
    for (let index = 0; index <= steps; index += 1) {
        const fraction = index / steps;
        const frequency = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, fraction);
        let total = globalGainDb;
        for (let band = 0; band < gains.length; band += 1) {
            const gain = gains[band] ?? 0;
            if (gain === 0) continue;
            const bandInfo = AUDIO_EQUALIZER_BANDS[band];
            total += bandGainDb(frequency, bandInfo.frequency, gain, effectiveQ, audioEqualizerBandShape(band));
        }
        points.push(`${fraction * 100},${toY(total)}`);
    }
    const zeroY = toY(0);

    return (
        <div className={`px-2 pb-2 pt-1${dimmed ? ' opacity-40' : ''}`}>
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-20 w-full rounded-md bg-[var(--st-fill)]">
                <line x1="0" y1={zeroY} x2="100" y2={zeroY} stroke="var(--st-line)" strokeWidth="0.5" strokeDasharray="2 2" />
                <polyline
                    points={points.join(' ')}
                    fill="none"
                    stroke="var(--st-accent)"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                />
            </svg>
        </div>
    );
};

export default EqualizerCurve;
