import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { Play, Pause } from 'lucide-react';
import { MotionValue } from 'framer-motion';
import ProgressBar from './ProgressBar';
import { PlayerState, LyricData, Theme } from '../types';
import LyricsTimelineModal from './modal/LyricsTimelineModal';
import { Button } from './ui';
import TrackTitleNavigator from './floating-player/TrackTitleNavigator';
import PlayerControlSlotButton from './floating-player/PlayerControlSlotButton';
import PlayerBottomBarPositioner from './floating-player/PlayerBottomBarPositioner';
import { usePlayerBarScrollSlide } from './floating-player/usePlayerBarScrollSlide';
import { usePlayerBottomBarBottomPx } from '../hooks/usePlayerBottomBarBottomPx';
import { playerBottomBarLiveOffset } from '../stores/motionSignals';
import { usePlayerBottomBarLayoutStore } from '../stores/usePlayerBottomBarLayoutStore';
import { usePlayerChromeSettingsStore } from '../stores/usePlayerChromeSettingsStore';
import { PLAYER_BOTTOM_BAR_BASE_OFFSET_PX, clampPlayerBottomBarOffset, resolvePlayerBottomBarMaxOffset } from '../utils/playerBottomBarLayout';
import type { PlayerControlSlotActionId, PlayerControlSlotContext } from './floating-player/playerControlSlotActions';
import { usePlayerOverlayObstacle } from '../hooks/usePlayerOverlayLayout';
import { resolveLyricSeekMediaTime } from '../utils/lyrics/lyricSeekTime';

export interface TrackNavigation {
    /** 当前曲目的稳定身份，用于识别「确实换歌了」；相邻两首同名时标题字符串不变，不能拿标题判断 */
    currentTrackKey: string;
    onPrev: () => void;
    onNext: () => void;
    canPrev: boolean;
    canNext: boolean;
    prevTitle: string | null;
    nextTitle: string | null;
    prevLabel: string;
    nextLabel: string;
}

const CONTROL_LAYOUT_SPRING = {
    type: 'spring' as const,
    stiffness: 280,
    damping: 24,
};

const HOVER_EXPAND_DELAY_MS = 20;
const HOVER_COLLAPSE_DELAY_MS = 100;
const HOVER_HITBOX_BOTTOM_BUFFER_PX = 32;
/** 暂停时自动展开露出的时间：够看见并点到控件，之后自己缩回一条进度条。 */
const AUTO_EXPAND_DURATION_MS = 4000;
/** 按下与松手之间超过这个距离就算拖动，不再当成点击（进度条 seek 完不该触发胶囊的动作）。 */
const CLICK_SLOP_PX = 8;
/*
 * 模组可以通过公开变量 --folium-player-bar-extra 加宽胶囊，补回进度条两侧按钮占掉的长度。
 * 外层 max-width 已经加了一份 extra；收起的胶囊是外层的 80% / 60%，所以只再补 (1 - 比例) 份，
 * 外层顶到 max-width 时收起胶囊正好宽出 extra。
 */
const COLLAPSED_WIDTH_CLASS = 'w-[min(100%,calc(80%_+_var(--folium-player-bar-extra,0px)_*_0.2))] md:w-[min(100%,calc(60%_+_var(--folium-player-bar-extra,0px)_*_0.4))]';

/**
 * 槽位上下文里由 App 提供的部分。循环模式、歌词时间轴和上一首/下一首的可用性
 * 胶囊自己已经有了，不让调用方重复传一遍。
 */
export type SlotContextFromApp = Omit<
    PlayerControlSlotContext,
    'loopMode' | 'onToggleLoop' | 'onToggleTimeline' | 'hasLyrics' | 'canPrev' | 'canNext' | 'onPrev' | 'onNext'
>;

