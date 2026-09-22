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

/**
 * 播放页，坐标系是 page。
 *
 * 真实的播放页是整屏：可视化和歌词铺满，控制条浮在底部中间，侧边手柄贴右缘且和控制条同高。
 * 这里照这个关系摆，位置才讲得出「在哪」。
 */
export const PLAYER_PAGE_GEOMETRY = {
    lyrics: { left: 0.10, right: 0.34, top: 0.16, bottom: 0.30 },
    // 收窄到 60%，和真实那条一样：再宽就会压到右缘手柄背后那条滑轨上。
    bar: { left: 0.20, right: 0.20, bottom: 0.06, height: 0.14 },
    /** 侧边手柄贴右缘，底边和控制条对齐。 */
    toggle: { right: 0.03, bottom: 0.065, width: 0.058, square: true },
    /** 手柄背后向左伸出的滑轨，长度是手柄的两倍。 */
    track: { right: 0.03, bottom: 0.065, width: 0.116, height: 0.125 },
    /** 手柄上方展开的控制面板。 */
    panel: { right: 0.03, bottom: 0.225, width: 0.25, height: 0.60 },
    /** 命令窗口：水平居中，顶在 18vh 上。 */
    palette: { left: 0.19, right: 0.19, top: 0.14, height: 0.46 },
} satisfies Record<string, PonderRelativeRect>;

/**
 * 右侧展开的控制面板，坐标系是面板自身。
 *
 * 真实面板是 `w-80` 加 `p-5`，从上到下只有三段：一张正方形封面、紧挨着的一排标签页、
 * 再下面是当前标签页的内容。封面和标签排之间没有第四段 —— 歌名、歌手、专辑是封面页
 * *里面*的内容，不是面板结构的一层，所以这里不留曲目信息带。
 */
export const SIDE_PANEL_GEOMETRY = {
    cover: { left: 0.06, right: 0.06, top: 0.04, square: true },
    tabs: { left: 0.06, right: 0.06, top: 0.57, height: 0.09 },
    body: { left: 0.06, right: 0.06, top: 0.68, bottom: 0.04 },
} satisfies Record<string, PonderRelativeRect>;

/**
 * 来源那一格里的几块，坐标系是当前标签页内容区（body）。
 *
 * 本地、Navidrome、在线歌词三页共用这一组：三页的骨架是同一个形状 ——
 * 来源信息、音频增益、歌词管理、时间轴偏移，差别只在最上面那块写什么。
 */
export const SIDE_PANEL_SOURCE_PAGE = {
    info: { left: 0, right: 0, top: 0, height: 0.22 },
    gain: { left: 0, right: 0, top: 0.28, height: 0.22 },
    lyrics: { left: 0, right: 0, top: 0.56, height: 0.28 },
    offset: { left: 0, right: 0, top: 0.89, height: 0.11 },
} satisfies Record<string, PonderRelativeRect>;

/**
 * 封面四角那四颗按钮，坐标系是封面自身。
 *
 * 它们平时不在屏幕上：`opacity-0 group-hover:opacity-100`，指针移上封面才浮出来。
 * 四个角各是一个独立动作，所以各自一个锚点 —— 笼统框住整张封面讲不出「右上角那颗
 * 是播放页透明背景」。真实尺寸是 44px 按钮、离边 12px，相对 280px 的封面就是这组数。
 */
export const SIDE_PANEL_COVER_ACTIONS = {
    settings: { left: 0.043, top: 0.043, width: 0.157, square: true },
    transparent: { right: 0.043, top: 0.043, width: 0.157, square: true },
    home: { left: 0.043, bottom: 0.043, width: 0.157, square: true },
    addToPlaylist: { right: 0.043, bottom: 0.043, width: 0.157, square: true },
} satisfies Record<string, PonderRelativeRect>;

/** 标签页的条数，和真实面板常驻的那四页一致。 */
export const SIDE_PANEL_TABS = ['cover', 'controls', 'queue', 'account'] as const;

export type SidePanelTabId = (typeof SIDE_PANEL_TABS)[number];

/**
 * Lattice 里展开海报底部那条播放控制，坐标系是展开的卡片。
 *
 * 四个额外按钮里，两端是上一首/下一首，中间两个就是底栏那两个可配置槽位 —— 这一章的全部重点
 * 在这里，所以它们各自是一个锚点，而不是笼统的一块「按钮区」。
 */
export const LATTICE_CHROME_GEOMETRY = {
    card: { left: 0.06, right: 0.06, top: 0.05, bottom: 0.06 },
    /** 以下都相对 chrome。 */
    play: { left: 0.03, top: 0.12, width: 0.10, square: true },
    prev: { left: 0.20, top: 0.16, width: 0.085, square: true },
    slotPrimary: { left: 0.315, top: 0.16, width: 0.085, square: true },
    slotSecondary: { left: 0.43, top: 0.16, width: 0.085, square: true },
    next: { left: 0.545, top: 0.16, width: 0.085, square: true },
    time: { left: 0.67, top: 0.26, width: 0.16, height: 0.2 },
    openPlayer: { right: 0.03, top: 0.16, width: 0.085, square: true },
    progress: { left: 0.03, right: 0.03, bottom: 0.14, height: 0.12 },
    /** 卡片之外：海报滚出视口时自动出现的那条底栏。相对 page。 */
    bottomBar: { left: 0.22, right: 0.22, bottom: 0.03, height: 0.13 },
    chrome: { left: 0.04, right: 0.04, bottom: 0.06, height: 0.34 },
} satisfies Record<string, PonderRelativeRect>;

