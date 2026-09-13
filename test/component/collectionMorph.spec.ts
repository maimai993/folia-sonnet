import type { Locator } from '@playwright/test';
import { expect, test } from './fixtures';

// test/component/collectionMorph.spec.ts
// 「移形换影」的浏览器级回归。为什么要组件测试而不是单测：这段转场的失败方式是层叠、
// 命中测试和时序，不是纯逻辑 —— 封锁层盖住了谁、测量量到了哪个网格、生命周期会不会自己
// 结束，都只有真的挂进 DOM 才看得出来。
//
// 注意：合成层是 portal 到 document.body 的，所以它们只能在 page 上查，不在 mount() 返回的
// #root 里。探针自己的 UI（按钮、状态读数）才从 #root 查。

const MORPH_LAYER = '[data-folia-collection-morph]';
const FRAME = '[data-folia-collection-morph="frame"]';
const COVER = '[data-folia-collection-morph="cover"]';
const TITLE = '[data-folia-collection-morph="title"]';
const BLOCKER = '[data-folia-collection-morph="input-blocker"]';

/** 探针里的三张封面是 data URI，SVG 里带着各自的标签，用编码后的片段区分来源。 */
const coverSources = (locator: Locator) => locator.locator('img').evaluateAll(
    (nodes: HTMLImageElement[]) => nodes.map(node => node.getAttribute('src') ?? ''),
);

test('the clicked card morphs onto the active grid hero and the flight ends by itself', async ({ mount, page }) => {
    const root = await mount('collectionMorph');
    await expect(root.locator('[data-probe-enabled]')).toHaveAttribute('data-probe-enabled', 'true');

    await root.locator('[data-probe-home-card]').click();
    await expect(root.locator('[data-probe-open]')).toHaveAttribute('data-probe-open', 'true');

    // 三件套 + 封锁层都在，计划是 'morph'（有合成层盖着 hero）。
    await expect(page.locator(FRAME)).toHaveCount(1);
    await expect(page.locator(COVER)).toHaveCount(1);
    await expect(page.locator(TITLE)).toHaveCount(1);
    await expect(page.locator(BLOCKER)).toHaveCount(1);
    await expect(root.locator('[data-probe-plan]')).toHaveAttribute('data-probe-plan', 'morph');

    // 飞行目标必须是**活动**网格那张卡：同一个位置上还压着「正在退出的旧网格」的卡片，
    // 而且它排在前面（距离相同时 probeHeroTargets 取文档顺序里的第一个）。
    await expect.poll(() => coverSources(page.locator(COVER))).toEqual(
        expect.arrayContaining([expect.stringContaining('detail')]),
    );
    expect((await coverSources(page.locator(COVER))).some(src => src.includes('stale'))).toBe(false);
    await expect(page.locator(TITLE)).toContainText('Detail Song');
    await expect(page.locator(TITLE)).not.toContainText('Stale Song');

    // 生命周期自己结束：不能等用户操作才收掉封锁层。
    await expect(page.locator(BLOCKER)).toHaveCount(0, { timeout: 8000 });
    await expect(page.locator(MORPH_LAYER)).toHaveCount(0);
    await expect(root.locator('[data-probe-plan]')).toHaveAttribute('data-probe-plan', 'none');
});

test('a click on the blockade skips the flight instead of being swallowed', async ({ mount, page }) => {
    const root = await mount('collectionMorph');
    await root.locator('[data-probe-home-card]').click();
    await expect(page.locator(BLOCKER)).toHaveCount(1);

    // 用户的第一反应是点一下跳过。不接 pointerdown 时这一下会被无声吞掉。
    await page.mouse.move(1200, 900);
    await page.mouse.down();
    await page.mouse.up();

    await expect(page.locator(BLOCKER)).toHaveCount(0, { timeout: 3000 });
    await expect(page.locator(MORPH_LAYER)).toHaveCount(0);
    await expect(root.locator('[data-probe-plan]')).toHaveAttribute('data-probe-plan', 'none');
});

test('reduced motion never starts the transition', async ({ mount, page }) => {
    // store 在模块 import 时读 localStorage，所以种子必须写在页面脚本之前。
    await page.addInitScript(() => localStorage.setItem('reduce_motion_collectionMorph', 'true'));
    const root = await mount('collectionMorph');
    await expect(root.locator('[data-probe-enabled]')).toHaveAttribute('data-probe-enabled', 'false');

    await root.locator('[data-probe-home-card]').click();
    // 导航照常发生，只是没有任何合成层。
    await expect(root.locator('[data-probe-open]')).toHaveAttribute('data-probe-open', 'true');
    await expect(root.locator('[data-probe-detail-card]')).toBeVisible();

    await expect(page.locator(MORPH_LAYER)).toHaveCount(0);
    await page.waitForTimeout(900);
    await expect(page.locator(MORPH_LAYER)).toHaveCount(0);
    await expect(root.locator('[data-probe-plan]')).toHaveAttribute('data-probe-plan', 'none');
});

test('turning the surface off mid-flight finishes the lifecycle instead of stranding the composite', async ({ mount, page }) => {
    const root = await mount('collectionMorph');
    await root.locator('[data-probe-home-card]').click();
    await expect(page.locator(FRAME)).toHaveCount(1);

    // 等同于用户在飞行途中关掉了这一面动效。按钮此刻在封锁层下面，所以直接触发它的 click，
    // 绕过命中测试 —— 走的是设置面板同一条 store setter。
    await root.locator('[data-probe-action="reduce"]').evaluate((node) => (node as HTMLButtonElement).click());

    await expect(root.locator('[data-probe-enabled]')).toHaveAttribute('data-probe-enabled', 'false');
    await expect(page.locator(MORPH_LAYER)).toHaveCount(0, { timeout: 4000 });
    await expect(root.locator('[data-probe-plan]')).toHaveAttribute('data-probe-plan', 'none');
});
