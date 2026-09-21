import type { PonderSceneScript } from '../../../types/ponder';

// src/components/ponder/targets/controlSlotScenes.ts
// 「进度条右边这两个位置的按钮可以换」这一章，由 control-slots、shuffle、volume 三个目标共用。
//
// 文件名不以 .target.ts 结尾，注册表的 glob 不会把它当成一个目标 —— 它只是被三个目标
// 各自引用的一段脚本。写一份而不是抄三份：这一章讲的是同一件事，措辞跟着改也只改一处。

/** 两个槽位和它们所在容器的锚点，三个目标共用。 */
export const SLOT_ANCHORS = {
    slots: {
        kind: 'dom',
        selector: '[data-ponder-slots]',
        role: 'rail',
        labelKey: 'ponder.anchors.controlSlots.slots',
        labelPlacement: 'below',
    },
    primarySlot: {
        kind: 'dom',
        selector: '[data-ponder-slots] > button:nth-of-type(1)',
        role: 'control',
        labelKey: 'ponder.anchors.controlSlots.primary',
    },
    secondarySlot: {
        kind: 'dom',
        selector: '[data-ponder-slots] > button:nth-of-type(2)',
        role: 'control',
    },
    /** 设置里那个选动作的下拉，此刻不在场，按视口比例合成。 */
    picker: {
        kind: 'synthetic',
        rect: { left: 0.5, top: 0.26, width: 0.3, height: 0.38, anchorX: 'center' },
        role: 'surface',
        labelKey: 'ponder.anchors.controlSlots.picker',
    },
} satisfies PonderSceneScript['anchors'];

/** 「这两个位置可以换成别的动作」。 */
export const slotsAreCustomizableScene: PonderSceneScript = {
    id: 'control-slots-customizable',
    titleKey: 'ponder.scenes.controlSlotsCustomizable',
    anchors: SLOT_ANCHORS,
    steps: [
        { kind: 'highlight', id: 'showSlots', anchor: 'slots', intensity: [0, 0.6], durationMs: 460 },
        {
            kind: 'caption',
            id: 'intro',
            at: 'bottom',
            textKey: 'ponder.captions.controlSlots.intro',
            pointTo: { anchor: 'slots' },
            durationMs: 3200,
            withPrevious: true,
        },
        { kind: 'pause', id: 'readIntro' },

        { kind: 'highlight', id: 'markPrimary', anchor: 'primarySlot', intensity: [0, 1], durationMs: 400, keyframe: true },
        { kind: 'highlight', id: 'markSecondary', anchor: 'secondarySlot', intensity: [0, 1], durationMs: 400, withPrevious: true },
        {
            kind: 'caption',
            id: 'two',
            at: 'bottom',
            textKey: 'ponder.captions.controlSlots.two',
            pointTo: { anchor: 'primarySlot' },
            durationMs: 3000,
            withPrevious: true,
        },
        { kind: 'pause', id: 'readTwo' },

        { kind: 'highlight', id: 'openPicker', anchor: 'picker', intensity: [0, 0.8], durationMs: 460, keyframe: true },
        {
            kind: 'caption',
            id: 'where',
            at: 'bottom',
            textKey: 'ponder.captions.controlSlots.where',
            pointTo: { anchor: 'picker', y: 1 },
            durationMs: 3600,
            withPrevious: true,
        },
        { kind: 'pause', id: 'settle' },
    ],
};
