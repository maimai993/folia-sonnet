import type { PonderAnchorSource, PonderSceneScript, PonderSurfaceKind, PonderTargetDefinition } from '../../../types/ponder';

// src/components/ponder/targets/helpPage.target.ts
// Folia 的入门教程 —— 第一次打开应用时那道门指向的就是它，帮助页上那颗灯泡按钮也直接开它。
//
// 这不是「帮助页上有什么」的说明。帮助页本身没什么可讲的，真正要交代的是整个应用怎么用：
// 思索自己怎么用、播放控制在哪、四个常用快捷键分别做什么、讲不完的去哪查。
// 四章按「你现在在哪 → 不用回到应用也能控制播放 → 回到应用之后怎么快 → 还想知道更多」排。

/** 文档站。写死在这里而不是配置：它是这一章唯一的出口，配置化只会多一层找不到的间接。 */
const FOLIA_DOCS_URL = 'https://folia-site.cielaniska.top/guide/';

/** startsHidden 给那些「按了键才出现」的面：一进场就摆着的话，字幕在讲一件已经发生的事。 */
const surface = (labelKey: string, surfaceKind: PonderSurfaceKind, startsHidden = false): Record<string, PonderAnchorSource> => ({
    page: {
        kind: 'synthetic',
        rect: { left: 0.5, top: 0.15, width: 0.56, height: 0.5, anchorX: 'center' },
        role: 'surface',
        surfaceKind,
        labelKey,
        startsHidden,
    },
});

/**
 * 第一章：你已经在思索里了，以及怎么再打开下一个。
 *
 * 放在最前面是因为读到这一屏的人刚刚第一次进来 —— 先把「刚才发生了什么、下次怎么再来」
 * 说清楚，后面三章才有人看得到。
 */
const insidePonder: PonderSceneScript = {
    id: 'help-page-ponder',
    titleKey: 'ponder.scenes.helpPagePonder',
    anchors: surface('ponder.anchors.pages.help', 'help-page'),
    steps: [
        { kind: 'highlight', id: 'showPage', anchor: 'page', intensity: [0, 0.4], durationMs: 520, keyframe: true },
        {
            kind: 'caption', id: 'here', at: 'bottom',
            textKey: 'ponder.captions.onboarding.here',
            pointTo: { anchor: 'page', y: 0.2 }, durationMs: 5200, withPrevious: true,
        },
        { kind: 'pause', id: 'readHere' },

        { kind: 'keypress', id: 'holdG', keys: ['G'], at: { anchor: 'page', y: 1, offset: { y: 18 } }, durationMs: 1000, keyframe: true },
        {
            kind: 'caption', id: 'hover', at: 'bottom',
            textKey: 'ponder.captions.onboarding.hover',
            pointTo: { anchor: 'page', y: 0.5 }, durationMs: 6000, withPrevious: true,
        },
        { kind: 'pause', id: 'readHover' },

        { kind: 'keypress', id: 'ctrlG', keys: ['Ctrl G'], at: { anchor: 'page', y: 1, offset: { y: 18 } }, durationMs: 1100, keyframe: true },
        {
            kind: 'caption', id: 'wholePage', at: 'bottom',
            textKey: 'ponder.captions.onboarding.wholePage',
            pointTo: { anchor: 'page', y: 0.8 }, durationMs: 5600, withPrevious: true,
        },
        { kind: 'pause', id: 'readWholePage' },
    ],
};

/**
 * 第二章：不用切回应用也能控制播放。
 *
 * 这一条对后台听歌的人价值最大，而且是最容易完全不知道的一条 —— 没人会主动去试
 * 键盘上那几颗媒体键在一个网页播放器上管不管用。
 */
const transportControl: PonderSceneScript = {
    id: 'help-page-transport',
    titleKey: 'ponder.scenes.helpPageTransport',
    anchors: surface('ponder.anchors.pages.player', 'player-page'),
    steps: [
        { kind: 'highlight', id: 'showPlayer', anchor: 'page', intensity: [0, 0.4], durationMs: 520, keyframe: true },
        {
            kind: 'caption', id: 'mediaKeys', at: 'bottom',
            textKey: 'ponder.captions.onboarding.mediaKeys',
            pointTo: { anchor: 'page', y: 0.85 }, durationMs: 6400, withPrevious: true,
        },
        { kind: 'pause', id: 'readMediaKeys' },

        { kind: 'keypress', id: 'inAppKeys', keys: ['Mod ←', 'Space', 'Mod →'], at: { anchor: 'page', y: 1, offset: { y: 18 } }, durationMs: 1500, keyframe: true },
        {
            kind: 'caption', id: 'inApp', at: 'bottom',
            textKey: 'ponder.captions.onboarding.inAppTransport',
            pointTo: { anchor: 'page', y: 0.85 }, durationMs: 6200, withPrevious: true,
        },
        { kind: 'pause', id: 'readInApp' },
    ],
};