/**
 * 海报墙右下角那颗操作按钮，坐标系是 page。
 *
 * 它和播放页那颗侧边手柄是同一个手势（都走 SlideActionButton 或它的同形实现），
 * 所以画法也照那边：按钮贴右下角，背后一条向左的滑轨画成虚线 —— 它在那里，只是没显出来。
 */
export const GRID_ACTION_BUTTON_GEOMETRY = {
    shelf: { left: 0.06, right: 0.06, top: 0.12, bottom: 0.26 },
    button: { right: 0.05, bottom: 0.07, width: 0.07, square: true },
    track: { right: 0.05, bottom: 0.07, width: 0.32, height: 0.135 },
    trackEnd: { right: 0.32, bottom: 0.082, width: 0.055, square: true },
    listPanel: { right: 0.04, top: 0.08, width: 0.30, bottom: 0.06 },
    filterBar: { left: 0.22, right: 0.22, top: 0.06, height: 0.10 },
} satisfies Record<string, PonderRelativeRect>;

/**
 * 集合页那片网格里的卡片，坐标系是 page。
 *
 * 编辑模式和「手动匹配歌曲信息」共用这一张：两件事讲的都是同一张卡上按钮的增减，
 * 各画一份只会让两边的卡长得不一样。
 */
export const GRID_VIEW_CARDS_GEOMETRY = {
    cards: { left: 0.06, right: 0.06, top: 0.16, bottom: 0.16 },
    /** 相对 cards：中间那张。 */
    card: { left: 0.36, top: 0, width: 0.28, height: 1 },
    /** 以下都相对 card。 */
    title: { left: 0.08, right: 0.20, bottom: 0.30, height: 0.07 },
    pencil: { right: 0.06, bottom: 0.295, width: 0.12, square: true },
    actions: { left: 0.12, right: 0.12, bottom: 0.07, height: 0.14 },
    removeBadge: { right: 0.04, top: 0.04, width: 0.14, square: true },
} satisfies Record<string, PonderRelativeRect>;

/**
 * 信息面板底部那一列来源专属动作，坐标系是那一列自身。
 *
 * 最后一颗是删除，红的。它和上面几颗长得一样只差颜色，这正是要单独讲的理由。
 */
export const LOCAL_FOLDER_ACTIONS_GEOMETRY = {
    playAll: { left: 0.04, right: 0.04, top: 0.04, height: 0.15 },
    addQueue: { left: 0.04, right: 0.04, top: 0.22, height: 0.15 },
    reimport: { left: 0.04, right: 0.04, top: 0.40, height: 0.15 },
    organize: { left: 0.04, right: 0.04, top: 0.58, height: 0.15 },
    remove: { left: 0.04, right: 0.04, top: 0.76, height: 0.15 },
} satisfies Record<string, PonderRelativeRect>;

/** 曲目列表侧板，坐标系是那块面板。排序那两颗只在本地文件夹里出现。 */
export const LOCAL_TRACK_LIST_GEOMETRY = {
    header: { left: 0.04, right: 0.04, top: 0.03, height: 0.09 },
    direction: { left: 0.05, top: 0.035, width: 0.085, square: true },
    sortMenu: { right: 0.05, top: 0.035, width: 0.085, square: true },
    rows: { left: 0.04, right: 0.04, top: 0.15, bottom: 0.03 },
    menu: { right: 0.05, top: 0.14, width: 0.52, height: 0.34 },
} satisfies Record<string, PonderRelativeRect>;

/**
 * 设置 · 外观里「首页卡片样式」那一组，坐标系是那块面板。
 *
 * 真实那一组只有三行：分组标题、一行说明、两张并排的选项。它矮，所以面板也要摆得矮 ——
 * 拉成一块方方正正的面会让骨架看起来像另一个更复杂的设置区。
 */
export const GRID3D_CARD_STYLE_GEOMETRY = {
    heading: { left: 0.04, top: 0.04, width: 0.30, height: 0.14 },
    card: { left: 0.03, right: 0.03, top: 0.26, bottom: 0.04 },
    copy: { left: 0.06, right: 0.06, top: 0.34, height: 0.20 },
    optionImage: { left: 0.06, top: 0.62, width: 0.43, height: 0.28 },
    optionCard: { right: 0.06, top: 0.62, width: 0.43, height: 0.28 },
} satisfies Record<string, PonderRelativeRect>;