interface FloatingPlayerControlsProps {
    currentSong: { name: string; } | null;
    playerState: PlayerState;
    currentTime: MotionValue<number>;
    lyricCurrentTime?: MotionValue<number>;
    duration: number;
    loopMode: 'off' | 'all' | 'one' | 'shuffle';
    currentView: 'home' | 'player' | 'lattice';
    audioSrc: string | null;
    canTogglePlay?: boolean;
    lyrics: LyricData | null;
    onSeek: (time: number) => void;
    onTogglePlay: () => void;
    onToggleLoop: () => void;
    onNavigateToPlayer: () => void;
    noTrackText?: string;
    primaryColor?: string;
    secondaryColor?: string;
    theme?: Theme;
    isDaylight: boolean;
    isHidden?: boolean;
    /**
     * 跟着列表往下滚暂时收到屏幕下面（只用于搜索页这类整屏列表：它末尾的「查看更多」被胶囊压住）。
     * 和 isHidden 不同，这里只是移出视口，不做淡出 —— 往上一滚就滑回来。
     */
    isScrollHidden?: boolean;
    hideControlBar?: boolean;
    controlsDisabled?: boolean;
    trackNavigation?: TrackNavigation | null;
    /** 右侧两个可自定义槽位的动作 id。 */
    slotPrimary: PlayerControlSlotActionId;
    slotSecondary: PlayerControlSlotActionId;
    /** 槽位共用的播放上下文里，胶囊自己能提供的那几项在内部补齐。 */
    slotContext: SlotContextFromApp;
    /** 提交定位结果；由 App 写回持久化设置。 */
    onCommitBottomBarOffset: (offsetPx: number) => void;
}


