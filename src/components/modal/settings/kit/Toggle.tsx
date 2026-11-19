import React from 'react';
import { useRowAria } from './Row';
import { useSettingsKitTheme } from './kitTheme';
import { Toggle as UiToggle } from '../../../ui';

// src/components/modal/settings/kit/Toggle.tsx
// 设置里唯一的开关。样子照「AI 云缓存」那一颗（也是最老的一颗、用户点名要的那颗）：
// 48×24 的跑道、16×16 的白拇指、开时整颗滑到右端、跑道变成那一抹灰蓝。
//
// 以前这里是另一套（40×24、拇指和跑道都跟主题走色），跟云缓存那颗、GridView /
// Lattice / Lab 那些手写的一颗颗并存，同一个设置里能看到两三种开关 —— 现在只有这一种。
//
// 控件本身在 components/ui/Toggle（全仓唯一的开关实现）；这里只补设置页才有的两样：
// 用所在的 Row 的 label 命名，以及按 kit 主题给关着时的跑道分明暗。

type ToggleProps = {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
    /** 名字。不在 kit 的 Row 里（自己拿 div 画的一行）时没有 label 可借，用它当 aria-label。 */
    label?: string;
    /** The id of what names it, where it sits outside a settings row. */
    labelledBy?: string;
};

export const Toggle: React.FC<ToggleProps> = ({ checked, onChange, disabled, label, labelledBy }) => {
    const { isDaylight } = useSettingsKitTheme();
    const row = useRowAria();

    return (
        <UiToggle
            checked={checked}
            onChange={onChange}
            disabled={disabled}
            label={label}
            labelledBy={labelledBy ?? row['aria-labelledby']}
            describedBy={row['aria-describedby']}
            isDaylight={isDaylight}
        />
    );
};

export default Toggle;
