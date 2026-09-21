import { usePlayerBottomBarLayoutStore } from '../../../stores/usePlayerBottomBarLayoutStore';
import { usePlayerChromeSettingsStore } from '../../../stores/usePlayerChromeSettingsStore';
import type { PonderSceneScript, PonderTargetDefinition } from '../../../types/ponder';

// src/components/ponder/targets/playerBar.target.ts
// 底部控制条整条，作为一个目标。
//
// 按组件而不是按按钮划分：用户是对着这条胶囊大致比划着按 G 的，指望他先精确命中
// 右边某个 20px 的槽位按钮再按，等于这些教程没人看得到。
//
// 收进来的都是 tooltip 讲不了的东西 —— 每个槽位按钮本身都带 title，
// 「这个按钮叫随机」不需要再教一遍；「随机其实只洗一次牌」才需要。

/** 某个槽位此刻放着哪个动作。 */
const hasSlot = (actionId: string) => {
    const chrome = usePlayerChromeSettingsStore.getState();
    return chrome.playerControlSlotPrimary === actionId || chrome.playerControlSlotSecondary === actionId;
};

// 只有真实 DOM 的锚点才共用：它们本来就同时在屏幕上。
// 合成锚点必须按章节各自声明 —— 骨架层会把解析得出的每个锚点都画出来，
// 共用一份的话「命令面板」「设置选择器」「播放队列」「音量面板」会在每一章里
// 全部画出来，在屏幕中央叠成一团。
const REAL_ANCHORS = {
    bar: {
        kind: 'dom',
        selector: '[data-ponder="player-bar"]',
        role: 'rail',
        labelKey: 'ponder.anchors.playerBar.bar',
        labelPlacement: 'above',
    },
    slots: {
        kind: 'dom',
        selector: '[data-ponder-slots]',
        role: 'rail',
        labelKey: 'ponder.anchors.playerBar.slots',
        labelPlacement: 'below',
    },
    primarySlot: {
        kind: 'dom',
        selector: '[data-ponder-slots] > button:nth-of-type(1)',
        role: 'control',
    },
    secondarySlot: {
        kind: 'dom',
        selector: '[data-ponder-slots] > button:nth-of-type(2)',
        role: 'control',
    },
    // 这两个不标名字：它们和「两个槽位」挤在同一小块地方，三个标签必然叠字。
    // 是哪个按钮，由指着它的那句字幕讲。
    shuffleSlot: {
        kind: 'dom',
        selector: '[data-ponder-slot="shuffle"]',
        role: 'control',
    },
    volumeSlot: {
        kind: 'dom',
        selector: '[data-ponder-slot="volume"]',
        role: 'control',
    },
} satisfies PonderSceneScript['anchors'];

/** 一块居中的合成面板，四章各自取自己那一块。 */
const centeredSurface = (labelKey: string, width: number, height: number, top: number) => ({
    kind: 'synthetic' as const,
    rect: { left: 0.5, top, width, height, anchorX: 'center' as const },
    role: 'surface' as const,
    labelKey,
});

/** 第一章：整条可以拖着改高度，但要先进定位模式。 */
const adjustHeight: PonderSceneScript = {
    id: 'player-bar-height',
    titleKey: 'ponder.scenes.playerBarHeight',
    action: {
        kind: 'openSettings',
        anchorId: 'bottomUiSettings',
        labelKey: 'ponder.actions.openBottomUiSettings',
    },
    anchors: {
        ...REAL_ANCHORS,
        /** 抬高之后它会在的位置，由当前位置向上推导。 */
        raised: {
            kind: 'derived',
            from: 'bar',
            at: { anchor: 'bar', x: 0.5, y: 0.5, offset: { y: -140 } },
            size: { width: 360, height: 56 },
            role: 'rail',
        },
        palette: centeredSurface('ponder.anchors.playerBar.palette', 0.44, 0.28, 0.18),
    },
    steps: [
        { kind: 'highlight', id: 'showBar', anchor: 'bar', intensity: [0, 0.6], durationMs: 460 },
        {
            kind: 'caption',
            id: 'intro',
            at: 'bottom',
            textKey: 'ponder.captions.playerBar.heightIntro',
            pointTo: { anchor: 'bar' },
            durationMs: 3400,
            withPrevious: true,
        },
        { kind: 'pause', id: 'readIntro' },

        { kind: 'keypress', id: 'openPalette', keys: ['S'], at: 'bottom', durationMs: 1200, keyframe: true },
        { kind: 'highlight', id: 'paletteOpens', anchor: 'palette', intensity: [0, 0.8], durationMs: 460 },
        {
            kind: 'caption',
            id: 'command',
            at: 'bottom',
            textKey: 'ponder.captions.playerBar.heightCommand',
            pointTo: { anchor: 'palette', y: 1 },
            durationMs: 3800,
            withPrevious: true,
        },
        { kind: 'pause', id: 'readCommand' },

        { kind: 'cursor', id: 'grab', to: { anchor: 'bar' }, press: 'down', durationMs: 420, keyframe: true },
        { kind: 'drag', id: 'lift', from: { anchor: 'bar' }, to: { anchor: 'raised' }, durationMs: 900, ease: 'outCubic' },
        { kind: 'highlight', id: 'ghost', anchor: 'raised', intensity: [0, 0.7], durationMs: 900, withPrevious: true },
        {
            kind: 'caption',
            id: 'drag',
            at: 'bottom',
            textKey: 'ponder.captions.playerBar.heightDrag',
            pointTo: { anchor: 'raised' },
            durationMs: 3600,
            withPrevious: true,
        },
        { kind: 'pause', id: 'settle' },
    ],
};

