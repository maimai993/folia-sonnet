import { SLOT_ANCHORS, slotsAreCustomizableScene } from './controlSlotScenes';
import type { PonderSceneScript, PonderTargetDefinition } from '../../../types/ponder';

// src/components/ponder/targets/volume.target.ts
// 音量。Folia 没有常驻的音量滑块 —— 这是它和多数播放器最直观的一处不同。
// 音量是槽位里的一个动作，按下去打开的是命令面板的音量面板（invokeCommandById），
// 而不是就地弹一个小滑块。找不到音量条的人通常不会想到去命令面板里找。

const VOLUME_ANCHORS = {
    ...SLOT_ANCHORS,
    volumeSlot: {
        kind: 'dom',
        selector: '[data-ponder-slot="volume"]',
        role: 'control',
        labelKey: 'ponder.anchors.volume.button',
    },
    /** 命令面板的音量面板，此刻不在场。 */
    surface: {
        kind: 'synthetic',
        rect: { left: 0.5, top: 0.24, width: 0.4, height: 0.26, anchorX: 'center' },
        role: 'surface',
        labelKey: 'ponder.anchors.volume.surface',
    },
} satisfies PonderSceneScript['anchors'];

const volumeLivesInPalette: PonderSceneScript = {
    id: 'volume-in-palette',
    titleKey: 'ponder.scenes.volumeInPalette',
    anchors: VOLUME_ANCHORS,
    steps: [
        {
            kind: 'caption',
            id: 'intro',
            at: 'bottom',
            textKey: 'ponder.captions.volume.intro',
            pointTo: { anchor: 'volumeSlot' },
            durationMs: 3200,
        },
        { kind: 'pause', id: 'readIntro' },

        { kind: 'cursor', id: 'toButton', to: { anchor: 'volumeSlot' }, durationMs: 560, ease: 'outCubic' },
        { kind: 'cursor', id: 'press', to: { anchor: 'volumeSlot' }, press: 'tap', durationMs: 220, keyframe: true },
        { kind: 'highlight', id: 'surfaceOpens', anchor: 'surface', intensity: [0, 0.8], durationMs: 520 },
        {
            kind: 'caption',
            id: 'opens',
            at: 'bottom',
            textKey: 'ponder.captions.volume.opens',
            pointTo: { anchor: 'surface', y: 1 },
            durationMs: 3600,
            withPrevious: true,
        },
        { kind: 'pause', id: 'settle' },
    ],
};

export default {
    id: 'volume',
    titleKey: 'ponder.targets.volume',
    hoverSelector: '[data-ponder-slot="volume"]',
    priority: 10,
    scenes: [volumeLivesInPalette, slotsAreCustomizableScene],
} satisfies PonderTargetDefinition;
