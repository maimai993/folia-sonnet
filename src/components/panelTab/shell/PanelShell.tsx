import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useTransform, type MotionStyle } from 'framer-motion';
import type { Theme } from '../../../types';
import { usePlayerBottomBarBottomPx } from '../../../hooks/usePlayerBottomBarBottomPx';
import { usePlayerOverlayObstacle } from '../../../hooks/usePlayerOverlayLayout';
import { kitTransition, useKitReducedMotion } from '../../modal/settings/kit/motion';
import { panelTokens } from './panelTheme';
import { useGlassSurfaceSettingsStore } from '../../../stores/useGlassSurfaceSettingsStore';
import { FOLDED_PX } from './SongHeader';
import { PANEL_BOTTOM_LIFT_PX } from './panelBottomBaseline';
import { useIsShortViewport, useIsWideShortViewport } from './panelViewport';
import { useMeasuredSize } from './useMeasuredSize';
import { useBottomDockStore, useIsDockCompactWithCapsule } from '../../../stores/useBottomDockStore';

// src/components/panelTab/shell/PanelShell.tsx
// The frame of the playing page's panel: where it sits, the glass surface, and how tall it is. The
// surface stands wholly above the round handle and grows out of it. From top to bottom it holds the
// song (the header), the open tab (which scrolls inside when the window is short) and the tab row,
// which stays at the bottom edge. Each tab gets the height its content needs: the content is
// measured, and the surface follows with the kit's motion, upward from the tab row. The open
// surface is in the way of a mod's player layout (usePlayerOverlayObstacle) and says so as it moves.

/** The handle's height and the gap above it: how far the surface's bottom edge is above the handle's. */
const HANDLE_ROOM_PX = 60;
/** 矮屏下手柄上方那点净空压到最小（手柄 48px，只留 4px）—— 纵向每一像素都算数。 */
const SHORT_HANDLE_ROOM_PX = 52;
/** Under the surface when no handle is drawn below it. */
const BARE_GAP_PX = 8;
/** What stays free between the surface and the top of the window. */
const TOP_MARGIN_PX = 56;
/**
 * 矮屏的顶部留白：56 → 16。
 *
 * 横过来的手机一共才 390 高，顶部白留 56、底部播放条 + 手柄又扣掉一百多，面板就只剩一条缝了。
 */
const SHORT_TOP_MARGIN_PX = 16;
/** 又矮又宽时面板摊宽到这个宽度：横向有的是地方，摊宽之后页签能分两栏，纵向才够放。 */
const WIDE_SURFACE_PX = 560;
const SURFACE_PX = 360;
/**
 * 矮而宽时不必摊到最宽的那些页签：账号、本地、Navidrome、在线歌词、AI 导演。
 * 它们内容本来就少，摊到 560 只会把右半边留成一大块空白，给回窄一点的宽度。
 * 封面、控制、队列不在这张表里——封面要封面与文字并排，另外两个要分两栏（见各自组件）。
 */
const NARROW_WIDE_TABS: ReadonlySet<string> = new Set(['cover', 'account', 'local', 'navi', 'onlineLyrics', 'aiDirector']);
/** 矮而宽时上面那些页签的宽度：比窄屏的 360 稍宽，够放下两栏按钮又不横贯屏幕。 */
const NARROW_WIDE_SURFACE_PX = 392;
/** 又矮又宽时页签改成右侧一条竖轨（见 Segments 的 vertical）占的宽度。 */
const RAIL_WIDTH_PX = 52;
/** 竖轨的下限：页签内容本身很矮（空状态）时，几个图标也不该被压成一条。 */
const RAIL_MIN_HEIGHT_PX = 168;
const PADDING_PX = 12;
const DOCK_HEIGHT_PX = 36;
const DOCK_GAP_PX = 12;
/** Above the open tab: the gap, the hairline, and the gap under it. */
const BODY_TOP_PX = { gap: 12, line: 1, under: 8 } as const;
const BODY_TOP_TOTAL_PX = BODY_TOP_PX.gap + BODY_TOP_PX.line + BODY_TOP_PX.under;

