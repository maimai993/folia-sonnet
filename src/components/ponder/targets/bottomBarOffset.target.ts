import { usePlayerBottomBarLayoutStore } from '../../../stores/usePlayerBottomBarLayoutStore';
import type { PonderSceneScript, PonderTargetDefinition } from '../../../types/ponder';

// src/components/ponder/targets/bottomBarOffset.target.ts
// 底部控制条的高度可以自己调。
//
// 它之所以值得单独教：拖动只在「定位模式」下生效，而定位模式要先从设置或命令面板进入
// （usePlayerBottomBarLayoutStore.requestPositioning）。平时直接按住这条胶囊拖，什么都不会发生 ——
// 没人会猜到还有一道开关。两章正好对应这两步。

const BAR_ANCHORS = {
    bar: {
        kind: 'dom',
        selector: '[data-ponder="bottom-bar-offset"]',
        role: 'rail',
        labelKey: 'ponder.anchors.bottomBarOffset.bar',
        labelPlacement: 'above',
    },
    /** 抬高之后它会在的位置，由当前位置向上推导。 */
    raised: {
        kind: 'derived',
        from: 'bar',
        at: { anchor: 'bar', x: 0.5, y: 0.5, offset: { y: -140 } },
        size: { width: 360, height: 56 },
        role: 'rail',
    },
    /** 命令面板此刻不在场，按视口比例合成。 */
    palette: {
        kind: 'synthetic',
        rect: { left: 0.5, top: 0.18, width: 0.44, height: 0.3, anchorX: 'center' },
        role: 'surface',
        labelKey: 'ponder.anchors.bottomBarOffset.palette',
    },
} satisfies PonderSceneScript['anchors'];

const enterPositioning: PonderSceneScript = {
    id: 'bottom-bar-enter-positioning',
    titleKey: 'ponder.scenes.bottomBarEnterPositioning',
    anchors: BAR_ANCHORS,
    steps: [
        { kind: 'highlight', id: 'showBar', anchor: 'bar', intensity: [0, 0.6], durationMs: 460 },
        {
            kind: 'caption',
            id: 'intro',
            at: 'bottom',
            textKey: 'ponder.captions.bottomBarOffset.intro',
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
            textKey: 'ponder.captions.bottomBarOffset.command',
            pointTo: { anchor: 'palette', y: 1 },
            durationMs: 3800,
            withPrevious: true,
        },
        { kind: 'pause', id: 'settle' },
    ],
};

const dragToResize: PonderSceneScript = {
    id: 'bottom-bar-drag',
    titleKey: 'ponder.scenes.bottomBarDrag',
    anchors: BAR_ANCHORS,
    steps: [
        { kind: 'highlight', id: 'armBar', anchor: 'bar', intensity: [0, 1], durationMs: 420 },
        {
            kind: 'caption',
            id: 'armed',
            at: 'bottom',
            textKey: 'ponder.captions.bottomBarOffset.armed',
            pointTo: { anchor: 'bar' },
            durationMs: 3200,
            withPrevious: true,
        },
        { kind: 'pause', id: 'readArmed' },

        { kind: 'cursor', id: 'grab', to: { anchor: 'bar' }, press: 'down', durationMs: 420, keyframe: true },
        { kind: 'drag', id: 'lift', from: { anchor: 'bar' }, to: { anchor: 'raised' }, durationMs: 900, ease: 'outCubic' },
        { kind: 'highlight', id: 'ghost', anchor: 'raised', intensity: [0, 0.7], durationMs: 900, withPrevious: true },
        {
            kind: 'caption',
            id: 'drag',
            at: 'bottom',
            textKey: 'ponder.captions.bottomBarOffset.drag',
            pointTo: { anchor: 'raised' },
            durationMs: 3400,
            withPrevious: true,
        },
        { kind: 'pause', id: 'readDrag' },

        { kind: 'cursor', id: 'release', to: { anchor: 'raised' }, press: 'up', durationMs: 220, keyframe: true },
        {
            kind: 'caption',
            id: 'commit',
            at: 'bottom',
            textKey: 'ponder.captions.bottomBarOffset.commit',
            pointTo: { anchor: 'raised' },
            durationMs: 3400,
            withPrevious: true,
        },
        { kind: 'pause', id: 'settle' },
    ],
};

export default {
    id: 'bottom-bar-offset',
    titleKey: 'ponder.targets.bottomBarOffset',
    hoverSelector: '[data-ponder="bottom-bar-offset"]',
    // 已经在定位模式里了就不必再教怎么进去。
    isAvailable: () => !usePlayerBottomBarLayoutStore.getState().isPositioning,
    scenes: [enterPositioning, dragToResize],
} satisfies PonderTargetDefinition;