/** 第三章：四个 Ctrl 组合，一个一句。 */
const shortcuts: PonderSceneScript = {
    id: 'help-page-shortcuts',
    titleKey: 'ponder.scenes.helpPageShortcuts',
    anchors: surface('ponder.anchors.pages.commandPalette', 'palette', true),
    steps: [
        { kind: 'keypress', id: 'modK', keys: ['Mod K'], at: 'bottom', durationMs: 1000, keyframe: true },
        { kind: 'reveal', id: 'showPalette', anchor: 'page', transition: 'zoom', durationMs: 520 },
        {
            kind: 'caption', id: 'paletteKey', at: 'bottom',
            textKey: 'ponder.captions.onboarding.shortcutK',
            pointTo: { anchor: 'page', y: 0.2 }, durationMs: 5400, withPrevious: true,
        },
        { kind: 'pause', id: 'readK' },

        { kind: 'keypress', id: 'modP', keys: ['Mod P'], at: { anchor: 'page', y: 1, offset: { y: 18 } }, durationMs: 1000, keyframe: true },
        {
            kind: 'caption', id: 'queueKey', at: 'bottom',
            textKey: 'ponder.captions.onboarding.shortcutP',
            pointTo: { anchor: 'page', y: 0.5 }, durationMs: 5400, withPrevious: true,
        },
        { kind: 'pause', id: 'readP' },

        { kind: 'keypress', id: 'modB', keys: ['Mod B'], at: { anchor: 'page', y: 1, offset: { y: 18 } }, durationMs: 1000, keyframe: true },
        {
            kind: 'caption', id: 'latticeKey', at: 'bottom',
            textKey: 'ponder.captions.onboarding.shortcutB',
            pointTo: { anchor: 'page', y: 0.5 }, durationMs: 5400, withPrevious: true,
        },
        { kind: 'pause', id: 'readB' },

        { kind: 'keypress', id: 'modG', keys: ['Ctrl G'], at: { anchor: 'page', y: 1, offset: { y: 18 } }, durationMs: 1000, keyframe: true },
        {
            kind: 'caption', id: 'ponderKey', at: 'bottom',
            textKey: 'ponder.captions.onboarding.shortcutG',
            pointTo: { anchor: 'page', y: 0.8 }, durationMs: 5400, withPrevious: true,
        },
        { kind: 'pause', id: 'readG' },
    ],
};

/** 第四章：讲不完的去文档。带一颗直接打开文档站的按钮。 */
const moreDocs: PonderSceneScript = {
    id: 'help-page-docs',
    titleKey: 'ponder.scenes.helpPageDocs',
    action: {
        kind: 'openUrl',
        url: FOLIA_DOCS_URL,
        labelKey: 'ponder.actions.openDocs',
    },
    anchors: surface('ponder.anchors.pages.help', 'help-page'),
    steps: [
        { kind: 'highlight', id: 'showHelp', anchor: 'page', intensity: [0, 0.4], durationMs: 520, keyframe: true },
        {
            kind: 'caption', id: 'docs', at: 'bottom',
            textKey: 'ponder.captions.onboarding.docs',
            pointTo: { anchor: 'page', y: 0.5 }, durationMs: 6400, withPrevious: true,
        },
        { kind: 'pause', id: 'readDocs' },
    ],
};

/**
 * 第五章：看够了就把提示关掉。
 *
 * 放在最后而不是不放：悬停提示对新用户是帮助，对已经熟了的人是噪声，而「它能关」
 * 这件事本身也只有在教程里说才找得到 —— 那个开关在设置的实验室分组里。
 */
const hintSettings: PonderSceneScript = {
    id: 'help-page-hint-settings',
    titleKey: 'ponder.scenes.helpPageHintSettings',
    action: {
        kind: 'openSettings',
        anchorId: 'labPonder',
        labelKey: 'ponder.actions.openPonderHints',
    },
    anchors: surface('ponder.anchors.pages.settings', 'settings-page'),
    steps: [
        { kind: 'highlight', id: 'showSettings', anchor: 'page', intensity: [0, 0.4], durationMs: 520, keyframe: true },
        {
            kind: 'caption', id: 'hints', at: 'bottom',
            textKey: 'ponder.captions.onboarding.hintSettings',
            pointTo: { anchor: 'page', y: 0.5 }, durationMs: 6600, withPrevious: true,
        },
        { kind: 'pause', id: 'readHints' },
    ],
};

export default {
    id: 'help-page',
    titleKey: 'ponder.targets.helpPage',
    hoverSelector: null,
    scenes: [insidePonder, transportControl, shortcuts, moreDocs, hintSettings],
} satisfies PonderTargetDefinition;
