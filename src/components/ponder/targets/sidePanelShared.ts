import {
    SIDE_PANEL_COVER_ACTIONS as A,
    SIDE_PANEL_GEOMETRY as G,
} from '../surfaces/ponderSurfaceGeometry';
import type { PonderAnchorSource, PonderRelativeRect, PonderSceneScript, PonderTargetId } from '../../../types/ponder';

// src/components/ponder/targets/sidePanelShared.ts
// 右侧控制面板那一族目标共用的锚点和场景形状。
//
// 文件名刻意不是 *.target.ts：注册表用 import.meta.glob('./targets/*.target.ts') 收目标，
// 共用件混进去会被当成一个缺 default export 的目标而直接抛错。
//
// 为什么是一族而不是一个目标：面板里真正需要解释的东西彼此没有关系 —— 封面四角那四颗
// 按钮是四个不相干的动作，四个标签页各是一整套设置。全部塞进一个目标，用户悬停在队列
// 标签上得到的是从封面讲起的六章；拆开之后，指哪儿讲哪儿。

/** 面板本身。几何和 PonderSidePanelSurface 画的那块是同一组数。 */
export const sidePanelAnchor = {
    kind: 'synthetic',
    rect: { left: 0.5, top: 0.10, width: 0.22, height: 0.62, anchorX: 'center' },
    role: 'surface',
    surfaceKind: 'side-panel',
    labelKey: 'ponder.anchors.sidePanel.panel',
} satisfies PonderAnchorSource;

const region = (from: string, rect: PonderRelativeRect, labelKey: string): PonderAnchorSource => (
    { kind: 'relative', from, rect, role: 'region', labelKey }
);

/** 面板结构：封面、标签排、当前标签页内容。 */
export const SIDE_PANEL_ANCHORS = {
    panel: sidePanelAnchor,
    cover: region('panel', G.cover, 'ponder.anchors.sidePanel.cover'),
    tabs: region('panel', G.tabs, 'ponder.anchors.sidePanel.tabs'),
    body: region('panel', G.body, 'ponder.anchors.sidePanel.body'),
} satisfies Record<string, PonderAnchorSource>;

/** 结构锚点加封面四个角。四颗按钮各自一个锚点，才指得到「右上角那颗」。 */
export const SIDE_PANEL_COVER_ANCHORS = {
    ...SIDE_PANEL_ANCHORS,
    coverSettings: region('cover', A.settings, 'ponder.anchors.sidePanel.coverSettings'),
    coverTransparent: region('cover', A.transparent, 'ponder.anchors.sidePanel.coverTransparent'),
    coverHome: region('cover', A.home, 'ponder.anchors.sidePanel.coverHome'),
    coverPlaylist: region('cover', A.addToPlaylist, 'ponder.anchors.sidePanel.coverPlaylist'),
} satisfies Record<string, PonderAnchorSource>;

/** 四格标签排里每一格的中心，按顺序：封面、控制、队列、账号。 */
export const SIDE_PANEL_TAB_CENTER_X = [0.125, 0.375, 0.625, 0.875] as const;

/**
 * 一个标签页的教程：点到那一格、换过去，然后讲这一页是什么、里面有什么。
 *
 * 每个标签页各自一个目标，所以这里只产出一章 —— 用户是悬停在那一格上问「这页是什么」，
 * 不是来看四页连播的。
 */
export const sidePanelTabScene = (
    id: string,
    titleKey: string,
    state: string,
    tabIndex: number,
    captionKeys: readonly [string, string],
): PonderSceneScript => ({
    id,
    titleKey,
    anchors: SIDE_PANEL_ANCHORS,
    steps: [
        { kind: 'cursor', id: 'pickTab', to: { anchor: 'tabs', x: SIDE_PANEL_TAB_CENTER_X[tabIndex] }, press: 'tap', durationMs: 660, keyframe: true },
        { kind: 'surfaceState', id: 'openTab', anchor: 'panel', state, durationMs: 500 },
        {
            kind: 'caption', id: 'what', at: 'bottom',
            textKey: captionKeys[0],
            pointTo: { anchor: 'tabs', x: SIDE_PANEL_TAB_CENTER_X[tabIndex] }, durationMs: 5200, withPrevious: true,
        },
        { kind: 'pause', id: 'readWhat' },

        { kind: 'highlight', id: 'markBody', anchor: 'body', intensity: [0, 0.55], durationMs: 420, keyframe: true },
        {
            kind: 'caption', id: 'detail', at: 'bottom',
            textKey: captionKeys[1],
            pointTo: { anchor: 'body', y: 0.5 }, durationMs: 6200, withPrevious: true,
        },
        { kind: 'pause', id: 'readDetail' },
    ],
});

/** 每个标签页目标都指回整块面板和相邻的那几页。 */
export const sidePanelTabRelatedIds = (self: PonderTargetId): PonderTargetId[] => (
    ([
        'side-panel',
        'panel-cover-tab',
        'panel-controls-tab',
        'panel-queue-tab',
        'panel-account-tab',
    ] as PonderTargetId[]).filter(id => id !== self)
);
