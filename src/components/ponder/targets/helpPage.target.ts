import { PONDER_ONBOARDING_GEOMETRY as O } from '../surfaces/ponderSurfaceGeometry';
import type { PonderAnchorSource, PonderRelativeRect, PonderSceneScript, PonderSurfaceKind, PonderTargetDefinition } from '../../../types/ponder';

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

/** 示意图上的一块，只提供几何和落点 —— 图本身已经画出来了。 */
const onIllustration = (rect: PonderRelativeRect, labelKey: string): PonderAnchorSource => (
    { kind: 'relative', from: 'page', rect, role: 'region', labelKey }
);

const illustration: Record<string, PonderAnchorSource> = {
    ...surface('ponder.anchors.onboarding.page', 'ponder-onboarding'),
    component: onIllustration(O.cardC, 'ponder.anchors.onboarding.component'),
    capsule: onIllustration(O.capsule, 'ponder.anchors.onboarding.capsule'),
    touchBulb: onIllustration(O.touchBulb, 'ponder.anchors.onboarding.touchBulb'),
};

/**
 * 第一章：你已经在思索里了，以及怎么再打开下一个。
 *
 * 放在最前面是因为读到这一屏的人刚刚第一次进来 —— 先把「刚才发生了什么、下次怎么再来」
 * 说清楚，后面几章才有人看得到。
 *
 * 这一章用的是示意图而不是某个真实页面的轮廓：它讲的是一套机制，而机制没有「所在页面」。
 * 光标移到图里那个组件上 → 胶囊浮出来 → 擦除铺满 → 教程接管整屏，四步就是全过程。
 */
const insidePonder: PonderSceneScript = {
    id: 'help-page-ponder',
    titleKey: 'ponder.scenes.helpPagePonder',
    anchors: illustration,
    steps: [
        { kind: 'highlight', id: 'showPage', anchor: 'page', intensity: [0, 0.35], durationMs: 520, keyframe: true },
        {
            kind: 'caption', id: 'here', at: 'bottom',
            textKey: 'ponder.captions.onboarding.here',
            pointTo: { anchor: 'page', y: 0.12 }, durationMs: 5200, withPrevious: true,
        },
        { kind: 'pause', id: 'readHere' },

        { kind: 'highlight', id: 'dimPage', anchor: 'page', intensity: [0.35, 0], durationMs: 400, keyframe: true },
        { kind: 'cursor', id: 'hoverComponent', to: { anchor: 'component' }, durationMs: 760, withPrevious: true },
        { kind: 'surfaceState', id: 'showHint', anchor: 'page', state: 'hint-shown', durationMs: 420 },
        {
            kind: 'caption', id: 'hover', at: 'bottom',
            textKey: 'ponder.captions.onboarding.hover',
            pointTo: { anchor: 'capsule' }, durationMs: 6000, withPrevious: true,
        },
        { kind: 'pause', id: 'readHover' },

        { kind: 'keypress', id: 'holdG', keys: ['G'], at: { anchor: 'capsule', y: 1, offset: { y: 20 } }, durationMs: 1000, keyframe: true },
        { kind: 'surfaceState', id: 'holding', anchor: 'page', state: 'hint-holding', durationMs: 420, withPrevious: true },
        { kind: 'surfaceState', id: 'opened', anchor: 'page', state: 'ponder-open', transition: 'zoom', durationMs: 560 },
        {
            kind: 'caption', id: 'hold', at: 'bottom',
            textKey: 'ponder.captions.onboarding.hold',
            pointTo: { anchor: 'page', y: 0.5 }, durationMs: 5800, withPrevious: true,
        },
        { kind: 'pause', id: 'readHold' },
    ],
};

/**
 * 第二章：整页的教程，以及触屏上那颗灯泡。
 *
 * 灯泡单独说，因为它只在触屏上存在 —— 桌面上照着找是找不到的，而上一版的文案
 * 把这件事写成了一句附带，读的人只会以为自己没看见。
 */
const wholePage: PonderSceneScript = {
    id: 'help-page-whole-page',
    titleKey: 'ponder.scenes.helpPageWholePage',
    anchors: illustration,
    steps: [
        // 这一章不切到 ponder-open：整屏接管的样子上一章末尾刚演过，再演一遍没有新东西，
        // 而它是整屏替换 —— 切过去之后右下角那颗灯泡就不在画面上了，第二段没法指。
        { kind: 'keypress', id: 'ctrlG', keys: ['Ctrl G'], at: { anchor: 'page', y: 1, offset: { y: 20 } }, durationMs: 1100, keyframe: true },
        { kind: 'highlight', id: 'markPage', anchor: 'page', intensity: [0, 0.35], durationMs: 460, withPrevious: true },
        {
            kind: 'caption', id: 'wholePage', at: 'bottom',
            textKey: 'ponder.captions.onboarding.wholePage',
            pointTo: { anchor: 'page', y: 0.5 }, durationMs: 5800, withPrevious: true,
        },
        { kind: 'pause', id: 'readWholePage' },

        { kind: 'highlight', id: 'dimPage', anchor: 'page', intensity: [0.35, 0], durationMs: 400, keyframe: true },
        { kind: 'highlight', id: 'markBulb', anchor: 'touchBulb', intensity: [0, 0.9], durationMs: 440, withPrevious: true },
        {
            kind: 'caption', id: 'touch', at: 'bottom',
            textKey: 'ponder.captions.onboarding.touchBulb',
            pointTo: { anchor: 'touchBulb' }, durationMs: 6200, withPrevious: true,
        },
        { kind: 'pause', id: 'readTouch' },
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
    anchors: surface('ponder.anchors.onboarding.page', 'ponder-onboarding'),
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
    scenes: [insidePonder, wholePage, transportControl, shortcuts, moreDocs, hintSettings],
} satisfies PonderTargetDefinition;