/**
 * 设置 · 外观里「网格卡片」那一组，坐标系是那块面板。
 *
 * 「正方形卡片」那一行只在「全画幅封面」打开之后才存在，所以它在骨架里也要等一层
 * 结果层才出现 —— 一进场就摆着的话，字幕说「开了才有」就和画面对不上。
 */
export const GRID_VIEW_CARD_GEOMETRY = {
    heading: { left: 0.04, top: 0.02, width: 0.30, height: 0.07 },
    card: { left: 0.03, right: 0.03, top: 0.13, bottom: 0.02 },
    fullBleed: { left: 0.06, right: 0.06, top: 0.17, height: 0.13 },
    square: { left: 0.06, right: 0.06, top: 0.34, height: 0.13 },
    minScale: { left: 0.06, right: 0.06, top: 0.51, height: 0.14 },
    minOpacity: { left: 0.06, right: 0.06, top: 0.68, height: 0.14 },
    reset: { right: 0.06, top: 0.86, width: 0.28, height: 0.09 },
} satisfies Record<string, PonderRelativeRect>;

/**
 * 设置 · 外观里「队列拼贴」那一组，坐标系是那块面板。
 *
 * 叠色是层层嵌套的：开了叠色才有「自定义颜色」和强度，开了自定义颜色才有取色器。
 * 骨架照这个嵌套分两层结果层画，读者才看得出为什么自己那屏上没有取色器。
 */
export const LATTICE_STYLE_GEOMETRY = {
    heading: { left: 0.04, top: 0.02, width: 0.30, height: 0.06 },
    card: { left: 0.03, right: 0.03, top: 0.11, bottom: 0.02 },
    vignette: { left: 0.06, right: 0.06, top: 0.15, height: 0.11 },
    tint: { left: 0.06, right: 0.06, top: 0.30, height: 0.11 },
    customColor: { left: 0.06, right: 0.06, top: 0.45, height: 0.11 },
    picker: { left: 0.06, right: 0.06, top: 0.59, height: 0.20 },
    intensity: { left: 0.06, right: 0.06, top: 0.83, height: 0.11 },
} satisfies Record<string, PonderRelativeRect>;

/**
 * 设置里「歌词动画」那一组，坐标系是那块面板。
 *
 * 真实那一组是：分组标题、一个通往动画调参台的大按钮，再下面**一张**卡片，卡片里
 * 两个开关用一条分隔线隔开。两个开关不是两张卡 —— 画成两张卡就把「它们同属一张卡」
 * 这件事讲错了，高亮也会落在不存在的边框上。
 */
export const LYRICS_ANIMATION_SETTINGS_GEOMETRY = {
    heading: { left: 0.04, top: 0.02, width: 0.30, height: 0.10 },
    entry: { left: 0.04, right: 0.04, top: 0.16, height: 0.27 },
    card: { left: 0.04, right: 0.04, top: 0.48, bottom: 0.03 },
    /** 卡片里上下两行，中间那条分隔线是卡片自己画的。 */
    transparent: { left: 0.07, right: 0.07, top: 0.52, height: 0.20 },
    autoHide: { left: 0.07, right: 0.07, top: 0.76, height: 0.20 },
} satisfies Record<string, PonderRelativeRect>;

/**
 * 设置里「配色主题预设」那一组，坐标系是那块面板。
 *
 * 整组装在一张卡里：标题行右端一颗圆形的 Theme Park 按钮（36px 图标按钮，不是带文字的
 * 大胶囊），两张并排的预设按钮，一块「主题生成来源」子卡，再下面三个开关行。
 * 那三个开关占了这一组一半的高度，漏掉它们的骨架和真实界面对不上。
 */
export const THEME_SETTINGS_GEOMETRY = {
    heading: { left: 0.04, top: 0.01, width: 0.30, height: 0.07 },
    card: { left: 0.03, right: 0.03, top: 0.10, bottom: 0.01 },
    titleRow: { left: 0.06, right: 0.06, top: 0.13, height: 0.08 },
    /** 标题行右端那颗圆按钮。 */
    themePark: { right: 0.06, top: 0.125, width: 0.062, square: true },
    presetDefault: { left: 0.06, top: 0.24, width: 0.43, height: 0.16 },
    presetCustom: { right: 0.06, top: 0.24, width: 0.43, height: 0.16 },
    source: { left: 0.06, right: 0.06, top: 0.43, height: 0.23 },
    followSystem: { left: 0.06, right: 0.06, top: 0.69, height: 0.085 },
    preferCustom: { left: 0.06, right: 0.06, top: 0.79, height: 0.085 },
    autoSwitch: { left: 0.06, right: 0.06, top: 0.89, height: 0.085 },
} satisfies Record<string, PonderRelativeRect>;

/** 上面那三个开关在骨架里从上到下的顺序，以及各自的标记属性。surface 和 target 共用。 */
export const THEME_SETTINGS_TOGGLES = [
    { name: 'followSystem', marker: 'data-ponder-theme-follow-system' },
    { name: 'preferCustom', marker: 'data-ponder-theme-prefer-custom' },
    { name: 'autoSwitch', marker: 'data-ponder-theme-auto-switch' },
] as const;
