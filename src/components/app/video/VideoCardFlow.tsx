// src/components/app/video/VideoCardFlow.tsx
// 影视卡片流：横向一排卡片，左右键或滚轮移动焦点，点卡片进详情 / 起播。
//
// 为什么不复用首页那套 3D 滑条：`src/library/suites/grid` 是「曲库首页」的 suite，按仓库约定
// 只经 registry 由首页外壳与集合宿主解析，页面级组件不直接 import 它；影视不是曲库的一个 surface，
// 所以这里自带一份轻量的横向卡片流，只做影视需要的事（封面、剧名、备注、选中即打开）。

import React, { useCallback, useEffect, useRef } from 'react';

export type VideoCardItem = {
    id: string;
    name: string;
    coverUrl?: string;
    description?: string;
};

export type VideoCardFlowProps = {
    items: VideoCardItem[];
    focusedIndex: number;
    onFocusedIndexChange: (index: number) => void;
    onSelect: (item: VideoCardItem, index: number) => void;
    emptyMessage?: string;
};

const CARD_WIDTH = 176;
const CARD_GAP = 16;
const STEP = CARD_WIDTH + CARD_GAP;

export const VideoCardFlow: React.FC<VideoCardFlowProps> = ({
    items,
    focusedIndex,
    onFocusedIndexChange,
    onSelect,
    emptyMessage = '这里还没有片子',
}) => {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);

    const clamp = useCallback(
        (index: number) => (items.length === 0 ? 0 : Math.min(Math.max(index, 0), items.length - 1)),
        [items.length],
    );

    // 焦点变化时把那张卡片滚到可视区中间，焦点走到屏幕外的情况就不会发生了。
    useEffect(() => {
        const card = cardRefs.current[focusedIndex];
        const scroller = scrollerRef.current;
        if (!card || !scroller) return;
        const target = card.offsetLeft - (scroller.clientWidth - CARD_WIDTH) / 2;
        scroller.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
    }, [focusedIndex]);

    const move = useCallback(
        (delta: number) => {
            if (items.length === 0) return;
            onFocusedIndexChange(clamp(focusedIndex + delta));
        },
        [clamp, focusedIndex, items.length, onFocusedIndexChange],
    );

    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            move(-1);
            return;
        }
        if (event.key === 'ArrowRight') {
            event.preventDefault();
            move(1);
            return;
        }
        if (event.key === 'Enter' && items[focusedIndex]) {
            event.preventDefault();
            onSelect(items[focusedIndex], focusedIndex);
        }
    };

    if (items.length === 0) {
        return <p className="py-8 text-center text-[13px] text-[color:var(--st-t3)]">{emptyMessage}</p>;
    }

    return (
        <div
            ref={scrollerRef}
            tabIndex={0}
            onKeyDown={handleKeyDown}
            onWheel={event => {
                if (Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
                move(event.deltaY > 0 ? 1 : -1);
            }}
            className="flex h-full min-h-0 items-center gap-4 overflow-x-auto overflow-y-hidden px-6 outline-none [scrollbar-width:none]"
        >
            {items.map((item, index) => {
                const focused = index === focusedIndex;
                return (
                    <button
                        key={item.id}
                        ref={node => {
                            cardRefs.current[index] = node;
                        }}
                        type="button"
                        onClick={() => onSelect(item, index)}
                        onPointerEnter={() => onFocusedIndexChange(index)}
                        className={`group flex w-[176px] shrink-0 flex-col overflow-hidden rounded-xl text-left transition-transform duration-150 ${
                            focused ? 'scale-[1.06] ring-1 ring-white/40' : 'scale-100 opacity-80'
                        }`}
                    >
                        <div className="relative aspect-[2/3] w-full overflow-hidden rounded-xl bg-[var(--st-fill2)]">
                            {item.coverUrl ? (
                                <img src={item.coverUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
                            ) : (
                                <div className="flex h-full w-full items-center justify-center text-[12px] text-[color:var(--st-t3)]">
                                    无封面
                                </div>
                            )}
                            {focused && (
                                <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-4 text-[12px] text-white">
                                    {item.name}
                                </span>
                            )}
                        </div>
                        <span className="mt-1.5 truncate text-[12.5px] text-[color:var(--st-t1)]">{item.name}</span>
                        {item.description && (
                            <span className="truncate text-[11.5px] text-[color:var(--st-t3)]">{item.description}</span>
                        )}
                    </button>
                );
            })}
        </div>
    );
};

export default VideoCardFlow;
