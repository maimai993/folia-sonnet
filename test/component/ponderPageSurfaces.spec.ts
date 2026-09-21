import { expect, test } from './fixtures';

// test/component/ponderPageSurfaces.spec.ts

type Mount = (component: string) => Promise<unknown>;

test.beforeEach(async ({ mount }) => {
    await (mount as unknown as Mount)('ponderPageSurfaces');
});

test('Grid3D 使用真实页头和轨道结构，并演示打开集合的结果', async ({ page }) => {
    await page.locator('[data-probe-open="grid-card-result"]').click();
    const stage = page.locator('[data-testid="ponder-stage"]');
    await expect(stage).toBeVisible();
    await expect(stage.locator('[data-ponder-grid-tabs]')).toBeVisible();
    await expect(stage.locator('[data-ponder-grid-shelf]')).toBeVisible();
    await expect(stage.locator('[data-ponder-grid-card]')).toHaveCount(5);

    const result = stage.locator('[data-ponder-surface-state="collection-open"]');
    await expect(result).toHaveCSS('opacity', '1', { timeout: 7000 });
});

test('GridView 演示标题点击后出现真实信息面板', async ({ page }) => {
    await page.locator('[data-probe-open="grid-view-info"]').click();
    const stage = page.locator('[data-testid="ponder-stage"]');
    await expect(stage.locator('[data-ponder-grid-view-cards]').first()).toBeVisible();
    await expect(stage.locator('[data-ponder-surface-state="info-open"]')).toHaveCSS('opacity', '1', { timeout: 5000 });
    await expect(stage.locator('[data-ponder-grid-view-info]')).toBeVisible();
});

test('Lattice 是不规则海报墙，并演示海报展开后的播放控制', async ({ page }) => {
    await page.locator('[data-probe-open="lattice-poster"]').click();
    const stage = page.locator('[data-testid="ponder-stage"]');
    await expect(stage.locator('[data-ponder-lattice-poster]').first()).toBeVisible();
    await expect(stage.locator('[data-ponder-surface-state="poster-expanded"]')).toHaveCSS('opacity', '1', { timeout: 5000 });
    await expect(stage.locator('[data-ponder-lattice-chrome]')).toBeVisible();
});

/**
 * 锚点框和合成界面里那个真实元素必须严丝合缝。
 *
 * 两边各写一份百分比时它们会差上几个百分点 —— 高亮落在元素旁边、指向线指偏，
 * 正是「骨架和真实元素错位」。ponderSurfaceGeometry 是这条约束的唯一来源。
 */
const expectAligned = async (stage: any, anchor: string, element: string) => {
    const anchorBox = await stage.locator(`[data-ponder-anchor="${anchor}"]`).boundingBox();
    const elementBox = await stage.locator(element).first().boundingBox();
    expect(anchorBox, `anchor ${anchor}`).not.toBeNull();
    expect(elementBox, `element ${element}`).not.toBeNull();
    for (const side of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(anchorBox![side] - elementBox![side]), `${anchor}.${side}`).toBeLessThan(1.5);
    }
};

test('页面锚点和合成界面里的真实元素严丝合缝', async ({ page }) => {
    await page.locator('[data-probe-open="lattice-poster"]').click();
    let stage = page.locator('[data-testid="ponder-stage"]');
    await expect(stage).toBeVisible();
    await expectAligned(stage, 'wall', '[data-ponder-lattice-wall]');
    await expectAligned(stage, 'poster', '[data-ponder-lattice-poster][data-focused]');
    await expectAligned(stage, 'back', '[data-ponder-lattice-back]');
    await expectAligned(stage, 'tools', '[data-ponder-lattice-tools]');
    await page.keyboard.press('Escape');

    await page.locator('[data-probe-open="grid-card-result"]').click();
    stage = page.locator('[data-testid="ponder-stage"]');
    await expect(stage).toBeVisible();
    await expectAligned(stage, 'focusedCard', '[data-ponder-grid-card][data-focused]');
    await expectAligned(stage, 'tabs', '[data-ponder-grid-tabs]');
    await expectAligned(stage, 'search', '[data-ponder-grid-search]');
    await expectAligned(stage, 'shelf', '[data-ponder-grid-shelf]');
    await page.keyboard.press('Escape');

    await page.locator('[data-probe-open="grid-view-info"]').click();
    stage = page.locator('[data-testid="ponder-stage"]');
    await expect(stage).toBeVisible();
    await expectAligned(stage, 'cards', '[data-ponder-grid-view-cards]');
    await expectAligned(stage, 'card', '[data-ponder-grid-view-card][data-focused]');
    await expectAligned(stage, 'back', '[data-ponder-grid-view-back]');
});

test('页面区域只提供几何，不再在合成界面上叠第二层描边框', async ({ page }) => {
    await page.locator('[data-probe-open="lattice-poster"]').click();
    const stage = page.locator('[data-testid="ponder-stage"]');
    await expect(stage).toBeVisible();

    const regions = stage.locator('[data-ponder-anchor-role="region"]');
    await expect(regions.first()).toBeAttached();
    const widths = await regions.evaluateAll(nodes => nodes.map(node => getComputedStyle(node).borderTopWidth));
    expect(new Set(widths)).toEqual(new Set(['0px']));
});

test('整屏替换的结果层会把它顶掉的那一层淡出，屏幕上不会同时有两面墙', async ({ page }) => {
    await page.locator('[data-probe-open="lattice-poster"]').click();
    const stage = page.locator('[data-testid="ponder-stage"]');
    await expect(stage).toBeVisible();
    await page.keyboard.press('[');

    const base = stage.locator('[data-ponder-surface-state="base"]');
    const panned = stage.locator('[data-ponder-surface-state="wall-panned"]');
    await expect(panned).toHaveCSS('opacity', '1', { timeout: 6000 });
    await expect(base).toHaveCSS('opacity', '0');
});
