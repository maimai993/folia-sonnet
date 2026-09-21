import { SIDE_PANEL_GEOMETRY as G } from '../surfaces/ponderSurfaceGeometry';
import type { PonderAnchorSource, PonderRelativeRect, PonderSceneScript, PonderTargetDefinition } from '../../../types/ponder';

// src/components/ponder/targets/sidePanel.target.ts
// 右侧展开的控制面板。
//
// 和 panel-slide 的分工：那个目标讲的是「那颗按钮还能往左滑」，这里讲的是「按钮按开之后
// 这块面板里有什么」。两件事的入口是同一颗按钮，但学的是不同的东西。
//
// 几何来自 ponderSurfaceGeometry，和 PonderSidePanelSurface 画的是同一组数。

const panel = {
    kind: 'synthetic',
    rect: { left: 0.5, top: 0.07, width: 0.22, height: 0.74, anchorX: 'center' },
    role: 'surface',
    surfaceKind: 'side-panel',
    labelKey: 'ponder.anchors.sidePanel.panel',
} satisfies PonderAnchorSource;

const region = (rect: PonderRelativeRect, labelKey: string): PonderAnchorSource => (
    { kind: 'relative', from: 'panel', rect, role: 'region', labelKey }
);

const anchors = {
    panel,
    cover: region(G.cover, 'ponder.anchors.sidePanel.cover'),
    meta: region(G.meta, 'ponder.anchors.sidePanel.meta'),
    tabs: region(G.tabs, 'ponder.anchors.sidePanel.tabs'),
    body: region(G.body, 'ponder.anchors.sidePanel.body'),
} satisfies Record<string, PonderAnchorSource>;

/** 第一章：这块面板是同一个位置的好几副面孔。 */
const structure: PonderSceneScript = {
    id: 'side-panel-structure',
    titleKey: 'ponder.scenes.sidePanelStructure',
    anchors,
    steps: [
        { kind: 'highlight', id: 'markCover', anchor: 'cover', intensity: [0, 0.6], durationMs: 420, keyframe: true },
        {
            kind: 'caption', id: 'cover', at: 'bottom',
            textKey: 'ponder.captions.sidePanel.cover',
            pointTo: { anchor: 'cover' }, durationMs: 4800, withPrevious: true,
        },
        { kind: 'pause', id: 'readCover' },

        { kind: 'highlight', id: 'markTabs', anchor: 'tabs', intensity: [0, 0.85], durationMs: 420, keyframe: true },
        {
            kind: 'caption', id: 'tabs', at: 'bottom',
            textKey: 'ponder.captions.sidePanel.tabs',
            pointTo: { anchor: 'tabs' }, durationMs: 5400, withPrevious: true,
        },
        { kind: 'pause', id: 'readTabs' },
    ],
};

/** 第二章：Tab 键在标签页之间循环，不必去点那一排小格子。 */
const cycleTabs: PonderSceneScript = {
    id: 'side-panel-tabs',
    titleKey: 'ponder.scenes.sidePanelTabs',
    anchors,
    steps: [
        { kind: 'highlight', id: 'markTabs', anchor: 'tabs', intensity: [0, 0.8], durationMs: 420, keyframe: true },
        { kind: 'keypress', id: 'tabKey', keys: ['Tab'], at: { anchor: 'tabs', y: 0, offset: { y: -16 } }, durationMs: 900, withPrevious: true },
        { kind: 'surfaceState', id: 'toControls', anchor: 'panel', state: 'controls-tab', durationMs: 460 },
        {
            kind: 'caption', id: 'cycle', at: 'bottom',
            textKey: 'ponder.captions.sidePanel.cycle',
            pointTo: { anchor: 'tabs' }, durationMs: 5600, withPrevious: true,
        },
        { kind: 'pause', id: 'readCycle' },

        { kind: 'keypress', id: 'shiftTabKey', keys: ['Shift Tab'], at: { anchor: 'tabs', y: 0, offset: { y: -16 } }, durationMs: 1000, keyframe: true },
        { kind: 'surfaceState', id: 'backToCover', anchor: 'panel', state: 'cover-tab', durationMs: 460 },
        {
            kind: 'caption', id: 'reverse', at: 'bottom',
            textKey: 'ponder.captions.sidePanel.cycleReverse',
            pointTo: { anchor: 'tabs' }, durationMs: 5400, withPrevious: true,
        },
        { kind: 'pause', id: 'readReverse' },
    ],
};

/**
 * 每个标签页各自一章。
 *
 * 合成一章讲不完 —— 四页各是一整套设置，挤在一句字幕里只会变成罗列名词。
 * 一页一章，切到那一页再讲那一页，读者手上也正好停在那儿。
 */
const tabScene = (
    id: string,
    titleKey: string,
    state: string,
    tabX: number,
    captionKeys: [string, string],
): PonderSceneScript => ({
    id,
    titleKey,
    anchors,
    steps: [
        { kind: 'cursor', id: 'pickTab', to: { anchor: 'tabs', x: tabX }, press: 'tap', durationMs: 660, keyframe: true },
        { kind: 'surfaceState', id: 'openTab', anchor: 'panel', state, durationMs: 500 },
        {
            kind: 'caption', id: 'what', at: 'bottom',
            textKey: captionKeys[0],
            pointTo: { anchor: 'body' }, durationMs: 5600, withPrevious: true,
        },
        { kind: 'pause', id: 'readWhat' },

        { kind: 'highlight', id: 'markBody', anchor: 'body', intensity: [0, 0.6], durationMs: 420, keyframe: true },
        {
            kind: 'caption', id: 'detail', at: 'bottom',
            textKey: captionKeys[1],
            pointTo: { anchor: 'body', y: 0.8 }, durationMs: 6000, withPrevious: true,
        },
        { kind: 'pause', id: 'readDetail' },
    ],
});

export default {
    id: 'side-panel',
    titleKey: 'ponder.targets.sidePanel',
    hoverSelector: '[data-testid="unified-panel-surface"]',
    relatedTargetIds: ['panel-slide', 'player-bar'],
    scenes: [
        structure,
        cycleTabs,
        // 四格标签排，x 取每一格的中心。
        tabScene('side-panel-cover-tab', 'ponder.scenes.sidePanelCoverTab', 'cover-tab', 0.125,
            ['ponder.captions.sidePanel.coverTab', 'ponder.captions.sidePanel.coverTabDetail']),
        tabScene('side-panel-controls-tab', 'ponder.scenes.sidePanelControlsTab', 'controls-tab', 0.375,
            ['ponder.captions.sidePanel.controlsTab', 'ponder.captions.sidePanel.controlsTabDetail']),
        tabScene('side-panel-queue-tab', 'ponder.scenes.sidePanelQueueTab', 'queue-tab', 0.625,
            ['ponder.captions.sidePanel.queueTab', 'ponder.captions.sidePanel.queueTabDetail']),
        tabScene('side-panel-account-tab', 'ponder.scenes.sidePanelAccountTab', 'account-tab', 0.875,
            ['ponder.captions.sidePanel.accountTab', 'ponder.captions.sidePanel.accountTabDetail']),
    ],
} satisfies PonderTargetDefinition;
