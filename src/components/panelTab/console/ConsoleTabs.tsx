import React, { useLayoutEffect, useRef } from 'react';
import { Button } from '../../ui';

// src/components/panelTab/console/ConsoleTabs.tsx
// 调音台顶部的两级导航，层级要一眼分清：大类是「分组提示」、页签是「当前页」。
//
// 视觉权重：页签（二级）> 大类（一级）。页签做成主分段条 —— 当前页用强调色整块点亮，
// 其它页签只是灰字；大类退成一行小字，只负责「收拢到这一组」，不抢页签的注意力。
// 之前大类条和分区卡都做得太显眼，页签反而像装饰，现在把它压回主角位置。

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
    const activeGroup = groups.find(group => group.tabs.includes(tab)) ?? groups.at(0);
    const visibleOptions = activeGroup
        ? options.filter(option => activeGroup.tabs.includes(option.value))
        : options;

    // 当前页签滚出视野时，只把页签条自己横向推回来 —— 纵向一像素都不动。
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
            {/* 一级：大类，主分段条 —— 当前大类强调色整块点亮。 */}
            <div
                ref={groupRef}
                role="group"
                className="hide-scrollbar flex items-center gap-1 max-w-full self-start overflow-x-auto rounded-xl bg-[var(--st-fill)] p-1"
            >
                {groups.map(group => {
                    const selected = group.id === activeGroup?.id;
                    const first = group.tabs[0];
                    return (
                        <Button
                            key={group.id}
                            aria-pressed={selected}
                            data-active={selected}
                            onClick={() => {
                                if (!selected && first) onTabChange(first);
                            }}
                            className={`st-t-fast h-8 shrink-0 whitespace-nowrap rounded-lg px-3 text-[13px] transition-colors ${selected
                                ? 'bg-[var(--st-accent)] font-semibold text-[color:var(--st-on-accent)] shadow-[0_1px_3px_rgba(0,0,0,0.25)]'
                                : 'text-[color:var(--st-t2)] hover:bg-[var(--st-fill2)] hover:text-[color:var(--st-t1)]'}`}
                        >
                            {group.label}
                        </Button>
                    );
                })}
            </div>

            {/* 二级：页签，小字弱化，只负责切换当前页。 */}
            <div
                ref={stripRef}
                role="group"
                className="hide-scrollbar flex items-center gap-1 max-w-full self-start overflow-x-auto"
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
                            className={`st-t-fast h-6 shrink-0 whitespace-nowrap rounded px-2 text-[11px] transition-colors ${selected
                                ? 'font-semibold text-[color:var(--st-t1)]'
                                : 'text-[color:var(--st-t3)] hover:text-[color:var(--st-t1)]'}`}
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
