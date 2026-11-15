import React from 'react';
import { useTranslation } from 'react-i18next';
import { Slider } from '../ui';
import {
    UI_SCALE_MAX,
    UI_SCALE_MIN,
    UI_SCALE_STEP,
    compactUiScaleFor,
} from '../../services/androidPhoneLayout';

// src/components/shared/UiScaleSlider.tsx
// 「界面缩放」滑条。首启引导（手机 / 平板那页底下）与设置页「设备类型」共用同一份，
// 两处的行为与文案才不会各写各的。
//
// 本身不知道自己写到了哪：值由外面给（生效值，见 resolveUiScale），改动也交给外面
// （useDeviceProfileStore.setUiScale）。它只负责画与报数。
//
// 设置页那一处由 kit 的 Row 包着，标题与说明由那一行给（见 DeviceTypeSetting），
// 所以这里可以只要滑条那一排 —— `compact`。
//
// 滑杆本身用组件库的 Slider：以前这里是一个原生 range 输入框，
// 和设置页其他滑条、雾滑块都不是同一种长相，用户能直接看出来「这个滑块跟别的不一样」。
// 原生滑杆还自带「按下即跳」，在这个可滚动的页面上容易蹭到就改。

type UiScaleSliderProps = {
    isDaylight: boolean;
    /** 滑条与滑块的着色；不给就退回当前文字色。 */
    accentColor?: string;
    /** 当前生效的缩放（百分比）。 */
    value: number;
    onChange: (value: number) => void;
    /** 要不要把「横屏再收一档」写出来 —— 只有手机那一档才有意义。 */
    showCompactHint?: boolean;
    /** 只画滑条那一排：标题与说明由外面那一行负责。 */
    compact?: boolean;
    className?: string;
};

/**
 * 百分比与滑杆的 0..1 之间换算。
 *
 * 按格（UI_SCALE_STEP）取整，避免 0.30000000000000004 这种值跑进 store；
 * 这也是原生 input 的 step 行为，换掉控件后要保持一致。
 */
const toPosition = (percent: number): number => {
    const span = UI_SCALE_MAX - UI_SCALE_MIN;
    if (span <= 0) return 0;
    return Math.min(1, Math.max(0, (percent - UI_SCALE_MIN) / span));
};
const fromPosition = (position: number): number => {
    const stepped = UI_SCALE_MIN + Math.round((position * (UI_SCALE_MAX - UI_SCALE_MIN)) / UI_SCALE_STEP) * UI_SCALE_STEP;
    return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, stepped));
};

export const UiScaleSlider: React.FC<UiScaleSliderProps> = ({
    isDaylight: _isDaylight,
    accentColor: _accentColor,
    value,
    onChange,
    showCompactHint = false,
    compact = false,
    className,
}) => {
    const { t } = useTranslation();
    const slider = (
        <Slider
            value={toPosition(value)}
            onPreview={position => onChange(fromPosition(position))}
            onCommit={() => undefined}
            label={t('uiScale.title')}
            valueText={`${value}%`}
            className="min-w-0 flex-1"
        />
    );

    if (compact) {
        return (
            <div className={`flex items-center gap-3 ${className ?? ''}`} data-folia-ui-scale-slider="true">
                <span className="text-[11px] opacity-40" style={{ color: 'var(--text-secondary)' }}>
                    {UI_SCALE_MIN}%
                </span>
                {slider}
                <span className="text-[11px] opacity-40" style={{ color: 'var(--text-secondary)' }}>
                    {UI_SCALE_MAX}%
                </span>
            </div>
        );
    }

    return (
        <div className={className} data-folia-ui-scale-slider="true">
            <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    {t('uiScale.title')}
                </span>
                <span className="font-mono text-xs opacity-60" style={{ color: 'var(--text-secondary)' }}>
                    {value}%
                </span>
            </div>
            <div className="mt-1 text-xs leading-relaxed opacity-50" style={{ color: 'var(--text-secondary)' }}>
                {t('uiScale.desc')}
            </div>
            <div className="mt-3 flex items-center gap-3">
                <span className="text-[11px] opacity-40" style={{ color: 'var(--text-secondary)' }}>
                    {UI_SCALE_MIN}%
                </span>
                {slider}
                <span className="text-[11px] opacity-40" style={{ color: 'var(--text-secondary)' }}>
                    {UI_SCALE_MAX}%
                </span>
            </div>
            {showCompactHint && (
                <div className="mt-1.5 text-[11px] leading-relaxed opacity-40" style={{ color: 'var(--text-secondary)' }}>
                    {t('uiScale.landscapeHint', { value: `${compactUiScaleFor(value)}%` })}
                </div>
            )}
        </div>
    );
};

export default UiScaleSlider;