const FloatingPlayerControls: React.FC<FloatingPlayerControlsProps> = ({
    currentSong,
    playerState,
    currentTime,
    lyricCurrentTime,
    duration,
    loopMode,
    currentView,
    audioSrc,
    canTogglePlay = false,
    lyrics,
    onSeek,
    onTogglePlay,
    onToggleLoop,
    onNavigateToPlayer,
    noTrackText = 'No Track',
    primaryColor = 'var(--text-primary)',
    secondaryColor = 'var(--text-secondary)',
    theme,
    isDaylight,
    isHidden = false,
    isScrollHidden = false,
    hideControlBar = false,
    controlsDisabled = false,
    trackNavigation = null,
    slotPrimary,
    slotSecondary,
    slotContext,
    onCommitBottomBarOffset,
}) => {
    const { t } = useTranslation();
    const { ref: layoutRef, invalidate: invalidateLayout } = usePlayerOverlayObstacle(
        'player-controls',
        'playback',
        !isHidden && !isScrollHidden,
    );
    // const isDaylight = theme?.name === 'Daylight Default'; // Deprecated, passed as prop
    const glassBgExpanded = isDaylight ? 'bg-white/60 border border-white/20 shadow-xl' : 'bg-black/40 border border-white/5';
    const glassBgCollapsed = isDaylight ? 'bg-white/40 border border-white/20 shadow-lg hover:bg-white/50' : 'bg-black/20 border border-white/5 hover:bg-black/30';
    const trackColor = isDaylight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.1)';
    // Button bg logic
    const buttonBg = isDaylight ? { backgroundColor: primaryColor, color: 'var(--bg-color)' } : { backgroundColor: primaryColor, color: 'var(--bg-color)' }; // Keep primary for play button, looks good

    // Other buttons hover
    const iconBtnExpandedClass = isDaylight ? 'hover:bg-black/5' : 'bg-white/20'; // Wait, loop button has logic
    const iconBtnClass = isDaylight ? 'hover:bg-black/5 text-black/60' : 'hover:bg-white/10 opacity-40 hover:opacity-100';

    const [isHovered, setIsHovered] = useState(false);
    const [isTimelineOpen, setIsTimelineOpen] = useState(false);
    const expandTimeoutRef = useRef<number | null>(null);
    const collapseTimeoutRef = useRef<number | null>(null);
    const [autoExpanded, setAutoExpanded] = useState(false);
    const autoCollapseTimeoutRef = useRef<number | null>(null);
    /** 命中区（含向下那块补丁）的整体：点它以外的地方算「点周围」。 */
    const hitboxRef = useRef<HTMLDivElement | null>(null);
    /** 按下时的指针位置：松手时位移超过阈值就是拖动，不算点击。 */
    const pressOriginRef = useRef<{ x: number; y: number; } | null>(null);
    /**
     * 收起态那一下「点开」的尾巴要不要吃掉。
     *
     * 展开是在**松手**（pointerup）时做的 —— 收起态几乎整块是进度条那个 range，它会
     * stopPropagation，click 根本到不了胶囊，只能在 pointerup 上判。于是紧接着浏览器补发的
     * 那一次 click 落在一个**已经变了**的界面上：展开态的播放键正好顶在手指底下，于是
     * 「想展开」变成了「展开 + 暂停」。
     *
     * 在 pointerdown 上清零（新的一次点按一律重新算），只有「收起态点开」这一条路会置上。
     */
    const swallowNextClickRef = useRef(false);

    const bottomBarBottomPx = usePlayerBottomBarBottomPx();
    const isPositioning = usePlayerBottomBarLayoutStore(state => state.isPositioning);
    const commitPositioning = usePlayerBottomBarLayoutStore(state => state.commitPositioning);
    const cancelPositioning = usePlayerBottomBarLayoutStore(state => state.cancelPositioning);
    // 拖动起点：按下时的指针 Y 和当时的偏移量。位移是相对的，靠这两个值换算成绝对偏移量。
    const dragOriginRef = useRef<{ pointerY: number; offset: number; } | null>(null);
    const [maxOffsetPx, setMaxOffsetPx] = useState(() => (
        typeof window === 'undefined'
            ? PLAYER_BOTTOM_BAR_BASE_OFFSET_PX
            : resolvePlayerBottomBarMaxOffset(window.innerHeight)
    ));

    const canAutoExpand = canTogglePlay && duration > 0;
    /**
     * 暂停（且不在首页）时把控件露出来给用户按，但只露一会儿：原先这里是常驻展开，
     * 而触屏上根本不会有「指针移开」这件事，胶囊就一直停在展开态回不去。
     */
    const wantsAutoExpand = canAutoExpand && !isPositioning && playerState !== PlayerState.PLAYING && currentView !== 'home';
    // 定位模式强制展开：用户要看到的是最终形态的胶囊，而不是一条细进度条。
    const showExpanded = isPositioning || isHovered || autoExpanded;

    /** 排一次「过几秒收起」：暂停自动展开与手动展开共用这一条收回路径。 */
    const scheduleAutoCollapse = useCallback(() => {
        if (autoCollapseTimeoutRef.current !== null) {
            window.clearTimeout(autoCollapseTimeoutRef.current);
        }
        autoCollapseTimeoutRef.current = window.setTimeout(() => {
            autoCollapseTimeoutRef.current = null;
            setAutoExpanded(false);
        }, AUTO_EXPAND_DURATION_MS);
    }, []);

    useEffect(() => {
        if (!wantsAutoExpand) {
            setAutoExpanded(false);
            return;
        }
        setAutoExpanded(true);
        scheduleAutoCollapse();
        return () => {
            if (autoCollapseTimeoutRef.current !== null) {
                window.clearTimeout(autoCollapseTimeoutRef.current);
                autoCollapseTimeoutRef.current = null;
            }
        };
    }, [scheduleAutoCollapse, wantsAutoExpand]);

    // 点胶囊以外的任何地方：自动展开的那一下立刻收起，不必等定时器走完。
    useEffect(() => {
        if (!autoExpanded) {
            return;
        }
        const dismiss = (event: Event) => {
            const target = event.target;
            if (hitboxRef.current && target instanceof Node && !hitboxRef.current.contains(target)) {
                setAutoExpanded(false);
            }
        };
        document.addEventListener('pointerdown', dismiss);
        return () => document.removeEventListener('pointerdown', dismiss);
    }, [autoExpanded]);

    // 上限依赖视口高度，窗口变矮时要跟着收，否则虚线框会画到屏幕外。
    useEffect(() => {
        if (!isPositioning) {
            return;
        }

        const syncMax = () => setMaxOffsetPx(resolvePlayerBottomBarMaxOffset(window.innerHeight));
        syncMax();
        window.addEventListener('resize', syncMax);
        return () => window.removeEventListener('resize', syncMax);
    }, [isPositioning]);

    const handlePositionDragStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!isPositioning) {
            return;
        }
        dragOriginRef.current = { pointerY: e.clientY, offset: playerBottomBarLiveOffset.get() };
        e.currentTarget.setPointerCapture(e.pointerId);
    }, [isPositioning]);

    const handlePositionDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        const origin = dragOriginRef.current;
        if (!origin) {
            return;
        }
        // 只写 MotionValue，不进 React 更新路径：这是 pointer move 级别的高频回调。
        // 指针往上走 clientY 变小，偏移量要变大，所以是 origin.pointerY - e.clientY。
        playerBottomBarLiveOffset.set(clampPlayerBottomBarOffset(
            origin.offset + (origin.pointerY - e.clientY),
            window.innerHeight,
        ));
    }, []);

    const handlePositionDragEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!dragOriginRef.current) {
            return;
        }
        dragOriginRef.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
    }, []);

    // 定位模式只在播放页的控制条上成立。离开播放页或把控制条整条隐藏后，
    // 拖手和退出按钮都不在场了，状态留着会把胶囊永久钉在展开且不可交互的样子上。
    useEffect(() => {
        if (isPositioning && (currentView !== 'player' || hideControlBar)) {
            cancelPositioning();
        }
    }, [cancelPositioning, currentView, hideControlBar, isPositioning]);

    // 卸载时兜底：当前歌曲被清空会让整条控制条不再渲染，上面那个 effect 也就没机会跑，
    // 定位状态会残留成一个谁也退不出的模式。用 getState 读，避免把 cleanup 绑到回调身份上。
    const isPositioningRef = useRef(isPositioning);
    isPositioningRef.current = isPositioning;
    useEffect(() => () => {
        if (isPositioningRef.current) {
            usePlayerBottomBarLayoutStore.getState().cancelPositioning();
        }
    }, []);

    const handleCommitPositioning = useCallback(() => {
        onCommitBottomBarOffset(commitPositioning());
    }, [commitPositioning, onCommitBottomBarOffset]);

    // Esc 取消回滚，Enter 确认。定位模式是个全屏态，键盘出口是必须的。
    useEffect(() => {
        if (!isPositioning) {
            return;
        }

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                cancelPositioning();
            } else if (event.key === 'Enter') {
                event.preventDefault();
                handleCommitPositioning();
            }
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [cancelPositioning, handleCommitPositioning, isPositioning]);

    // 命中区补丁按离底距离收敛。抬高后胶囊下面不再是屏幕边缘，多出来的 padding
    // 只会变成一块吃掉指针事件的死区。
    //
    // 读的是已保存值而不是拖动中的 MotionValue：这个数要参与 padding/margin 的布局计算，
    // 跟着每帧变就得每帧 setState。拖动过程中 hover 展开本来也不起作用，落定后自然就对了。
    const savedBottomBarOffset = usePlayerChromeSettingsStore(state => state.playerBottomBarOffset);
    const hoverHitboxBufferPx = Math.max(
        0,
        Math.round(HOVER_HITBOX_BOTTOM_BUFFER_PX - (savedBottomBarOffset - PLAYER_BOTTOM_BAR_BASE_OFFSET_PX)),
    );
    const { isSliding: isScrollSliding, layoutAnimationEnabled, layerStyle: scrollSlideStyle } = usePlayerBarScrollSlide(
        isScrollHidden,
        savedBottomBarOffset,
    );

    // 槽位上下文：调用方给的那份，加上胶囊自己掌握的循环模式、歌词时间轴和相邻曲目可用性。
    const resolvedSlotContext = useMemo<PlayerControlSlotContext>(() => ({
        ...slotContext,
        loopMode,
        onToggleLoop,
        onToggleTimeline: () => setIsTimelineOpen(true),
        hasLyrics: !!lyrics,
        canPrev: !!trackNavigation?.canPrev,
        canNext: !!trackNavigation?.canNext,
        onPrev: trackNavigation?.onPrev ?? (() => { }),
        onNext: trackNavigation?.onNext ?? (() => { }),
    }), [lyrics, loopMode, onToggleLoop, slotContext, trackNavigation]);

    useEffect(() => {
        return () => {
            if (expandTimeoutRef.current !== null) {
                window.clearTimeout(expandTimeoutRef.current);
            }
            if (collapseTimeoutRef.current !== null) {
                window.clearTimeout(collapseTimeoutRef.current);
            }
            if (autoCollapseTimeoutRef.current !== null) {
                window.clearTimeout(autoCollapseTimeoutRef.current);
            }
        };
    }, []);

    /**
     * 只用真鼠标的悬停展开。触屏点一下也会合成 mouseenter，但之后不会有任何「指针移开」
     * 的事件 —— 那样展开就永久卡住，而暂停时的展开另有定时器负责收回（见 wantsAutoExpand）。
     */
    const handlePointerEnter = (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.pointerType !== 'mouse') {
            return;
        }
        if (collapseTimeoutRef.current !== null) {
            window.clearTimeout(collapseTimeoutRef.current);
            collapseTimeoutRef.current = null;
        }

        if (expandTimeoutRef.current !== null) {
            return;
        }

        expandTimeoutRef.current = window.setTimeout(() => {
            setIsHovered(true);
            expandTimeoutRef.current = null;
        }, HOVER_EXPAND_DELAY_MS);
    };

    const handlePointerLeave = (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.pointerType !== 'mouse') {
            return;
        }
        if (expandTimeoutRef.current !== null) {
            window.clearTimeout(expandTimeoutRef.current);
            expandTimeoutRef.current = null;
        }

        if (!isHovered || collapseTimeoutRef.current !== null) {
            return;
        }

        collapseTimeoutRef.current = window.setTimeout(() => {
            setIsHovered(false);
            collapseTimeoutRef.current = null;
        }, HOVER_COLLAPSE_DELAY_MS);
    };

    const handleBarPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        // 新的一次点按：上一轮的「尾巴」到这里为止，不能再吃掉这一轮的 click。
        swallowNextClickRef.current = false;
        pressOriginRef.current = { x: event.clientX, y: event.clientY };
        handlePositionDragStart(event);
    }, [handlePositionDragStart]);

    /**
     * 吃掉刚被「点开」的那一次 click。
     *
     * 捕获阶段就拦：展开态那些按钮是这一层的后代，等冒泡到它们身上再判，播放已经被切了。
     * （见 swallowNextClickRef 的说明。）
     */
    const handleBarClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        if (!swallowNextClickRef.current) {
            return;
        }
        swallowNextClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
    }, []);

    /**
     * 「点了一下」在松手时判，不在 click 上判：进度条那个 range 会 stopPropagation，
     * 收起态的胶囊几乎整块都是它，click 根本到不了这里 —— 而用户点胶囊想的是先把控件
     * 露出来（原先在队列磁贴里这一下直接跳去聚焦当前歌）。
     */
    const handleBarPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const origin = pressOriginRef.current;
        pressOriginRef.current = null;
        handlePositionDragEnd(event);
        if (isPositioning || !origin) {
            return;
        }
        // 拖进度条、拖胶囊之后松手也会来一次 pointerup：动过就不算点。
        if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > CLICK_SLOP_PX) {
            return;
        }
        const target = event.target instanceof Element ? event.target : null;
        // 展开态里这些元素各管各的：按钮有自己的 onClick，进度条那一下只 seek ——
        // 都不该再被当成「点了胶囊」（否则调个进度就被送去播放页）。
        if (showExpanded && target?.closest('button, a, [role="button"], [data-folium-part^="progress"]')) {
            return;
        }
        if (!showExpanded) {
            // 这一次点按的目的已经达到了（把控件露出来）；补发的 click 落在展开后的按钮上
            // 会被当成第二次操作，见 handleBarClickCapture。
            swallowNextClickRef.current = true;
            setAutoExpanded(true);
            scheduleAutoCollapse();
            return;
        }
        // 展开态：队列磁贴里再点一下收起（那里不该跳走），其余视图照旧进播放页。
        if (currentView === 'lattice') {
            setAutoExpanded(false);
            return;
        }
        onNavigateToPlayer();
    }, [
        currentView,
        handlePositionDragEnd,
        isPositioning,
        onNavigateToPlayer,
        scheduleAutoCollapse,
        showExpanded,
    ]);

    if (hideControlBar) {
        return null;
    }

    return (
        <>
            {/*
                定位层和动画层必须分开。这一层用 Tailwind 的 `-translate-x-1/2` 做水平居中，
                而下面那层的 animate 会写 y/scale —— framer-motion 生成的 transform 会整个
                盖掉同一节点上的 Tailwind transform，合并两层会让胶囊丢失居中、向右偏出去。
                bottom 走共享 MotionValue（默认 32，即原来的 bottom-8），不是 transform 属性，
                所以挂在这一层不会干扰居中。
            */}
            <motion.div
                className={`absolute left-1/2 -translate-x-1/2 z-60 w-full flex justify-center pointer-events-none
                    ${currentView === 'home'
                        ? 'max-w-[calc(100vw-120px)] md:max-w-[min(calc(32rem_+_var(--folium-player-bar-extra,0px)),calc(100vw-120px))]'
                        : 'max-w-[min(calc(32rem_+_var(--folium-player-bar-extra,0px)),100vw)] px-4'}`}
                style={{ bottom: bottomBarBottomPx }}
                onUpdate={invalidateLayout}
            >
            <div
                // 收起/放回的位移层：位移走 CSS 过渡（合成线程），和 framer 那层分开，样式见
                // usePlayerBarScrollSlide。
                className="w-full flex justify-center pointer-events-none"
                style={scrollSlideStyle}
            >
            <motion.div
                className="w-full flex justify-center pointer-events-none"
                onUpdate={invalidateLayout}
                initial={false}
                animate={{
                    opacity: isHidden ? 0 : 1,
                    y: isHidden ? 24 : 0,
                    scale: isHidden ? 0.97 : 1,
                }}
                transition={{ duration: 0.26, ease: 'easeOut' }}
                style={{ pointerEvents: isHidden || isScrollHidden ? 'none' : 'auto' }}
                onClick={(e) => e.stopPropagation()}
                // 手机横屏那档要把这一层和下面那个全宽命中盒一起交回 pass-through：
                // 悬停展开在触屏上没有意义，可铺满下缘的命中区会把别的贴底控件一起吃掉
                // （侧切入面板的最低一排按钮就是这么点不到的）。
                data-folia-player-bar-hitbox-host="true"
            >
                <div
                    ref={hitboxRef}
                    data-folia-player-bar-hitbox="true"
                    className="pointer-events-auto w-full flex justify-center"
                    onPointerEnter={handlePointerEnter}
                    onPointerLeave={handlePointerLeave}
                    style={{
                        // 这块向下的命中区补丁只在胶囊贴底时才有意义；抬高之后按当前偏移量收敛，
                        // 否则胶囊下方会留一条既不可点也挡不住东西的死区。
                        paddingBottom: `${hoverHitboxBufferPx}px`,
                        marginBottom: `${-hoverHitboxBufferPx}px`,
                    }}
                >
                    <motion.div
                        ref={layoutRef}
                        onUpdate={invalidateLayout}
                        onLayoutAnimationComplete={invalidateLayout}
                        layout={layoutAnimationEnabled}
                        transition={{ layout: CONTROL_LAYOUT_SPRING }}
                        // 用原生 pointer 事件而不是 framer-motion 的 drag：位移已经由 playerBottomBarLiveOffset
                        // 经外层 lift 表达，再让 drag 往这个节点写一份 y 会叠加成两倍位移；
                        // 而且 dragConstraints 依赖的起始值放在 ref 里不会触发重渲染，读到的会是上一帧的。
                        data-ponder="player-bar"
                        // 手机适配的 CSS 靠它区分展开态与收起态（两者的内边距/高度规则不同）。
                        data-folia-player-bar-expanded={showExpanded ? 'true' : 'false'}
                        onPointerDown={handleBarPointerDown}
                        onPointerMove={handlePositionDragMove}
                        onPointerUp={handleBarPointerUp}
                        onPointerCancel={handlePositionDragEnd}
                        onClickCapture={handleBarClickCapture}
                        style={{ touchAction: isPositioning ? 'none' : undefined }}
                        className={`overflow-hidden rounded-full relative transition-colors duration-300
                            ${isScrollSliding ? 'shadow-none' : 'backdrop-blur-xl shadow-2xl'}
                            ${isPositioning ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}
                            ${showExpanded ? `p-3 ${glassBgExpanded} w-full` : `px-4 py-2 ${glassBgCollapsed} ${COLLAPSED_WIDTH_CLASS}`}`}
                    >
                        <motion.div
                            layout={layoutAnimationEnabled}
                            transition={{ layout: CONTROL_LAYOUT_SPRING }}
                            // 定位模式下 seek 和所有按钮一起失效：这时胶囊是个被拖的物体，不是控件。
                            className={`w-full ${isPositioning ? 'pointer-events-none select-none' : ''}`}
                        >
                            {showExpanded ? (
                                <ExpandedView
                                    currentSong={currentSong}
                                    playerState={playerState}
                                    currentTime={currentTime}
                                    lyricCurrentTime={lyricCurrentTime}
                                    duration={duration}
                                    canTogglePlay={canTogglePlay}
                                    onSeek={onSeek}
                                    onTogglePlay={onTogglePlay}
                                    noTrackText={noTrackText}
                                    primaryColor={primaryColor}
                                    secondaryColor={secondaryColor}
                                    trackColor={trackColor}
                                    isDaylight={isDaylight}
                                    controlsDisabled={controlsDisabled || isPositioning}
                                    trackNavigation={trackNavigation}
                                    slotPrimary={slotPrimary}
                                    slotSecondary={slotSecondary}
                                    slotContext={resolvedSlotContext}
                                />
                            ) : (
                                <CollapsedView
                                    currentTime={currentTime}
                                    duration={duration}
                                    onSeek={onSeek}
                                    primaryColor={primaryColor}
                                    secondaryColor={secondaryColor}
                                    trackColor={trackColor}
                                    controlsDisabled={controlsDisabled}
                                />
                            )}
                        </motion.div>
                    </motion.div>
                </div>
            </motion.div>
            </div>
            </motion.div>

            <AnimatePresence>
                {isPositioning && (
                    <PlayerBottomBarPositioner
                        maxOffsetPx={maxOffsetPx}
                        accentColor={primaryColor}
                        isDaylight={isDaylight}
                        onReset={() => playerBottomBarLiveOffset.set(PLAYER_BOTTOM_BAR_BASE_OFFSET_PX)}
                        onCommit={handleCommitPositioning}
                        onCancel={cancelPositioning}
                    />
                )}
            </AnimatePresence>

            <LyricsTimelineModal
                isOpen={isTimelineOpen}
                onClose={() => setIsTimelineOpen(false)}
                lyrics={lyrics}
                duration={duration}
                currentTime={lyricCurrentTime ?? currentTime}
                onSeek={(time) => {
                    const target = resolveLyricSeekMediaTime(time, {
                        mediaTimeSec: currentTime.get(),
                        lyricTimeSec: lyricCurrentTime?.get() ?? currentTime.get(),
                        durationSec: duration,
                    });
                    if (target !== null) onSeek(target);
                }}
                primaryColor={primaryColor}
                secondaryColor={secondaryColor}
                accentColor="var(--text-accent)"
                theme={theme}
                isDaylight={isDaylight}
                disabled={controlsDisabled}
            />
        </>
    );
};

