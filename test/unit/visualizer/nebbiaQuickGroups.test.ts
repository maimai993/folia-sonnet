import { describe, expect, it } from 'vitest';
import { changedKeys, defaultPosition, distanceFromDefault, groupIcon, isChanged, resetPatch } from '@/components/visualizer/nebbia/nebbiaQuickGroups';
import { quickSliderGroups } from '@/components/visualizer/nebbia/nebbiaSliderSpecs';
import { DEFAULT_NEBBIA_TUNING, NEBBIA_LIMITS } from '@/components/visualizer/nebbia/types';
import { normalizeNebbiaTuning } from '@/components/visualizer/nebbia/tuning';

// test/unit/visualizer/nebbiaQuickGroups.test.ts
// 播放页控制面板里雾笺滑块分组的外观逻辑：哪些项算「调过」、离默认值多远、默认值刻度位置、整组恢复默认的补丁、每组都有图标。

const groups = quickSliderGroups({ behind: 'night', glass: 'rain' });

describe('nebbia quick slider groups', () => {
    it('counts nothing as changed on the default tuning', () => {
        for (const group of groups) expect(changedKeys(group, DEFAULT_NEBBIA_TUNING)).toEqual([]);
    });

    it('treats a move under half a step as unchanged, and a full step as changed', () => {
        expect(isChanged('strokeWidth', DEFAULT_NEBBIA_TUNING.strokeWidth + 0.002, 0.005)).toBe(false);
        expect(isChanged('strokeWidth', DEFAULT_NEBBIA_TUNING.strokeWidth + 0.005, 0.005)).toBe(true);
        expect(isChanged('strokeWidth', 0.04, 0.005)).toBe(true);
    });

    it('lists exactly the changed fields of a group', () => {
        const tuning = { ...DEFAULT_NEBBIA_TUNING, strokeWidth: 0.04, writeSpeed: 2, edge: 1.5 };
        expect(changedKeys(groups[0], tuning).sort()).toEqual(['strokeWidth', 'writeSpeed']);
        expect(changedKeys(groups[1], tuning)).toEqual(['edge']);
    });

    it('measures distance from the default inside 0..1', () => {
        const { min, max } = NEBBIA_LIMITS.edge;
        expect(distanceFromDefault('edge', DEFAULT_NEBBIA_TUNING.edge, min, max)).toBe(0);
        for (const value of [min, max]) {
            const distance = distanceFromDefault('edge', value, min, max);
            expect(distance).toBeGreaterThan(0);
            expect(distance).toBeLessThanOrEqual(1);
        }
    });

    it('places the default tick inside the track', () => {
        for (const group of groups) {
            for (const [key] of group.specs) {
                const position = defaultPosition(key, NEBBIA_LIMITS[key].min, NEBBIA_LIMITS[key].max);
                expect(position).toBeGreaterThanOrEqual(0);
                expect(position).toBeLessThanOrEqual(1);
            }
        }
    });

    it('resets only the fields of one group and the result is valid', () => {
        const messy = { ...DEFAULT_NEBBIA_TUNING, strokeWidth: 0.04, edge: 1.5, mist: 0.3 };
        const patch = resetPatch(groups[1]);
        expect(Object.keys(patch)).toEqual(groups[1].specs.map(spec => spec[0]));
        expect(patch).not.toHaveProperty('strokeWidth');
        const merged = normalizeNebbiaTuning({ ...messy, ...patch });
        expect(merged.edge).toBe(DEFAULT_NEBBIA_TUNING.edge);
        expect(merged.strokeWidth).toBe(0.04);
        expect(merged.mist).toBe(0.3);
    });

    it('gives every group a distinct icon', () => {
        const icons = groups.map(group => groupIcon(group.titleKey));
        expect(new Set(icons).size).toBe(icons.length);
    });
});
