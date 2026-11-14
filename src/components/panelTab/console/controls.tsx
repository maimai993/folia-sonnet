import React from 'react';
import PanelSlider from '../controls/PanelSlider';

// src/components/panelTab/console/controls.tsx
// 调音台里那几根横滑杆的共同外壳：名字、当前值、滑杆本身。
//
// 为什么统一到这里：调音台有十几根参数滑杆（阈值、比率、启动、释放、RT60、Q、总增益…），
// 它们长得一样、交互一样（拖动过程中实时试听、松手才落盘），只有取值范围和读法不同。
// 各写一遍的话，一处改了间距，别的页就会对不齐。
//
// 映射一律在 0..1 的位置上做：PanelSlider 只认 0..1，对数刻度的换算在这里收口，
// 这样「频段截止」那种跨度三个数量级的参数，滑杆前半段不会全挤在最左边。

type ConsoleSliderProps = {
    label: string;
    /** 右侧显示的读数，例如 "-16.0 dB"。 */
    valueText: string;
    value: number;
    min: number;
    max: number;
    /** 对数刻度：适合频率、时间这类跨数量级的参数。 */
    log?: boolean;
    /** 保留几位小数后取整，避免 0.30000000000000004 这种值进数组。 */
    decimals?: number;
    /** 默认值（实际刻度）：滑杆上画一根细线标出来，不画就不给。 */
    defaultValue?: number;
    disabled?: boolean;
    onChange: (value: number) => void;
    onCommit: () => void;
};

const round = (value: number, decimals: number) => {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
};

export const ConsoleSlider: React.FC<ConsoleSliderProps> = ({
    label,
    valueText,
    value,
    min,
    max,
    log = false,
    decimals = 2,
    defaultValue,
    disabled = false,
    onChange,
    onCommit,
}) => {
    const span = max - min;
    const toPosition = (raw: number): number => {
        if (span <= 0) return 0;
        const clamped = Math.min(max, Math.max(min, raw));
        if (!log || min <= 0) return (clamped - min) / span;
        return Math.log(clamped / min) / Math.log(max / min);
    };
    const fromPosition = (position: number): number => {
        const clamped = Math.min(1, Math.max(0, position));
        if (!log || min <= 0) return round(min + clamped * span, decimals);
        return round(min * (max / min) ** clamped, decimals);
    };

    return (
        <div className={disabled ? 'opacity-40' : undefined}>
            <div className="flex items-baseline justify-between gap-3 text-[13px] leading-5">
                <span className="truncate text-[color:var(--st-t1)]">{label}</span>
                <span className="shrink-0 font-mono text-xs text-[color:var(--st-t2)]">{valueText}</span>
            </div>
            <div className="mt-1 flex" inert={disabled}>
                <PanelSlider
                    value={toPosition(value)}
                    label={label}
                    valueText={valueText}
                    /* 默认值刻度由组件库的滑杆自己画，位置永远和圆点的行程一致。 */
                    defaultValue={defaultValue === undefined ? undefined : toPosition(defaultValue)}
                    onPreview={position => onChange(fromPosition(position))}
                    onCommit={onCommit}
                />
            </div>
        </div>
    );
};

/** 一段参数的读法：两处以上（压缩器、混响）都用得上。 */
export const formatDb = (value: number, digits = 1): string => {
    if (Math.abs(value) < 0.05) return '0.0 dB';
    return `${value > 0 ? '+' : ''}${value.toFixed(digits)} dB`;
};

export const formatMs = (value: number): string => (
    value >= 10 ? `${value.toFixed(0)} ms` : `${value.toFixed(1)} ms`
);

export const formatSeconds = (value: number): string => `${value.toFixed(2)} s`;

export const formatRatio = (value: number): string => `${value.toFixed(1)} : 1`;

/** 频率读数：1000 Hz 以上换成 kHz，分频点与低频单声道都按这个念。 */
export const formatHz = (value: number): string => {
    if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)} kHz`;
    return `${Math.round(value)} Hz`;
};

/** 0..1 的比例读成百分比：平行压缩的混合比、混响的干湿比都用它。 */
export const formatPercent = (value: number): string => `${Math.round(value * 100)}%`;

export default ConsoleSlider;