// 展开视图组件
interface ExpandedViewProps {
    currentSong: { name: string; } | null;
    playerState: PlayerState;
    currentTime: MotionValue<number>;
    lyricCurrentTime?: MotionValue<number>;
    duration: number;
    canTogglePlay: boolean;
    onSeek: (time: number) => void;
    onTogglePlay: () => void;
    noTrackText: string;
    primaryColor: string;
    secondaryColor: string;
    trackColor?: string;
    isDaylight?: boolean;
    controlsDisabled?: boolean;
    trackNavigation?: TrackNavigation | null;
    slotPrimary: PlayerControlSlotActionId;
    slotSecondary: PlayerControlSlotActionId;
    slotContext: PlayerControlSlotContext;
}

const ExpandedView: React.FC<ExpandedViewProps> = ({
    currentSong,
    playerState,
    currentTime,
    lyricCurrentTime,
    duration,
    canTogglePlay,
    onSeek,
    onTogglePlay,
    noTrackText,
    primaryColor,
    secondaryColor,
    trackColor,
    isDaylight,
    controlsDisabled = false,
    trackNavigation = null,
    slotPrimary,
    slotSecondary,
    slotContext,
}) => {
    return (
        <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-x-4 gap-y-2 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
            {/* Desktop Layout - responsive grid positions apply from the sm breakpoint */}
            {/* Mobile Layout - base grid positions apply below the sm breakpoint */}
            {/* Row 1: Centered Title */}
            <div data-folia-player-bar-title="true" className="col-span-3 row-start-1 min-w-0 px-2 sm:col-start-2 sm:col-span-1">
                {trackNavigation ? (
                    <TrackTitleNavigator
                        title={currentSong?.name || noTrackText}
                        trackKey={trackNavigation.currentTrackKey}
                        prevTitle={trackNavigation.prevTitle}
                        nextTitle={trackNavigation.nextTitle}
                        canPrev={trackNavigation.canPrev}
                        canNext={trackNavigation.canNext}
                        onPrev={trackNavigation.onPrev}
                        onNext={trackNavigation.onNext}
                        prevLabel={trackNavigation.prevLabel}
                        nextLabel={trackNavigation.nextLabel}
                        color={primaryColor}
                        isDaylight={isDaylight}
                        disabled={controlsDisabled}
                    />
                ) : (
                    <div className="truncate text-center text-sm font-bold select-none" style={{ color: primaryColor }}>
                        {currentSong?.name || noTrackText}
                    </div>
                )}
            </div>

            {/* Row 3: Loop Button, Play Button, Lyrics Button */}
            <Button
                data-folia-player-bar-play="true"
                onClick={(e) => {
                    e.stopPropagation();
                    onTogglePlay();
                }}
                disabled={!canTogglePlay || controlsDisabled}
                className={`col-start-2 row-start-2 flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-none bg-(--text-primary) text-black shadow-lg transition-transform sm:col-start-1 sm:row-start-1 sm:row-span-2 ${controlsDisabled ? 'cursor-not-allowed opacity-45' : 'hover:scale-105'}`}
                style={{ backgroundColor: primaryColor, color: 'var(--bg-color)' }}
            >
                {playerState === PlayerState.PLAYING ? (
                    <Pause size={20} fill="currentColor" />
                ) : (
                    <Play size={20} fill="currentColor" className="ml-1" />
                )}
            </Button>

            {/* 两个可自定义槽位。默认仍是循环模式 + 歌词时间轴，和改动前一致。 */}
            <div
                data-ponder-slots
                className="contents sm:col-start-3 sm:row-start-1 sm:row-span-2 sm:flex sm:items-center sm:gap-1"
            >
                <PlayerControlSlotButton
                    actionId={slotPrimary}
                    context={slotContext}
                    primaryColor={primaryColor}
                    isDaylight={isDaylight}
                    controlsDisabled={controlsDisabled}
                    className="col-start-1 row-start-2 justify-self-end sm:justify-self-auto"
                />

                <PlayerControlSlotButton
                    actionId={slotSecondary}
                    context={slotContext}
                    primaryColor={primaryColor}
                    isDaylight={isDaylight}
                    controlsDisabled={controlsDisabled}
                    className="col-start-3 row-start-2 justify-self-start sm:justify-self-auto"
                />
            </div>

            {/* Row 2: Current Time, Progress Bar, Duration */}
            <div data-folia-player-bar-progress="true" className="col-span-3 row-start-3 w-full px-2 sm:col-start-2 sm:col-span-1 sm:row-start-2">
                <ProgressBar
                    currentTime={currentTime}
                    duration={duration}
                    onSeek={onSeek}
                    primaryColor={primaryColor}
                    secondaryColor={secondaryColor}
                    trackColor={trackColor}
                    disabled={controlsDisabled}
                />
            </div>
        </div>
    );
};

// 折叠视图组件
interface CollapsedViewProps {
    currentTime: MotionValue<number>;
    duration: number;
    onSeek: (time: number) => void;
    primaryColor: string;
    secondaryColor: string;
    trackColor?: string;
    controlsDisabled?: boolean;
}

const CollapsedView: React.FC<CollapsedViewProps> = ({
    currentTime,
    duration,
    onSeek,
    primaryColor,
    secondaryColor,
    trackColor,
    controlsDisabled = false,
}) => {
    return (
        <div className="flex items-center w-full justify-center h-8 px-4">
            <ProgressBar
                currentTime={currentTime}
                duration={duration}
                onSeek={onSeek}
                primaryColor={primaryColor}
                secondaryColor={secondaryColor}
                trackColor={trackColor}
                disabled={controlsDisabled}
                collapsed
            />
        </div>
    );
};

export default FloatingPlayerControls;
