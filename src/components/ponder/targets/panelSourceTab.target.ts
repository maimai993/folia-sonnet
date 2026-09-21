import { SIDE_PANEL_SOURCE_ANCHORS, SIDE_PANEL_SOURCE_TAB_CENTER_X, sidePanelTabRelatedIds } from './sidePanelShared';
import type { PonderSceneScript, PonderTargetDefinition } from '../../../types/ponder';

// src/components/ponder/targets/panelSourceTab.target.ts
// 控制面板里跟着来源走的那一格：本地 / Navidrome / 在线歌词。
//
// 三者共用一个目标，因为在真实界面里它们**就是同一格** —— 同一个位置、同一套内容骨架
// （来源信息、音频增益、歌词管理、时间轴偏移），只是当前这首歌来自哪儿决定了显示哪一个。
// 拆成三个目标的话，用户永远只会遇到其中一个，另外两个是死的。
//
// 这一格最不直观的地方是它时有时无：当前这首来自 Stage 或者没有来源信息时，
// 标签排就只有四格，于是「我记得这里有一页」会变成找不到。

const anchors = SIDE_PANEL_SOURCE_ANCHORS;

const pickSourceTab = (id: string) => ([
    { kind: 'cursor' as const, id, to: { anchor: 'tabs', x: SIDE_PANEL_SOURCE_TAB_CENTER_X }, press: 'tap' as const, durationMs: 660, keyframe: true },
    { kind: 'surfaceState' as const, id: `${id}Open`, anchor: 'panel', state: 'source-tab', durationMs: 500 },
]);

/** 第一章：这一格什么时候在，以及它最上面那块。 */
const whenItExists: PonderSceneScript = {
    id: 'panel-source-tab-where',
    titleKey: 'ponder.scenes.panelSourceTabWhere',
    anchors,
    steps: [
        ...pickSourceTab('pickTab'),
        {
            kind: 'caption', id: 'conditional', at: 'bottom',
            textKey: 'ponder.captions.sidePanel.sourceTab',
            pointTo: { anchor: 'tabs', x: SIDE_PANEL_SOURCE_TAB_CENTER_X }, durationMs: 5800, withPrevious: true,
        },
        { kind: 'pause', id: 'readConditional' },

        { kind: 'highlight', id: 'markInfo', anchor: 'sourceInfo', intensity: [0, 0.8], durationMs: 420, keyframe: true },
        {
            kind: 'caption', id: 'info', at: 'bottom',
            textKey: 'ponder.captions.sidePanel.sourceInfo',
            pointTo: { anchor: 'sourceInfo' }, durationMs: 5600, withPrevious: true,
        },
        { kind: 'pause', id: 'readInfo' },
    ],
};

/** 第二章：底下三块 —— 音频增益、歌词从哪来、时间轴偏移。 */
const contents: PonderSceneScript = {
    id: 'panel-source-tab-contents',
    titleKey: 'ponder.scenes.panelSourceTabContents',
    anchors,
    steps: [
        { kind: 'surfaceState', id: 'openTab', anchor: 'panel', state: 'source-tab', durationMs: 420, keyframe: true },
        { kind: 'highlight', id: 'markGain', anchor: 'sourceGain', intensity: [0, 0.85], durationMs: 420, withPrevious: true },
        {
            kind: 'caption', id: 'gain', at: 'bottom',
            textKey: 'ponder.captions.sidePanel.sourceGain',
            pointTo: { anchor: 'sourceGain' }, durationMs: 6000, withPrevious: true,
        },
        { kind: 'pause', id: 'readGain' },

        // 三块挨得近，上一块不熄掉就会连成一片，看不出此刻在讲哪一块。
        { kind: 'highlight', id: 'dimGain', anchor: 'sourceGain', intensity: [0.85, 0], durationMs: 400, keyframe: true },
        { kind: 'highlight', id: 'markLyrics', anchor: 'sourceLyrics', intensity: [0, 0.85], durationMs: 420, withPrevious: true },
        {
            kind: 'caption', id: 'lyrics', at: 'bottom',
            textKey: 'ponder.captions.sidePanel.sourceLyrics',
            pointTo: { anchor: 'sourceLyrics' }, durationMs: 6000, withPrevious: true,
        },
        { kind: 'pause', id: 'readLyrics' },

        { kind: 'highlight', id: 'dimLyrics', anchor: 'sourceLyrics', intensity: [0.85, 0], durationMs: 400, keyframe: true },
        { kind: 'highlight', id: 'markOffset', anchor: 'sourceOffset', intensity: [0, 0.9], durationMs: 420, withPrevious: true },
        {
            kind: 'caption', id: 'offset', at: 'bottom',
            textKey: 'ponder.captions.sidePanel.sourceOffset',
            pointTo: { anchor: 'sourceOffset' }, durationMs: 6000, withPrevious: true,
        },
        { kind: 'pause', id: 'readOffset' },
    ],
};

export default {
    id: 'panel-source-tab',
    titleKey: 'ponder.targets.panelSourceTab',
    // 三种来源占的是同一格，选择器也就写成一组：谁在场就命中谁。
    hoverSelector: '[data-ponder-panel-tab-button="local"], [data-ponder-panel-tab-button="navi"], [data-ponder-panel-tab-button="onlineLyrics"]',
    priority: 1,
    relatedTargetIds: sidePanelTabRelatedIds('panel-source-tab'),
    scenes: [whenItExists, contents],
} satisfies PonderTargetDefinition;
