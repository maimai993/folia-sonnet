import { SLOT_ANCHORS, slotsAreCustomizableScene } from './controlSlotScenes';
import type { PonderSceneScript, PonderTargetDefinition } from '../../../types/ponder';

// src/components/ponder/targets/shuffle.target.ts
// 随机播放。这是 Folia 和多数播放器不一样的地方，也是这个目标存在的理由：
// 别处的「随机」是一个持续生效的播放模式，Folia 的是对当前队列做一次原地洗牌
// （usePlaybackQueueController.ts 里的 Fisher-Yates），洗完队列就定下来了。
// 期待它是个模式开关的人，会以为自己按了一下没生效。

const QUEUE_ANCHORS = {
    ...SLOT_ANCHORS,
    shuffleSlot: {
        kind: 'dom',
        selector: '[data-ponder-slot="shuffle"]',
        role: 'control',
        labelKey: 'ponder.anchors.shuffle.button',
    },
    /** 队列此刻不在场，按视口比例合成一列。 */
    queue: {
        kind: 'synthetic',
        rect: { left: 0.5, top: 0.22, width: 0.34, height: 0.42, anchorX: 'center' },
        role: 'surface',
        labelKey: 'ponder.anchors.shuffle.queue',
    },
} satisfies PonderSceneScript['anchors'];

const shuffleIsOneShot: PonderSceneScript = {
    id: 'shuffle-one-shot',
    titleKey: 'ponder.scenes.shuffleOneShot',
    anchors: QUEUE_ANCHORS,
    steps: [
        { kind: 'highlight', id: 'showQueue', anchor: 'queue', intensity: [0, 0.5], durationMs: 460 },
        {
            kind: 'caption',
            id: 'intro',
            at: 'bottom',
            textKey: 'ponder.captions.shuffle.intro',
            pointTo: { anchor: 'queue' },
            durationMs: 3200,
            withPrevious: true,
        },
        { kind: 'pause', id: 'readIntro' },

        { kind: 'cursor', id: 'toButton', to: { anchor: 'shuffleSlot' }, durationMs: 560, ease: 'outCubic' },
        { kind: 'cursor', id: 'press', to: { anchor: 'shuffleSlot' }, press: 'tap', durationMs: 220, keyframe: true },
        { kind: 'highlight', id: 'queueShuffles', anchor: 'queue', intensity: [0.5, 1], durationMs: 700 },
        {
            kind: 'caption',
            id: 'once',
            at: 'bottom',
            textKey: 'ponder.captions.shuffle.once',
            pointTo: { anchor: 'queue' },
            durationMs: 3600,
            withPrevious: true,
        },
        { kind: 'pause', id: 'readOnce' },

        {
            kind: 'caption',
            id: 'notAMode',
            at: 'bottom',
            textKey: 'ponder.captions.shuffle.notAMode',
            pointTo: { anchor: 'shuffleSlot' },
            durationMs: 3600,
            keyframe: true,
        },
        { kind: 'pause', id: 'settle' },
    ],
};

export default {
    id: 'shuffle',
    titleKey: 'ponder.targets.shuffle',
    hoverSelector: '[data-ponder-slot="shuffle"]',
    // 盖过 control-slots：同一个按钮，这个目标更具体。
    priority: 10,
    scenes: [shuffleIsOneShot, slotsAreCustomizableScene],
} satisfies PonderTargetDefinition;