type PanelShellProps = {
    isOpen: boolean;
    /** The round button stays under the open surface (a setting can take it away): the surface stands above it. */
    hasHandle: boolean;
    /** The cover tab is open: the header is the whole panel and there is no tab body. */
    isCover: boolean;
    /** Names the open tab: a new value brings its body in and measures it. */
    tabKey: string;
    theme: Theme;
    isDaylight: boolean;
    /** The song. It may use --pn-room, the height it can take on the cover tab, and 100cqw, the surface's inner width. */
    header: React.ReactNode;
    /** The tab row. */
    dock: React.ReactNode;
    /** The round button that opens and closes the panel. */
    handle: React.ReactNode;
    /** The open tab's body. It may use --pn-tab-room, the height it can take before it scrolls here. */
    children: React.ReactNode;
};

type PanelSurfaceProps = Omit<PanelShellProps, 'isOpen' | 'handle'> & {
    /** The handle hangs on the compact capsule's right end (progress-bar v3): the surface grows from there. */
    isDocked: boolean;
    /** Registers the surface as an obstacle of the player layout. */
    layoutRef: (element: HTMLElement | null) => void;
    /** Tells the player layout that the surface moved. */
    onLayoutUpdate: () => void;
};

const PanelSurface: React.FC<PanelSurfaceProps> = ({ hasHandle, isCover, tabKey, theme, isDaylight, header, dock, children, isDocked, layoutRef, onLayoutUpdate }) => {
    const reduced = useKitReducedMotion();
    // 液态玻璃开着时面板转半透明（panelTokens 的 glass 参数）。
    const glassOn = useGlassSurfaceSettingsStore(state => state.liquidGlassEnabled);
    const bottomBarBottomPx = usePlayerBottomBarBottomPx();
    const isShort = useIsShortViewport();
    // 矮而宽：摊宽面板，页签分两栏（见 ControlsTab）。竖屏手机横向没有余量，摊宽只会顶到屏幕边。
    const isWideShort = useIsWideShortViewport();
    // What is under the surface: the handle, or a small gap. A variable, so the two heights below follow it at once.
    // Docked on the compact capsule the surface always clears the capsule, handle or not.
    const underPx = hasHandle || isDocked ? (isShort ? SHORT_HANDLE_ROOM_PX : HANDLE_ROOM_PX) : BARE_GAP_PX;
    // 顶部留白走变量而不是直接算进下面的 calc：它是跟着屏幕高度变的，塞进 framer 的
    // transform 函数里，转屏后那个函数未必重算，面板就会一直按旧的留白算高度。
    const topMarginPx = isShort ? SHORT_TOP_MARGIN_PX : TOP_MARGIN_PX;
    // Never taller than the window allows, wherever the bottom bar's baseline has been lifted to.
    const maxHeight = useTransform(
        bottomBarBottomPx,
        bottom => `calc(100dvh - var(--pn-under) - ${bottom}px - var(--pn-top-margin))`,
    );
    // 页签栏占掉的纵向：竖轨模式下它花的是横向，纵向这一份要还给页签内容。
    // 走变量而不是算进下面的 calc —— 它随屏幕形态变，塞进 transform 函数里转屏后未必重算。
    const dockAllowancePx = isWideShort ? 0 : DOCK_GAP_PX + DOCK_HEIGHT_PX;
    const headerRoom = useTransform(
        bottomBarBottomPx,
        bottom => `calc(100dvh - var(--pn-under) - ${bottom}px - var(--pn-top-margin) - ${2 * PADDING_PX}px - var(--pn-dock))`,
    );
    const scrollRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const content = useMeasuredSize(contentRef, tabKey);
    // The surface takes the size of its tab while it is still closed: nothing inside it moves
    // until it has been painted once.
    const [isStill, setIsStill] = useState(true);
    useEffect(() => {
        const frame = requestAnimationFrame(() => setIsStill(false));
        return () => cancelAnimationFrame(frame);
    }, []);
    // A new tab starts at its top.
    useLayoutEffect(() => {
        scrollRef.current?.scrollTo({ top: 0 });
    }, [tabKey]);

    const bodyHeight = isCover ? 0 : BODY_TOP_PX.gap + BODY_TOP_PX.line + BODY_TOP_PX.under + content.height;
    // Where the surface comes from and goes back to: a little smaller, toward the handle.
    const away = { opacity: 0, scale: 0.92 };

    /* The tab's body: the hairline, then the open tab, which scrolls here when the window is short. */
    const body = (
        // As wide as the column, so the scrollbar (the kit's, as wide as the padding) lies in the surface's own padding.
        <div
            className="st-t-unfold flex min-h-0 shrink flex-col overflow-hidden transition-[height]"
            style={isWideShort
                // 竖轨模式下高度不写死（写死会把页签多出来的那点空间留白），只压一个上限：
                // 内容超过可用高度时**页签自己滚**，而不是把整块面板推着滚（那样竖轨会跟着滚出去）。
                ? {
                    marginInline: -PADDING_PX,
                    ...(isCover ? { height: 0 } : { maxHeight: `calc(var(--pn-tab-room) + ${BODY_TOP_TOTAL_PX}px)` }),
                }
                : { height: bodyHeight, marginInline: -PADDING_PX }}
        >
            <div
                className="h-px shrink-0 bg-[var(--st-line)]"
                style={{ marginTop: BODY_TOP_PX.gap, marginInline: PADDING_PX }}
            />
            <div
                ref={scrollRef}
                className="st-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
                style={{ paddingTop: BODY_TOP_PX.under, paddingLeft: PADDING_PX }}
            >
                <div ref={contentRef} key={tabKey} className="st-page-in">
                    {children}
                </div>
            </div>
        </div>
    );

    return (
        <motion.div
            ref={layoutRef}
            onUpdate={onLayoutUpdate}
            initial={away}
            animate={{ opacity: 1, scale: 1, transition: kitTransition('unfold', reduced) }}
            exit={{ ...away, transition: kitTransition('move', reduced) }}
            data-testid="unified-panel-surface"
            data-still={isStill || undefined}
            /*
             * ★ relative 是必须的：Popover 把 .st-window 当作定位包含块。
             *
             * Popover 会 portal 进 `.st-window`，并用 placePopover 算出
             * 「距离 .st-window 上下边多少像素」的 top / bottom 写进 style。
             * 但 .st-window 原先没有 position，是 static —— static 的元素
             * **不是** absolute 子元素的包含块，于是那个 top/bottom 会被解析到
             * 更外层某个定位祖先（这里正好是 framer 的 motion.div）身上：
             * 弹层的位置就整体偏了，底部被面板的 overflow-hidden 裁掉，
             * 里面明明还能滚的内容也就永远滑不到底。
             *
             * 加 relative 之后 .st-window 自己成为包含块，两边口径一致。
             */
            className={`st-window relative pointer-events-auto @container hide-scrollbar flex max-w-[calc(100vw-2rem)] overflow-y-auto overflow-x-hidden rounded-[20px] bg-[var(--pn-glass)] text-[color:var(--st-t1)] shadow-[var(--pn-shadow)] backdrop-blur-[40px] backdrop-saturate-[1.3] [&[data-still]_*]:transition-none ${isWideShort ? 'flex-row' : 'flex-col'}`}
            style={{
                ...panelTokens(isDaylight, theme, reduced, glassOn),
                width: isWideShort
                    ? (NARROW_WIDE_TABS.has(tabKey) ? NARROW_WIDE_SURFACE_PX : WIDE_SURFACE_PX)
                    : SURFACE_PX,
                '--pn-under': `${underPx}px`,
                '--pn-top-margin': `${topMarginPx}px`,
                '--pn-dock': `${dockAllowancePx}px`,
                '--pn-room': headerRoom,
                // What is left of that room under the song's one line and the hairline: a tab with a
                // list of its own ends the list there, so the list scrolls and the tab does not.
                '--pn-tab-room': `calc(var(--pn-room) - ${FOLDED_PX + BODY_TOP_PX.gap + BODY_TOP_PX.line + BODY_TOP_PX.under}px)`,
                // The tab's body shrinks and scrolls first. Only a window too short for the cover
                // tab's least height makes the surface itself scroll, so the tab row stays in reach.
                maxHeight,
                padding: PADDING_PX,
                marginBottom: underPx,
                // The centre of the handle, at the surface's right end. Docked on the compact capsule the
                // 40px handle sits 8px in from the capsule's right edge, its centre 38px under the surface.
                transformOrigin: isDocked
                    ? 'calc(100% - 28px) calc(100% + 38px)'
                    : `calc(100% - 24px) calc(100% + ${underPx - 24}px)`,
            } as MotionStyle}
        >
            {isWideShort ? (
                /*
                 * 矮而宽：页签从底边那条挪到右侧一条竖轨 —— 它花的是**横向**的余量
                 * （横过来的手机横向还剩一大半），纵向整条都还给页签内容。
                 *
                 * 竖轨跟整个面板一样高（贴在内容那一栏旁边），不是单独占一截：否则封面页签
                 * 也得为它留 168px 的空位，等于把省下来的高度又吐了回去。
                 */
                <>
                    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                        {header}
                        {body}
                    </div>
                    <div
                        className="shrink-0"
                        style={{ width: RAIL_WIDTH_PX, marginLeft: DOCK_GAP_PX, minHeight: RAIL_MIN_HEIGHT_PX }}
                    >
                        {dock}
                    </div>
                </>
            ) : (
                <>
                    {header}
                    {body}

                    <div className="shrink-0" style={{ height: DOCK_HEIGHT_PX, marginTop: DOCK_GAP_PX }}>
                        {dock}
                    </div>
                </>
            )}
        </motion.div>
    );
};

