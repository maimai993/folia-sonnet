import React from 'react';
import { Slider } from '../../../ui';

// src/components/modal/settings/kit/RangeInput.tsx
//
// 「min/max/step 刻度上的滑条」—— 组件库 Slider 的一层外壳。
//
// 以前这里包的是原生 range 输入框：每个平台各自画，Android 上是一颗灰圆点加一段
// 灰线，和 Folia 的主题挂不上钩，而且按下即跳 —— 在可滚的页面里蹭到就把值改了。
// 设置页里还留着好几处直接用它（歌词动态壁纸那几行），于是同一个设置窗口里
// 出现了两种长相的滑条。
//
// 现在它只负责把「min..max、按 step 取整」换算成组件库滑杆认的 0..1：
// 长相、手势判定（先攒 8px 再判方向，竖向滑动交给页面滚动）、配色全部来自
// components/ui/Slider。调用点不用改。

type RangeInputProps = {
    value: number;
    min: number;
    max: number;
    step?: number;
    onChange: (value: number) => void;
    /** 保留着以兼容旧调用点：现在由 Slider 自己决定长相，这里只用它补充额外间距。 */
    className?: string;
    ariaLabel?: string;
    disabled?: boolean;
};

/** 浮点步长（0.1 那种）按步长的位数取整，避免 0.30000000000000004 这种值进设置。 */
const decimalsOf = (step: number): number => {
    const text = String(step);
    if (text.includes('e-')) return Number(text.split('e-')[1]) || 0;
    const dot = text.indexOf('.');
    return dot < 0 ? 0 : text.length - dot - 1;
};

const roundTo = (value: number, step: number): number => {
    const decimals = decimalsOf(step);
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
};

export const RangeInput: React.FC<RangeInputProps> = ({
    value,
    min,
    max,
    step = 1,
    onChange,
    className,
    ariaLabel,
    disabled,
}) => {
    const span = max - min;
    const toPosition = (raw: number): number => {
        if (span <= 0) return 0;
        const clamped = Math.min(max, Math.max(min, raw));
        return (clamped - min) / span;
    };
    const fromPosition = (position: number): number => {
        const clamped = Math.min(1, Math.max(0, position));
        // 落回 step 的整格：滑杆只报位置，刻度在这里对齐。
        const stepped = min + Math.round((clamped * span) / step) * step;
        return roundTo(Math.min(max, Math.max(min, stepped)), step);
    };

    return (
        <Slider
            value={toPosition(value)}
            onPreview={position => onChange(fromPosition(position))}
            onCommit={() => undefined}
            label={ariaLabel ?? ''}
            valueText={String(value)}
            disabled={disabled}
            className={className}
        />
    );
};

export default RangeInput;
