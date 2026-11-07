import { describe, expect, it } from 'vitest';
import { decimalsOf, fogDetailSlidersFor, quickSliderGroups, WRITING_SLIDERS } from '@/components/visualizer/nebbia/nebbiaSliderSpecs';
import { NEBBIA_LIMITS, type NebbiaNumberKey } from '@/components/visualizer/nebbia/types';
import zhCN from '@/i18n/locales/zh-CN';

// test/unit/visualizer/nebbiaQuickSliders.test.ts
// 播放页控制面板的雾笺快捷滑块清单：畫筆粗細在內、每條都有範圍和文案、隨窗外和玻璃增減、步進小數位。

const keysOf = (specs: { 0: NebbiaNumberKey }[]) => specs.map(spec => spec[0]);

describe('nebbia quick sliders', () => {
    it('puts the pen width first in the quick panel', () => {
        const groups = quickSliderGroups({ behind: 'night', glass: 'rain' });
        expect(groups[0].specs[0][0]).toBe('strokeWidth');
        expect(keysOf(WRITING_SLIDERS)).toContain('strokeWidth');
    });

    it('gives every slider a range and a zh-CN label', () => {
        const options = (zhCN as unknown as { options: Record<string, string> }).options;
        for (const behind of ['night', 'aquarium', 'backdrop'] as const) {
            for (const glass of ['rain', 'dew', 'snow'] as const) {
                for (const group of quickSliderGroups({ behind, glass })) {
                    expect(options[group.titleKey.replace('options.', '')], group.titleKey).toBeTruthy();
                    for (const [key, labelKey] of group.specs) {
                        expect(NEBBIA_LIMITS[key], key).toBeDefined();
                        expect(options[labelKey.replace('options.', '')], labelKey).toBeTruthy();
                    }
                }
            }
        }
    });

    it('lists no slider twice in one panel', () => {
        const all = quickSliderGroups({ behind: 'night', glass: 'rain' }).flatMap(group => keysOf(group.specs));
        expect(new Set(all).size).toBe(all.length);
    });

    it('shows the field-drop density only on the rain glass', () => {
        expect(keysOf(fogDetailSlidersFor('night', 'rain'))).toContain('fieldDrops');
        expect(keysOf(fogDetailSlidersFor('night', 'dew'))).not.toContain('fieldDrops');
        expect(keysOf(fogDetailSlidersFor('night', 'snow'))).not.toContain('fieldDrops');
    });

    it('hides wind and bump items in the aquarium', () => {
        const aqua = keysOf(fogDetailSlidersFor('aquarium', 'dew'));
        for (const key of ['wind', 'bumpRate', 'bumpFall'] as const) expect(aqua).not.toContain(key);
        expect(keysOf(fogDetailSlidersFor('night', 'rain'))).toEqual(expect.arrayContaining(['wind', 'bumpRate', 'bumpFall']));
    });

    it('rounds a slider to the decimals its step needs', () => {
        expect(decimalsOf(1)).toBe(0);
        expect(decimalsOf(0.5)).toBe(1);
        expect(decimalsOf(0.1)).toBe(1);
        expect(decimalsOf(0.05)).toBe(2);
        expect(decimalsOf(0.01)).toBe(2);
        expect(decimalsOf(0.005)).toBe(3);
    });
});
