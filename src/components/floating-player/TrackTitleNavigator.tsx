import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
// src/components/floating-player/TrackTitleNavigator.tsx

export interface TrackTitleNavigatorProps {
    title: string;
    prevTitle: string | null;
    nextTitle: string | null;
    canPrev: boolean;
    canNext: boolean;
    onPrev: () => void;
    onNext: () => void;
    prevLabel: string;
    nextLabel: string;
    color: string;
    isDaylight?: boolean;
    disabled?: boolean;
}

type HoverSide = 'prev' | 'next' | null;

/**
 * 浮动播放条的标题区：悬浮时在标题两侧浮出上一首/下一首箭头，
 * 指针靠近某一侧时标题淡出、半透明预览该方向的曲目标题，移开即还原。
 * 只有箭头按钮自身会触发切歌并阻止冒泡；标题区其余部分的点击照常冒泡给胶囊，
 * 保留「点击进度条导航到 player 页」的既有行为。
 */
const TrackTitleNavigator: React.FC<TrackTitleNavigatorProps> = ({
    title,
    prevTitle,
    nextTitle,
    canPrev,
    canNext,
    onPrev,
    onNext,
    prevLabel,
    nextLabel,
    color,
    isDaylight = false,
    disabled = false,
}) => {
    // 离散状态，只在指针进出左右感应区时变化一次，不做逐帧位置追踪
    const [hoverSide, setHoverSide] = useState<HoverSide>(null);
    const [shownPreview, setShownPreview] = useState('');

    const activePreview = disabled
        ? null
        : hoverSide === 'prev'
            ? prevTitle
            : hoverSide === 'next'
                ? nextTitle
                : null;

    // 保留最后一次预览文本，避免移开时文字先跳回当前曲目、再淡出
    useEffect(() => {
        if (activePreview) {
            setShownPreview(activePreview);
        }
    }, [activePreview]);

    const zoneClass = 'absolute inset-y-0 flex items-center';
    const arrowClass = [
        'pointer-events-auto flex h-6 w-6 items-center justify-center rounded-full',
        'opacity-0 transition-opacity duration-200 group-hover/title:opacity-70 hover:!opacity-100',
        isDaylight ? 'hover:bg-black/10' : 'hover:bg-white/15',
    ].join(' ');

    const renderArrow = (side: Exclude<HoverSide, null>) => {
        const enabled = side === 'prev' ? canPrev : canNext;
        if (!enabled || disabled) {
            return null;
        }

        const neighborTitle = side === 'prev' ? prevTitle : nextTitle;
        const label = side === 'prev' ? prevLabel : nextLabel;
        const Icon = side === 'prev' ? ChevronLeft : ChevronRight;

        return (
            <button
                type="button"
                aria-label={label}
                title={neighborTitle || label}
                className={arrowClass}
                style={{ color }}
                onClick={(e) => {
                    // 必须拦住冒泡：胶囊自身的 onClick 会导航到 player 页
                    e.stopPropagation();
                    (side === 'prev' ? onPrev : onNext)();
                }}
            >
                <Icon size={16} strokeWidth={2.4} />
            </button>
        );
    };

    return (
        <div className="group/title relative min-w-0 select-none px-1">
            {/* 感应区比箭头宽，指针「靠近」箭头即可预览；区内非箭头处的点击不拦截 */}
            <div
                className={`${zoneClass} left-0 w-14 justify-start pl-1`}
                onMouseEnter={() => setHoverSide('prev')}
                onMouseLeave={() => setHoverSide(null)}
            >
                {renderArrow('prev')}
            </div>
            <div
                className={`${zoneClass} right-0 w-14 justify-end pr-1`}
                onMouseEnter={() => setHoverSide('next')}
                onMouseLeave={() => setHoverSide(null)}
            >
                {renderArrow('next')}
            </div>

            {/* 两行文字叠在同一格里做交叉淡入淡出，纯 CSS transition，无逐帧更新 */}
            <div className="grid px-14">
                <span
                    className={`col-start-1 row-start-1 truncate text-center text-sm font-bold transition-opacity duration-200 ${activePreview ? 'opacity-0' : 'opacity-100'}`}
                    style={{ color }}
                >
                    {title}
                </span>
                <span
                    aria-hidden
                    className={`col-start-1 row-start-1 truncate text-center text-sm font-bold transition-opacity duration-200 ${activePreview ? 'opacity-55' : 'opacity-0'}`}
                    style={{ color }}
                >
                    {shownPreview}
                </span>
            </div>
        </div>
    );
};

export default TrackTitleNavigator;
