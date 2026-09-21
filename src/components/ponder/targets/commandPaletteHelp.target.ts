import type { PonderSceneScript, PonderTargetDefinition } from '../../../types/ponder';

// src/components/ponder/targets/commandPaletteHelp.target.ts
// 命令面板输入框右边那个问号按钮：按下去展开全部命令清单（isShowingAllCommands）。
//
// 只教这一个按钮，不教具体某一条命令 —— 问号本身就是「命令有哪些」的答案，
// 逐条去教反而把这件事讲散了。
//
// 这是本批唯一落在模态窗口内部的目标：命令面板自己挂着 data-folia-keyboard-window。
// 悬停到它时 G 的模态屏蔽会放行（usePonderHoldToEnter 里那条例外），并且按 G 的同时
// 会 preventDefault，免得 g 掉进面板的搜索框。

const HELP_ANCHORS = {
    helpButton: {
        kind: 'dom',
        selector: '[data-ponder="command-palette-help"]',
        role: 'control',
        labelKey: 'ponder.anchors.commandPaletteHelp.button',
    },
    panel: {
        kind: 'dom',
        selector: '[data-testid="command-palette-panel"]',
        role: 'surface',
        labelKey: 'ponder.anchors.commandPaletteHelp.panel',
        labelPlacement: 'above',
    },
    body: {
        kind: 'dom',
        selector: '[data-testid="command-palette-body"]',
        role: 'surface',
    },
} satisfies PonderSceneScript['anchors'];

const helpShowsEveryCommand: PonderSceneScript = {
    id: 'command-palette-help-list',
    titleKey: 'ponder.scenes.commandPaletteHelpList',
    anchors: HELP_ANCHORS,
    steps: [
        { kind: 'highlight', id: 'showButton', anchor: 'helpButton', intensity: [0, 1], durationMs: 460 },
        {
            kind: 'caption',
            id: 'intro',
            at: 'bottom',
            textKey: 'ponder.captions.commandPaletteHelp.intro',
            pointTo: { anchor: 'helpButton' },
            durationMs: 3200,
            withPrevious: true,
        },
        { kind: 'pause', id: 'readIntro' },

        { kind: 'cursor', id: 'toButton', to: { anchor: 'helpButton' }, durationMs: 560, ease: 'outCubic' },
        { kind: 'cursor', id: 'press', to: { anchor: 'helpButton' }, press: 'tap', durationMs: 220, keyframe: true },
        { kind: 'highlight', id: 'listFills', anchor: 'body', intensity: [0, 0.7], durationMs: 620 },
        {
            kind: 'caption',
            id: 'list',
            at: 'bottom',
            textKey: 'ponder.captions.commandPaletteHelp.list',
            pointTo: { anchor: 'body' },
            durationMs: 3600,
            withPrevious: true,
        },
        { kind: 'pause', id: 'settle' },
    ],
};

export default {
    id: 'command-palette-help',
    titleKey: 'ponder.targets.commandPaletteHelp',
    hoverSelector: '[data-ponder="command-palette-help"]',
    scenes: [helpShowsEveryCommand],
} satisfies PonderTargetDefinition;
