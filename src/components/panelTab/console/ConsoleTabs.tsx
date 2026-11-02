import React from 'react';
import { Button } from '../../ui';

// src/components/panelTab/console/ConsoleTabs.tsx
// 调音台顶部唯一常驻的一行：五个页签。
//
// 耳机方案那一行**不在**这里，它在内容里滚动（见 AudioEqualizerDialog）。两行都想常驻时，
// 头部就有 78px 高，手机上要占掉窗口的十分之一；而且 sticky 的底色一旦和窗口底色对不上
// （浅色主题、半透明窗口），滚动的内容就从两行之间透出来，看着像叠了两层字。
// 现在常驻的只有页签一行，方案条随内容走：滚上去就是普通的一行，不会盖住任何东西。

type ConsoleTabsProps = {
    tab: string;
    options: ReadonlyArray<{ value: string; label: string }>;
    onTabChange: (value: string) => void;
};

const ConsoleTabs: React.FC<ConsoleTabsProps> = ({ tab, options, onTabChange }) => (
    // 页签不撑满：五枚各按文字宽度排，窄窗里整条可以横滚，当前页签自己会被推回视野。
    <div
        role="group"
        className="hide-scrollbar flex items-center gap-0.5 self-start overflow-x-auto rounded-lg bg-[var(--st-fill)] p-0.5"
    >
        {options.map(option => {
            const selected = option.value === tab;
            return (
                <Button
                    key={option.value}
                    aria-pressed={selected}
                    onClick={() => {
                        if (!selected) onTabChange(option.value);
                    }}
                    // 换成窄窗后当前页签可能滚出视野：只在它出界时才动（inline: nearest）。
                    // 没有这个方法的宿主（测试环境里的假 DOM）直接跳过，不该因此中断渲染。
                    ref={selected ? node => node?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }) : undefined}
                    className={`st-t-fast h-7 shrink-0 whitespace-nowrap rounded-md px-2.5 text-[13px] transition-colors ${selected
                        ? 'bg-[var(--st-raise)] font-medium text-[color:var(--st-t1)] shadow-[0_1px_2px_rgba(0,0,0,0.2)]'
                        : 'text-[color:var(--st-t2)] hover:text-[color:var(--st-t1)]'}`}
                >
                    {option.label}
                </Button>
            );
        })}
    </div>
);

export default ConsoleTabs;
