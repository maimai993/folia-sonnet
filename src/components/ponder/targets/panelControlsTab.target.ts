import { sidePanelTabRelatedIds, sidePanelTabScene } from './sidePanelShared';
import type { PonderTargetDefinition } from '../../../types/ponder';

// src/components/ponder/targets/panelControlsTab.target.ts
// 控制面板里的「控制」标签页。
//
// 一页一个目标：指针停在哪一格上，讲的就是那一页。四页各是一整套设置，
// 合成一章只会变成罗列名词，而读者手上正好停在其中一页。

export default {
    id: 'panel-controls-tab',
    titleKey: 'ponder.targets.panelControlsTab',
    hoverSelector: '[data-ponder-panel-tab-button="controls"]',
    priority: 1,
    relatedTargetIds: sidePanelTabRelatedIds('panel-controls-tab'),
    scenes: [
        sidePanelTabScene('panel-controls-tab', 'ponder.scenes.sidePanelControlsTab', 'controls-tab', 1, ['ponder.captions.sidePanel.controlsTab', 'ponder.captions.sidePanel.controlsTabDetail']),
    ],
} satisfies PonderTargetDefinition;
