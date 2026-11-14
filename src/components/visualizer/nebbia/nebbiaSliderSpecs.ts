import type { NebbiaNumberKey, NebbiaTuning } from './types';

// src/components/visualizer/nebbia/nebbiaSliderSpecs.ts
// 雾笺所有数值滑块的清单（哪个字段、哪条文案、步进、怎么读数）：设置窗口的面板（NebbiaSettingsPanel.tsx）
// 和播放页控制面板里的快捷滑块（NebbiaQuickSliders.tsx）画的是同一份，改一处两边一起变。

/** [字段, 文案 key, 步进, 读数]。 */
export type NebbiaSliderSpec = [NebbiaNumberKey, string, number, (value: number) => string];

export const percent = (value: number) => `${Math.round(value * 100)}%`;
export const times = (value: number) => `${value.toFixed(2)}x`;
export const seconds = (value: number) => `${value.toFixed(1)}s`;
export const count = (value: number) => String(Math.round(value));

export const WRITING_SLIDERS: NebbiaSliderSpec[] = [
    ['strokeWidth', 'options.nebbiaStrokeWidth', 0.005, percent],
    ['writeSpeed', 'options.nebbiaWriteSpeed', 0.05, times],
    ['jitter', 'options.nebbiaJitter', 0.05, times],
    ['warp', 'options.nebbiaWarp', 0.05, times],
    ['doodle', 'options.nebbiaDoodle', 0.05, percent],
    ['mist', 'options.nebbiaMist', 0.01, percent],
    ['hold', 'options.nebbiaHold', 0.1, seconds],
    ['refog', 'options.nebbiaRefog', 0.5, seconds],
];

export const WINDOW_SLIDERS: NebbiaSliderSpec[] = [
    ['busSpeed', 'options.nebbiaBusSpeed', 0.05, times],
    ['neon', 'options.nebbiaNeon', 0.05, times],
    ['bump', 'options.nebbiaBump', 0.05, times],
    ['spot', 'options.nebbiaSpot', 0.05, times],
    ['spotX', 'options.nebbiaSpotX', 0.01, percent],
];

/** 水族箱里车不颠：这条不显示。 */
const NOT_IN_AQUARIUM: readonly NebbiaNumberKey[] = ['bump'];
export const AQUA_WINDOW_SLIDERS = WINDOW_SLIDERS.filter(([key]) => !NOT_IN_AQUARIUM.includes(key));

export const AQUA_SLIDERS: NebbiaSliderSpec[] = [
    ['jellies', 'options.nebbiaJellies', 1, count],
    ['jellySize', 'options.nebbiaJellySize', 0.05, times],
    ['bubbles', 'options.nebbiaBubbles', 0.05, percent],
];

export const GLASS_SLIDERS: Record<NebbiaTuning['glass'], NebbiaSliderSpec[]> = {
    rain: [
        ['rainHit', 'options.nebbiaRainHit', 0.05, times],
        ['rainBig', 'options.nebbiaRainBig', 0.05, times],
    ],
    dew: [
        ['dew', 'options.nebbiaDew', 0.05, times],
        ['dewSize', 'options.nebbiaDewSize', 0.05, times],
        ['dewGlint', 'options.nebbiaDewGlint', 0.05, times],
    ],
    snow: [
        ['snow', 'options.nebbiaSnow', 0.05, times],
        ['snowSize', 'options.nebbiaSnowSize', 0.05, times],
        ['snowMelt', 'options.nebbiaSnowMelt', 0.05, times],
    ],
};

/** 霧的細節：原型裡寫死的參數，預設值同原來。 */
export const FOG_DETAIL_SLIDERS: NebbiaSliderSpec[] = [
    ['edge', 'options.nebbiaEdge', 0.05, percent],
    ['beads', 'options.nebbiaBeads', 0.05, percent],
    ['drip', 'options.nebbiaDrip', 0.05, percent],
    ['endBead', 'options.nebbiaEndBead', 0.05, times],
    ['beadHold', 'options.nebbiaBeadHold', 0.5, seconds],
    ['refract', 'options.nebbiaRefract', 0.05, times],
    ['glint', 'options.nebbiaGlint', 0.05, times],
    ['fieldDrops', 'options.nebbiaFieldDrops', 0.05, times],
    ['wind', 'options.nebbiaWind', 0.05, percent],
    ['breathSpread', 'options.nebbiaBreathSpread', 0.1, seconds],
    ['breathHold', 'options.nebbiaBreathHold', 0.1, seconds],
    ['breathFade', 'options.nebbiaBreathFade', 0.5, seconds],
    ['breathThick', 'options.nebbiaBreathThick', 0.05, percent],
    ['bumpRate', 'options.nebbiaBumpRate', 0.05, times],
    ['bumpFall', 'options.nebbiaBumpFall', 0.05, percent],
];

/** 雾上凝结水珠密度只雨窗有；水族箱没有车，风和颠簸两项不出。 */
const RAIN_GLASS_ONLY: readonly NebbiaNumberKey[] = ['fieldDrops'];
const BUS_ONLY: readonly NebbiaNumberKey[] = ['wind', 'bumpRate', 'bumpFall'];

/** 当前窗外、玻璃下用得上的霧的細節滑块。 */
export const fogDetailSlidersFor = (behind: NebbiaTuning['behind'], glass: NebbiaTuning['glass']): NebbiaSliderSpec[] => (
    FOG_DETAIL_SLIDERS.filter(([key]) => !(RAIN_GLASS_ONLY.includes(key) && glass !== 'rain') && !(BUS_ONLY.includes(key) && behind === 'aquarium'))
);

/** 播放页控制面板里的快捷滑块：一组一个标题（文案 key），顺序是常调的在前。 */
export interface NebbiaQuickSliderGroup { titleKey: string; specs: NebbiaSliderSpec[] }
export const quickSliderGroups = (tuning: Pick<NebbiaTuning, 'behind' | 'glass'>): NebbiaQuickSliderGroup[] => [
    { titleKey: 'options.nebbiaWriting', specs: WRITING_SLIDERS },
    { titleKey: 'options.nebbiaFogDetail', specs: fogDetailSlidersFor(tuning.behind, tuning.glass) },
    { titleKey: 'options.nebbiaGlass', specs: GLASS_SLIDERS[tuning.glass] },
];

/** 一个步进要保留几位小数：滑杆取值按它取整，避免 0.30000000000000004 这类值进存档。 */
export const decimalsOf = (step: number) => Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
