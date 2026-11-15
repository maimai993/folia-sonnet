import React from 'react';
import { Slider as UIKitSlider } from '../../ui';

// src/components/panelTab/controls/PanelSlider.tsx
//
// 调音台 / 雾滑块用的横滑杆。**只是组件库 Slider 的一层外壳**，不再自己画。
//
// 为什么收成一层壳：这里以前是一套完全独立的实现（自己的轨道、自己的纯白圆点、
// 自己的「按下即跳」判定），于是同一个应用里出现了两种滑杆 —— 调音台是一种手感，
// 设置页是另一种，雾那几根又是第三种。用户反馈的「误触 / 滑不动 / 和主题割裂」
// 都是这么来的。
//
// 现在长得怎么样、手势怎么判，全部由 components/ui/Slider 说了算；这里只把
// 「0..1 的位置 + 实时预览 + 松手落盘」翻译成它的接口。上面的名字与读数由
// ConsoleSlider 那一层排版，这里只管滑杆本体。
//
// 保留这个文件是为了不动调用点：调音台十几根参数滑杆都直接引用它。

type PanelSliderProps = {
    /** From 0 to 1. */
    value: number;
    onPreview: (value: number) => void;
    onCommit: () => void;
    /** The accessible name. */
    label: string;
    /** How the value reads, e.g. "72%". */
    valueText: string;
    /** 默认值（0..1）：滑杆上画一根细线标出来。 */
    defaultValue?: number;
    /** Out of reach: dimmed, and neither the pointer nor a key moves it. */
    disabled?: boolean;
};

export const PanelSlider: React.FC<PanelSliderProps> = ({
    value,
    onPreview,
    onCommit,
    label,
    valueText,
    defaultValue,
    disabled = false,
}) => (
    <UIKitSlider
        value={value}
        onPreview={onPreview}
        onCommit={onCommit}
        label={label}
        valueText={valueText}
        defaultValue={defaultValue}
        disabled={disabled}
    />
);

export default PanelSlider;
