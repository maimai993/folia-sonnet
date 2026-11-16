import React, { useLayoutEffect, useRef } from 'react';
import { Button } from '../../ui';

// src/components/panelTab/console/ConsoleTabs.tsx
// 调音台顶部的两级导航：第一行是大类（基础 / 染色 / 母带 / 智能），第二行是当前大类下的页签。
//
// 耳机方案那一行**不在**这里，它在内容里滚动（见 AudioEqualizerDialog）。两级导航 + 方案条
// 三行都常驻会让头部太高、占掉手机窗口一截；而且 sticky 底色和窗口底色对不上时，滚动内容
// 会从行间透出来。现在常驻这两行导航，方案条随内容走。
//
// 两级规则：
//   · 一级大类始终全显示，点一下跳到该大类第一个页签；当前 tab 属于哪个大类，哪个就高亮。
//   · 二级只渲染当前大类下的页签 —— 点大类就收拢到那一组。
//   · 页签按钮的 aria-pressed 保持不变（测试与无障碍都靠它认当前页）。

export type ConsoleTabGroup = {
    id: string;
    label: string;
    /** 这一大类包含的页签 value，顺序即显示顺序。 */
    tabs: ReadonlyArray<string>;
};

type ConsoleTabsProps = {
    tab: string;
    groups: ReadonlyArray<ConsoleTabGroup>;
    options: ReadonlyArray<{ value: string; label: string }>;
    onTabChange: (value: string) => void;
};

const ConsoleTabs: React.FC<ConsoleTabsProps> = ({ tab, groups, options, onTabChange }) => {
    const stripRef = useRef<HTMLDivElement>(null);
    const groupRef = useRef<HTMLDivElement>(null);

    // 当前 tab 属于哪个大类。没匹配到就退回第一个（防御用，正常不会发生）。
    const activeGroup = groups.find(group => group.tabs.includes(tab)) ?? groups[0];
    const visibleOptions = activeGroup
        ? options.filter(option => activeGroup.tabs.includes(option.value))
        : options;

    // 当前页签滚出视野时，只把页签条自己横向推回来 —— 纵向一像素都不动。
    // 不能用 scrollIntoView：它会滚动所有可滚动祖先，把整个弹层拽回顶部（跳屏 + 丢滚动位置）。
    useLayoutEffect(() => {
        const strip = stripRef.current;
        if (!strip) return;
        const active = strip.querySelector<HTMLElement>('[aria-pressed="true"]');
        if (!active) return;
        const stripRect = strip.getBoundingClientRect();
        const activeRect = active.getBoundingClientRect();
        const pad = 2;
        if (activeRect.left < stripRect.left + pad) {
            strip.scrollLeft -= stripRect.left + pad - activeRect.left;
        } else if (activeRect.right > stripRect.right - pad) {
            strip.scrollLeft += activeRect.right - (stripRect.right - pad);
        }
    }, [tab]);

    // 大类条同理：当前大类滚出视野时横向推回。
    useLayoutEffect(() => {
        const strip = groupRef.current;
        if (!strip) return;
        const active = strip.querySelector<HTMLElement>('[data-active="true"]');
        if (!active) return;
        const stripRect = strip.getBoundingClientRect();
        const activeRect = active.getBoundingClientRect();
        const pad = 2;
        if (activeRect.left < stripRect.left + pad) {
            strip.scrollLeft -= stripRect.left + pad - activeRect.left;
        } else if (activeRect.right > stripRect.right - pad) {
            strip.scrollLeft += activeRect.right - (stripRect.right - pad);
        }
    }, [activeGroup?.id]);

    return (
        <div className="flex flex-col gap-1.5">
            {/* 一级：大类。小一号文字 + 弱配色，和二级页签区分。 */}
            <div
                ref={groupRef}
                role="group"
                className="hide-scrollbar flex items-center gap-0.5 self-start overflow-x-auto"
            >
                {groups.map(group => {
                    const selected = group.id === activeGroup?.id;
                    const first = group.tabs[0];
                    return (
                        <Button
                            key={group.id}
                            data-active={selected}
                            onClick={() => {
                                if (!selected && first) onTabChange(first);
                            }}
                            className={`st-t-fast h-6 shrink-0 whitespace-nowrap rounded px-2 text-[11px] transition-colors ${selected
                                ? 'bg-[var(--st-raise)] font-semibold text-[color:var(--st-t1)] shadow-[0_1px_2px_rgba(0,0,0,0.15)]'
                                : 'text-[color:var(--st-t3)] hover:text-[color:var(--st-t1)]'}`}
                        >
                            {group.label}
                        </Button>
                    );
                })}
            </div>

            {/* 二级：当前大类下的页签。 */}
            <div
                ref={stripRef}
                role="group"
                className="hide-scrollbar flex items-center gap-0.5 self-start overflow-x-auto rounded-lg bg-[var(--st-fill)] p-0.5"
            >
                {visibleOptions.map(option => {
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
        </div>
    );
};

export default ConsoleTabs;