const PanelShell: React.FC<PanelShellProps> = ({ isOpen, handle, ...surface }) => {
    const bottomBarBottomPx = usePlayerBottomBarBottomPx();
    const { ref: layoutRef, invalidate: invalidateLayout } = usePlayerOverlayObstacle('player-panel', 'panel');
    // 在播放条那条基线之上再抬一点（见 PANEL_BOTTOM_LIFT_PX）—— 手柄抬的是同一份，两者不会错开。
    const shellBottom = useTransform(bottomBarBottomPx, bottom => bottom + PANEL_BOTTOM_LIFT_PX);
    // 紧凑档（progress-bar v3）：按钮挂在胶囊右端，面板从胶囊右端长出来，右边和胶囊对齐、底边在胶囊顶上
    // （bottomDock.css 平移这一层）。面板开着时胶囊不再悬停展开，免得两块玻璃叠在一起。
    const isDocked = useIsDockCompactWithCapsule();
    useEffect(() => {
        useBottomDockStore.getState().setCompanionOpen('panel', isOpen);
        return () => useBottomDockStore.getState().setCompanionOpen('panel', false);
    }, [isOpen]);

    return (
        <motion.div
            style={{ bottom: shellBottom }}
            onUpdate={invalidateLayout}
            className="absolute right-0 z-[60] flex flex-col items-end pointer-events-none"
            // 与手柄同一条基线：同样要从系统导航栏里让出来（见 PanelHandle 的注释）。
            data-folia-safe-bottom="shift"
            data-folia-safe-right="shift"
            onClick={(e) => e.stopPropagation()}
        >
            {/* 平移只加在面板这一层：按钮（handle）是 fixed 的兄弟，外层一带 translate 就成了它的定位参照，会被一起带偏。
                右边多留一点：贴着屏幕边时，那圈 20px 圆角看着像被切掉了一块。 */}
            <div
                className={`dock-companion dock-companion--panel-surface ${isDocked ? 'is-docked' : ''} pr-6 md:pr-8`}
                // 挂上、取下的平移走完再请 player.layout 量一次面板（CSS 平移不触发它自己的测量）。
                onTransitionEnd={invalidateLayout}
            >
                <AnimatePresence>
                    {isOpen && <PanelSurface {...surface} isDocked={isDocked} layoutRef={layoutRef} onLayoutUpdate={invalidateLayout} />}
                </AnimatePresence>
            </div>

            {handle}
        </motion.div>
    );
};

export default PanelShell;
