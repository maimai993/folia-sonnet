import type { CSSProperties } from 'react';
import type { PonderRelativeRect } from '../../../types/ponder';

// src/components/ponder/surfaces/ponderSurfaceGeometry.ts
// 合成页面界面和教程锚点共用的一张几何表。
//
// 这层存在的唯一理由是不让两边走散：surface 用 relativeRectStyle 把一条记录翻成 CSS 定位，
// target 把同一条记录原样交给 relative 锚点。各写一遍百分比的写法做不到对齐 —— 高亮框会落在
// 真实元素旁边几个百分点，指向线也跟着指偏，看起来就是骨架和界面对不上。
//
// 坐标系一律是「所属容器的 0..1」，和 CSS 的 inset / aspect-square 同义。

/** 相对矩形 → 绝对定位样式。和 resolvePonderAnchors 的 relativeRectToPx 必须是同一套换算。 */
export const relativeRectStyle = (rect: PonderRelativeRect): CSSProperties => {
    const pct = (value: number) => `${value * 100}%`;
    return {
        position: 'absolute',
        ...(rect.left !== undefined ? { left: pct(rect.left) } : {}),
        ...(rect.right !== undefined ? { right: pct(rect.right) } : {}),
        ...(rect.top !== undefined ? { top: pct(rect.top) } : {}),
        ...(rect.bottom !== undefined ? { bottom: pct(rect.bottom) } : {}),
        ...(rect.width !== undefined ? { width: pct(rect.width) } : {}),
        ...(rect.square
            ? { aspectRatio: '1 / 1' }
            : rect.height !== undefined ? { height: pct(rect.height) } : {}),
    };
};

/** 无限墙上的海报，坐标系是 wall。焦点那张同时是 `poster` 锚点，不另外写一份。 */
export const LATTICE_POSTERS: readonly PonderRelativeRect[] = [
    { left: 0.04, top: 0.08, width: 0.20, height: 0.24 },
    { left: 0.26, top: 0.04, width: 0.17, height: 0.29 },
    { left: 0.45, top: 0.10, width: 0.24, height: 0.22 },
    { left: 0.72, top: 0.04, width: 0.20, height: 0.27 },
    { left: 0.02, top: 0.38, width: 0.17, height: 0.25 },
    { left: 0.22, top: 0.37, width: 0.25, height: 0.28 },
    { left: 0.50, top: 0.36, width: 0.18, height: 0.23 },
    { left: 0.71, top: 0.34, width: 0.25, height: 0.30 },
    { left: 0.07, top: 0.68, width: 0.22, height: 0.25 },
    { left: 0.32, top: 0.70, width: 0.17, height: 0.22 },
    { left: 0.52, top: 0.64, width: 0.24, height: 0.27 },
    { left: 0.79, top: 0.70, width: 0.17, height: 0.21 },
];

/** 教程里被聚焦、被展开的那张海报的序号。 */
export const LATTICE_FOCUSED_POSTER = 5;

/**
 * 「拖动平移相机」那一步把墙挪走多少，单位是 wall 自身的比例。
 *
 * 平移之后的聚焦层必须沿用同一个位移：两层墙只在焦点描边上有差别时，交叉淡入看不出破绽；
 * 位移不一致的话，淡入淡出那半秒屏幕上就是两面错开的墙。
 */
export const LATTICE_PAN = { x: -0.068, y: 0.036 };

const latticePannedPoster = (poster: PonderRelativeRect): PonderRelativeRect => ({
    ...poster,
    left: (poster.left ?? 0) + LATTICE_PAN.x,
    top: (poster.top ?? 0) + LATTICE_PAN.y,
});

export const LATTICE_GEOMETRY = {
    /** 相对 page。 */
    wall: { left: 0.06, right: 0.06, top: 0.07, bottom: 0.10 },
    /** 相对 wall。 */
    poster: LATTICE_POSTERS[LATTICE_FOCUSED_POSTER],
    /** 相对 wall：相机平移之后那张焦点海报落在哪。 */
    pannedPoster: latticePannedPoster(LATTICE_POSTERS[LATTICE_FOCUSED_POSTER]),
    back: { left: 0.03, top: 0.04, width: 0.06, square: true },
    tools: { right: 0.04, bottom: 0.05, width: 0.07, square: true },
    expanded: { left: 0.20, right: 0.20, top: 0.13, bottom: 0.14 },
    /** 相对 expanded：展开海报底部那条播放控制。 */
    chrome: { left: 0.06, right: 0.06, bottom: 0.06, height: 0.26 },
    toolsPanel: { right: 0.04, bottom: 0.13, width: 0.38, height: 0.40 },
    command: { left: 0.18, right: 0.18, top: 0.14, bottom: 0.20 },
} satisfies Record<string, PonderRelativeRect>;

