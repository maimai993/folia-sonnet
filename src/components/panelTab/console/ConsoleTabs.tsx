import React, { useLayoutEffect, useRef } from 'react';
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

const ConsoleTabs: React.FC<ConsoleTabsProps> = ({ tab, options, onTabChange }) => {
    const stripRef = useRef<HTMLDivElement>(null);

    // 当前页签滚出视野时，只把页签条自己横向推回来 —— 纵向一像素都不动。
    //
    // 这里**不能**用 scrollIntoView：它会滚动**所有可滚动祖先**，而页签条正好在弹层内容的最上面。
    // 人滚到下面就为了调参数，页签条早已出了视口；此时任何一次重渲染（拖完滑杆落盘、切回前台、
    // 换耳机方案）都会让 scrollIntoView 去「让页签可见」，把调音台弹层（Sheet 的 overflow-y-auto
    // 容器）整个拽回顶部 —— 表现就是「跳屏 + 滚动位置被重置」。
    // 页签条自己的 overflow-x-auto 才是这里唯一该动的滚动容器。
    useLayoutEffect(() => {
        const strip = stripRef.current;
        if (!strip) return;
        const active = strip.querySelector<HTMLElement>('[aria-pressed="true"]');
        if (!active) return;
        const stripRect = strip.getBoundingClientRect();
        const activeRect = active.getBoundingClientRect();
        // 留出容器 p-0.5 那点内边距，贴边时不压住圆角。
        const pad = 2;
        if (activeRect.left < stripRect.left + pad) {
            strip.scrollLeft -= stripRect.left + pad - activeRect.left;
        } else if (activeRect.right > stripRect.right - pad) {
            strip.scrollLeft += activeRect.right - (stripRect.right - pad);
        }
    }, [tab]);

    return (
        // 页签不撑满：五枚各按文字宽度排，窄窗里整条可以横滚，当前页签自己会被推回视野。
        <div
            ref={stripRef}
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
};

export default ConsoleTabs;
