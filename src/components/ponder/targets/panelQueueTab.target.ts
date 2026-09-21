import { sidePanelTabRelatedIds, sidePanelTabScene } from './sidePanelShared';
import type { PonderTargetDefinition } from '../../../types/ponder';

// src/components/ponder/targets/panelQueueTab.target.ts
// 控制面板里的「队列」标签页。
//
// 一页一个目标：指针停在哪一格上，讲的就是那一页。四页各是一整套设置，
// 合成一章只会变成罗列名词，而读者手上正好停在其中一页。

export default {
    id: 'panel-queue-tab',
    titleKey: 'ponder.targets.panelQueueTab',
    hoverSelector: '[data-ponder-panel-tab-button="queue"]',
    priority: 1,
    relatedTargetIds: sidePanelTabRelatedIds('panel-queue-tab'),
    scenes: [
        sidePanelTabScene('panel-queue-tab', 'ponder.scenes.sidePanelQueueTab', 'queue-tab', 2, ['ponder.captions.sidePanel.queueTab', 'ponder.captions.sidePanel.queueTabDetail']),
    ],
} satisfies PonderTargetDefinition;