/** 第二章：右边那两个位置的按钮可以换。 */
const swappableSlots: PonderSceneScript = {
    id: 'player-bar-slots',
    titleKey: 'ponder.scenes.playerBarSlots',
    action: {
        kind: 'openSettings',
        anchorId: 'bottomUiSettings',
        labelKey: 'ponder.actions.openSlotPicker',
    },
    anchors: {
        ...REAL_ANCHORS,
        picker: centeredSurface('ponder.anchors.playerBar.picker', 0.3, 0.34, 0.24),
    },
    steps: [
        { kind: 'highlight', id: 'showSlots', anchor: 'slots', intensity: [0, 0.6], durationMs: 460 },
        { kind: 'highlight', id: 'markPrimary', anchor: 'primarySlot', intensity: [0, 1], durationMs: 460, withPrevious: true },
        { kind: 'highlight', id: 'markSecondary', anchor: 'secondarySlot', intensity: [0, 1], durationMs: 460, withPrevious: true },
        {
            kind: 'caption',
            id: 'intro',
            at: 'bottom',
            textKey: 'ponder.captions.playerBar.slotsIntro',
            pointTo: { anchor: 'slots' },
            durationMs: 3400,
            withPrevious: true,
        },
        { kind: 'pause', id: 'readIntro' },

        { kind: 'highlight', id: 'openPicker', anchor: 'picker', intensity: [0, 0.8], durationMs: 460, keyframe: true },
        {
            kind: 'caption',
            id: 'where',
            at: 'bottom',
            textKey: 'ponder.captions.playerBar.slotsWhere',
            pointTo: { anchor: 'picker', y: 1 },
            durationMs: 3800,
            withPrevious: true,
        },
        { kind: 'pause', id: 'settle' },
    ],
};

/** 第三章：随机不是一个模式。只有槽位里真放着随机时才讲。 */
const shuffleIsOneShot: PonderSceneScript = {
    id: 'player-bar-shuffle',
    titleKey: 'ponder.scenes.playerBarShuffle',
    anchors: {
        ...REAL_ANCHORS,
        queue: centeredSurface('ponder.anchors.playerBar.queue', 0.34, 0.4, 0.2),
    },
    isAvailable: () => hasSlot('shuffle'),
    steps: [
        { kind: 'highlight', id: 'showQueue', anchor: 'queue', intensity: [0, 0.5], durationMs: 460 },
        {
            kind: 'caption',
            id: 'intro',
            at: 'bottom',
            textKey: 'ponder.captions.playerBar.shuffleIntro',
            pointTo: { anchor: 'shuffleSlot' },
            durationMs: 3400,
            withPrevious: true,
        },
        { kind: 'pause', id: 'readIntro' },

        { kind: 'cursor', id: 'press', to: { anchor: 'shuffleSlot' }, press: 'tap', durationMs: 520, keyframe: true },
        { kind: 'highlight', id: 'queueShuffles', anchor: 'queue', intensity: [0.5, 1], durationMs: 700 },
        {
            kind: 'caption',
            id: 'once',
            at: 'bottom',
            textKey: 'ponder.captions.playerBar.shuffleOnce',
            pointTo: { anchor: 'queue' },
            durationMs: 3800,
            withPrevious: true,
        },
        { kind: 'pause', id: 'settle' },
    ],
};

/** 第四章：没有常驻音量条。只有槽位里真放着音量时才讲。 */
const volumeInPalette: PonderSceneScript = {
    id: 'player-bar-volume',
    titleKey: 'ponder.scenes.playerBarVolume',
    anchors: {
        ...REAL_ANCHORS,
        volumeSurface: centeredSurface('ponder.anchors.playerBar.volumeSurface', 0.4, 0.24, 0.24),
    },
    isAvailable: () => hasSlot('volume'),
    steps: [
        {
            kind: 'caption',
            id: 'intro',
            at: 'bottom',
            textKey: 'ponder.captions.playerBar.volumeIntro',
            pointTo: { anchor: 'volumeSlot' },
            durationMs: 3400,
        },
        { kind: 'pause', id: 'readIntro' },

        { kind: 'cursor', id: 'press', to: { anchor: 'volumeSlot' }, press: 'tap', durationMs: 520, keyframe: true },
        { kind: 'highlight', id: 'surfaceOpens', anchor: 'volumeSurface', intensity: [0, 0.8], durationMs: 520 },
        {
            kind: 'caption',
            id: 'opens',
            at: 'bottom',
            textKey: 'ponder.captions.playerBar.volumeOpens',
            pointTo: { anchor: 'volumeSurface', y: 1 },
            durationMs: 3800,
            withPrevious: true,
        },
        { kind: 'pause', id: 'settle' },
    ],
};

export default {
    id: 'player-bar',
    titleKey: 'ponder.targets.playerBar',
    hoverSelector: '[data-ponder="player-bar"]',
    // 已经在定位模式里了就不必教了，那时整条胶囊本来就是个被拖的物体。
    isAvailable: () => !usePlayerBottomBarLayoutStore.getState().isPositioning,
    scenes: [adjustHeight, swappableSlots, shuffleIsOneShot, volumeInPalette],
} satisfies PonderTargetDefinition;
