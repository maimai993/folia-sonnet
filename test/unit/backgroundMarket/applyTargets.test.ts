import { describe, expect, it } from 'vitest';
import {
    isExclusiveTarget,
    toggleApplyTarget,
    visualizerBackgroundModeForTargets,
} from '@/services/backgroundMarket/applyTargets';
import type { BackgroundTarget } from '@/components/modal/settings/pages/integration/market/useBackgroundApplyTarget';

// test/unit/backgroundMarket/applyTargets.test.ts
// 背景市场「应用到哪」的勾选规则：莫奈与漫游互斥（#434 第 2 条），
// 以及最终把可视化背景切到哪一档（第 3 条）。

describe('toggleApplyTarget：莫奈与漫游互斥', () => {
    it('勾莫奈会把已经勾着的漫游取消', () => {
        expect(toggleApplyTarget<BackgroundTarget>(['nomand'], 'monet')).toEqual(['monet']);
    });

    it('勾漫游会把已经勾着的莫奈取消', () => {
        expect(toggleApplyTarget<BackgroundTarget>(['monet'], 'nomand')).toEqual(['nomand']);
    });

    it('互斥只在两者之间，别的目标不受牵连', () => {
        expect(toggleApplyTarget<BackgroundTarget>(['wallpaper', 'nomand', 'app'], 'monet'))
            .toEqual(['wallpaper', 'app', 'monet']);
    });

    it('取消勾选不带连坐：点谁取消谁', () => {
        expect(toggleApplyTarget<BackgroundTarget>(['wallpaper', 'monet'], 'monet')).toEqual(['wallpaper']);
    });

    it('两个都点一遍之后只剩最后点的那个', () => {
        const afterMonet = toggleApplyTarget<BackgroundTarget>([], 'monet');
        const afterNomand = toggleApplyTarget(afterMonet, 'nomand');
        expect(afterMonet).toEqual(['monet']);
        expect(afterNomand).toEqual(['nomand']);
        expect(toggleApplyTarget(afterNomand, 'monet')).toEqual(['monet']);
    });

    it('普通目标照常多选，来回切', () => {
        expect(toggleApplyTarget<BackgroundTarget>(['wallpaper'], 'app')).toEqual(['wallpaper', 'app']);
        expect(toggleApplyTarget<BackgroundTarget>(['wallpaper', 'app'], 'app')).toEqual(['wallpaper']);
    });

    it('不改传进来的数组', () => {
        const picked: BackgroundTarget[] = ['nomand'];
        toggleApplyTarget(picked, 'monet');
        expect(picked).toEqual(['nomand']);
    });
});

describe('isExclusiveTarget', () => {
    it('只有莫奈和漫游算互斥目标', () => {
        expect(isExclusiveTarget('monet')).toBe(true);
        expect(isExclusiveTarget('nomand')).toBe(true);
        expect(isExclusiveTarget('app')).toBe(false);
        expect(isExclusiveTarget('wallpaper')).toBe(false);
    });
});

describe('visualizerBackgroundModeForTargets：应用后切到哪一档', () => {
    it('勾了莫奈就切到莫奈', () => {
        expect(visualizerBackgroundModeForTargets(['wallpaper', 'monet'])).toBe('monet');
    });

    it('勾了漫游就切到漫游', () => {
        expect(visualizerBackgroundModeForTargets(['wallpaper', 'nomand'])).toBe('nomand');
    });

    it('两个都在时按漫游算，不会停在旧值上（勾选规则不该产生这种输入）', () => {
        expect(visualizerBackgroundModeForTargets(['monet', 'nomand'])).toBe('nomand');
    });

    it('只勾壁纸或 App 内时不替用户决定背景样式', () => {
        expect(visualizerBackgroundModeForTargets(['wallpaper'])).toBeNull();
        expect(visualizerBackgroundModeForTargets(['wallpaper', 'app'])).toBeNull();
        expect(visualizerBackgroundModeForTargets([])).toBeNull();
    });
});
