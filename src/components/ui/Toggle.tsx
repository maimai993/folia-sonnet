import React from 'react';

// src/components/ui/Toggle.tsx
// 全仓唯一的开关实现：48×24 的跑道、16×16 的白拇指，开时滑到右端。设置页 kit 的 Toggle 只是在它外面补
// 行内命名（aria-labelledby）与明暗主题，其余界面直接用这一颗。

export type ToggleProps = {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
    /** 名字：不在设置行里、没有 label 可借时用作 aria-label。 */
    label?: string;
    /** 给它命名的元素的 id。 */
    labelledBy?: string;
    describedBy?: string;
    /**
     * 关着时跑道的明暗：亮色界面黑 15%、暗色界面白 15%。不传时取当前文字色的 15%，
     * 文字色在亮色界面是深色、在暗色界面是浅色，效果相同，而且不需要知道调用方挂在哪个主题下。
     */
    isDaylight?: boolean;
};

const offTrack = (isDaylight: boolean | undefined) => {
    if (isDaylight === undefined) return 'bg-[color-mix(in_srgb,var(--text-primary,#fff)_15%,transparent)]';
    return isDaylight ? 'bg-black/15' : 'bg-white/15';
};

export const Toggle: React.FC<ToggleProps> = ({ checked, onChange, disabled, label, labelledBy, describedBy, isDaylight }) => (
    <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        {...(labelledBy ? { 'aria-labelledby': labelledBy } : {})}
        {...(describedBy ? { 'aria-describedby': describedBy } : {})}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`st-t-move shrink-0 w-12 h-6 rounded-full p-1 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${checked
            ? 'bg-[rgba(114,119,134,1)]'
            : offTrack(isDaylight)}`}
    >
        <span
            className={`st-t-move block w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-6' : 'translate-x-0'}`}
        />
    </button>
);

export default Toggle;