/** Grid3D 轨道上的五张卡，坐标系是 page。中间那张同时是 `focusedCard` 锚点。 */
export const GRID_CARDS: readonly PonderRelativeRect[] = [
    { left: 0.0785, top: 0.3725, width: 0.155, height: 0.30 },
    { left: 0.2455, top: 0.3725, width: 0.155, height: 0.30 },
    { left: 0.4125, top: 0.355, width: 0.175, height: 0.335 },
    { left: 0.5995, top: 0.3725, width: 0.155, height: 0.30 },
    { left: 0.7665, top: 0.3725, width: 0.155, height: 0.30 },
];

export const GRID_FOCUSED_CARD = 2;

const gridTabs = { left: 0.344, top: 0.069, width: 0.322, height: 0.062 };

export const GRID_GEOMETRY = {
    help: { left: 0.04, top: 0.05, width: 0.22, height: 0.10 },
    tabs: gridTabs,
    /** 切换后亮起来的那一格，跟着 tabs 走，不另写一组坐标。 */
    activeTab: {
        left: gridTabs.left + gridTabs.width * 0.26,
        top: gridTabs.top + gridTabs.height * 0.13,
        width: gridTabs.width * 0.21,
        height: gridTabs.height * 0.74,
    },
    search: { left: 0.748, top: 0.072, width: 0.212, height: 0.056 },
    map: { left: 0.42, top: 0.195, width: 0.16, height: 0.054 },
    sourceActions: { left: 0.79, top: 0.195, width: 0.17, height: 0.054 },
    shelf: { left: 0, right: 0, top: 0.357, height: 0.331 },
    focusedCard: GRID_CARDS[GRID_FOCUSED_CARD],
    focusedCopy: { left: 0.29, top: 0.715, width: 0.42, height: 0.105 },
    command: { left: 0.18, right: 0.18, top: 0.18, height: 0.58 },
} satisfies Record<string, PonderRelativeRect>;

/** 换源之后轨道上摆的那批卡。 */
export const TAB_SWITCH_CARDS: readonly PonderRelativeRect[] = [
    { left: 0.175, top: 0.375, width: 0.145, height: 0.29 },
    { left: 0.345, top: 0.375, width: 0.145, height: 0.29 },
    { left: 0.515, top: 0.375, width: 0.145, height: 0.29 },
    { left: 0.685, top: 0.375, width: 0.145, height: 0.29 },
];

/** GridView 的卡片阵列：六列错行，坐标系是 cards。 */
export const GRID_VIEW_CARD_COLUMNS = 6;
export const GRID_VIEW_CARD_COUNT = 17;
export const GRID_VIEW_FOCUSED_CARD = 8;

/** 按序号算出一张卡在 cards 里的位置。锚点和界面都走它，错行偏移只写一遍。 */
export const gridViewCardRect = (index: number): PonderRelativeRect => {
    const column = index % GRID_VIEW_CARD_COLUMNS;
    const row = Math.floor(index / GRID_VIEW_CARD_COLUMNS);
    return {
        left: column * 0.165 + (row % 2 ? 0.075 : 0),
        top: row * 0.34,
        width: 0.14,
        height: 0.26,
    };
};

export const GRID_VIEW_GEOMETRY = {
    back: { left: 0.03, top: 0.04, width: 0.06, square: true },
    title: { left: 0.33, top: 0.04, width: 0.34, height: 0.10 },
    cards: { left: 0.07, right: 0.07, top: 0.17, bottom: 0.08 },
    /** 相对 cards。 */
    card: gridViewCardRect(GRID_VIEW_FOCUSED_CARD),
    info: { left: 0.04, top: 0.16, bottom: 0.07, width: 0.34 },
    filter: { left: 0.22, right: 0.22, top: 0.08, height: 0.11 },
} satisfies Record<string, PonderRelativeRect>;

/**
 * 底部控制条，坐标系是 bar 本身。
 *
 * 这条在真实界面里会随悬停展开/收起、还会被缩放，量当下的 DOM 得到的经常是一根收起来的
 * 进度条，甚至什么都量不到。所以教程里画的是一条完整尺寸的合成胶囊，几何固定在这里。
 */
export const PLAYER_BAR_GEOMETRY = {
    play: { left: 0.035, top: 0.24, width: 0.065, square: true },
    title: { left: 0.14, top: 0.13, width: 0.58, height: 0.30 },
    progress: { left: 0.14, top: 0.56, width: 0.58, height: 0.28 },
    slots: { left: 0.856, top: 0.30, right: 0.04, height: 0.40 },
    primarySlot: { left: 0.856, top: 0.30, width: 0.046, square: true },
    secondarySlot: { left: 0.914, top: 0.30, width: 0.046, square: true },
} satisfies Record<string, PonderRelativeRect>;
