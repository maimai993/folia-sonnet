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
    rect: { left: 0.5, top: 0.08, width: 0.26, height: 0.66, anchorX: 'center' },
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

/** 第二章：换标签页换的只是下面那块内容。 */
const switchTabs: PonderSceneScript = {
    id: 'side-panel-tabs',
    titleKey: 'ponder.scenes.sidePanelTabs',
    anchors,
    steps: [
        { kind: 'cursor', id: 'pickQueue', to: { anchor: 'tabs', x: 0.5 }, press: 'tap', durationMs: 680, keyframe: true },
        { kind: 'surfaceState', id: 'queueTab', anchor: 'panel', state: 'queue-tab', durationMs: 520 },
        {
            kind: 'caption', id: 'queue', at: 'bottom',
            textKey: 'ponder.captions.sidePanel.queue',
            pointTo: { anchor: 'body' }, durationMs: 5200, withPrevious: true,
        },
        { kind: 'pause', id: 'readQueue' },

        { kind: 'cursor', id: 'pickControls', to: { anchor: 'tabs', x: 0.3 }, press: 'tap', durationMs: 620, keyframe: true },
        { kind: 'surfaceState', id: 'controlsTab', anchor: 'panel', state: 'controls-tab', durationMs: 520 },
        {
            kind: 'caption', id: 'controls', at: 'bottom',
            textKey: 'ponder.captions.sidePanel.controls',
            pointTo: { anchor: 'body' }, durationMs: 5200, withPrevious: true,
        },
        { kind: 'pause', id: 'readControls' },
    ],
};

export default {
    id: 'side-panel',
    titleKey: 'ponder.targets.sidePanel',
    hoverSelector: '[data-testid="unified-panel-surface"]',
    relatedTargetIds: ['panel-slide', 'player-bar'],
    scenes: [structure, switchTabs],
} satisfies PonderTargetDefinition;
