import { CloudFog, Droplets, PenLine, type LucideIcon } from 'lucide-react';
import { quickSliderGroups, type NebbiaQuickSliderGroup } from './nebbiaSliderSpecs';
import { DEFAULT_NEBBIA_TUNING, type NebbiaNumberKey, type NebbiaTuning } from './types';

// src/components/visualizer/nebbia/nebbiaQuickGroups.ts
// 播放页控制面板里雾笺滑块的分组外观：每组的图标、哪些项被调过（和默认值不同）、整组恢复默认要写回的补丁。
// 纯函数，不碰 React，方便单测。

/** 每组的图标，按 nebbiaSliderSpecs.ts 的 titleKey 找。 */
const GROUP_ICONS: Record<string, LucideIcon> = {
    'options.nebbiaWriting': PenLine,
    'options.nebbiaFogDetail': CloudFog,
    'options.nebbiaGlass': Droplets,
};
export const groupIcon = (titleKey: string): LucideIcon => GROUP_ICONS[titleKey] ?? CloudFog;

/** 一个滑块的值和默认值差多少算「调过」：半个步进以内都当没动，避免取整误差亮起标记。 */
export const isChanged = (key: NebbiaNumberKey, value: number, step: number) => (
    Math.abs(value - DEFAULT_NEBBIA_TUNING[key]) > step / 2
);

/** 离默认值有多远，0..1：按这条的范围算，用来决定轨道上的光有多亮。 */
export const distanceFromDefault = (key: NebbiaNumberKey, value: number, min: number, max: number) => {
    const span = max - min;
    return span > 0 ? Math.min(1, Math.abs(value - DEFAULT_NEBBIA_TUNING[key]) / span * 2) : 0;
};

/** 默认值在滑杆上的位置，0..1，用来画刻度。 */
export const defaultPosition = (key: NebbiaNumberKey, min: number, max: number) => {
    const span = max - min;
    return span > 0 ? Math.min(1, Math.max(0, (DEFAULT_NEBBIA_TUNING[key] - min) / span)) : 0;
};

/** 这一组里被调过的字段。 */
export const changedKeys = (group: NebbiaQuickSliderGroup, tuning: NebbiaTuning): NebbiaNumberKey[] => (
    group.specs.filter(([key, , step]) => isChanged(key, tuning[key], step)).map(([key]) => key)
);

/** 整组恢复默认：只写回这一组里的字段，别的组不动。 */
export const resetPatch = (group: NebbiaQuickSliderGroup): Partial<NebbiaTuning> => (
    Object.fromEntries(group.specs.map(([key]) => [key, DEFAULT_NEBBIA_TUNING[key]])) as Partial<NebbiaTuning>
);

/** 当前窗外、玻璃下要画的几组（和 quickSliderGroups 同一份，这里只为让组件一处引用）。 */
export const groupsFor = (tuning: Pick<NebbiaTuning, 'behind' | 'glass'>) => quickSliderGroups(tuning);
