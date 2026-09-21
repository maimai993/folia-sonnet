import { slotsAreCustomizableScene } from './controlSlotScenes';
import type { PonderTargetDefinition } from '../../../types/ponder';

// src/components/ponder/targets/controlSlots.target.ts
// 进度条胶囊右侧那两个可自定义槽位。
//
// 这是槽位的「兜底」目标：悬停任何一个槽位都能命中它。
// shuffle 和 volume 另有自己的目标、priority 更高，会在各自的按钮上盖过这一个 ——
// 那两个动作除了「可以换」之外还有 Folia 独有的语义要讲。

export default {
    id: 'control-slots',
    titleKey: 'ponder.targets.controlSlots',
    hoverSelector: '[data-ponder-slot]',
    scenes: [slotsAreCustomizableScene],
} satisfies PonderTargetDefinition;
