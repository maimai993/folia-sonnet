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
/**
 * 进场期间整层带着缩放、每个框还各自错开落位，这时量到的两个盒子缩放进度不同，差值没有意义。
 * 等整层和所有落位动画都停下来再量。
 */
const settled = async (stage: any) => {
    await expect(stage).toHaveCSS('opacity', '1', { timeout: 3000 });
    await expect(stage.locator('[data-ponder-stage-content]'))
        .toHaveCSS('transform', 'none', { timeout: 3000 });
    await stage.page().waitForFunction(() => !document.getAnimations().some(animation => (
        animation.playState === 'running'
        && String((animation as unknown as { animationName?: string }).animationName ?? '').startsWith('ponder-skeleton')
    )), undefined, { timeout: 3000 });
};

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
    await settled(stage);
    await expectAligned(stage, 'wall', '[data-ponder-lattice-wall]');
    await expectAligned(stage, 'poster', '[data-ponder-lattice-poster][data-focused]');
    await expectAligned(stage, 'back', '[data-ponder-lattice-back]');
    await expectAligned(stage, 'tools', '[data-ponder-lattice-tools]');
    await page.keyboard.press('Escape');

    await page.locator('[data-probe-open="grid-card-result"]').click();
    stage = page.locator('[data-testid="ponder-stage"]');
    await expect(stage).toBeVisible();
    await settled(stage);
    await expectAligned(stage, 'focusedCard', '[data-ponder-grid-card][data-focused]');
    await expectAligned(stage, 'tabs', '[data-ponder-grid-tabs]');
    await expectAligned(stage, 'search', '[data-ponder-grid-search]');
    await expectAligned(stage, 'shelf', '[data-ponder-grid-shelf]');
    await page.keyboard.press('Escape');

    await page.locator('[data-probe-open="grid-view-info"]').click();
    stage = page.locator('[data-testid="ponder-stage"]');
    await expect(stage).toBeVisible();
    await settled(stage);
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

test('底部控制条画的是完整尺寸的合成胶囊，锚点和上面的控件对齐', async ({ page }) => {
    await page.locator('[data-probe-open="player-bar-basics"]').click();
    const stage = page.locator('[data-testid="ponder-stage"]');
    await expect(stage).toBeVisible();
    await settled(stage);

    await expectAligned(stage, 'play', '[data-ponder-bar-play]');
    await expectAligned(stage, 'title', '[data-ponder-bar-title]');
    await expectAligned(stage, 'progress', '[data-ponder-bar-progress]');
    await expectAligned(stage, 'primarySlot', '[data-ponder-bar-slot="primary"]');
    await expectAligned(stage, 'secondarySlot', '[data-ponder-bar-slot="secondary"]');

    // 真实那条会收起来也会被缩放，所以这里量的必须是合成胶囊，不是页面上的控制条。
    const bar = stage.locator('[data-ponder-anchor="bar"]');
    const box = await bar.boundingBox();
    expect(box!.width).toBeGreaterThan(600);
    await expect(bar).toHaveCSS('border-radius', /9999px/);
});

test('随机和音量两章不依赖槽位里此刻放着什么', async ({ page }) => {
    for (const [probe, state] of [['player-bar-shuffle', 'slots-shuffle'], ['player-bar-volume', 'slots-volume']] as const) {
        await page.locator(`[data-probe-open="${probe}"]`).click();
        const stage = page.locator('[data-testid="ponder-stage"]');
        await expect(stage).toBeVisible();
        // 合成界面把第一个槽位换成这一章要讲的那个按钮，默认槽位层同时退场。
        await expect(stage.locator(`[data-ponder-surface-state="${state}"]`)).toHaveCSS('opacity', '1', { timeout: 6000 });
        await expect(stage.locator('[data-ponder-surface-state="slots"]')).toHaveCSS('opacity', '0');
        await page.keyboard.press('Escape');
    }
});

test('动作的结果等到那一步才出现，不是一进场就摆在屏幕上', async ({ page }) => {
    await page.locator('[data-probe-open="player-bar-height"]').click();
    const stage = page.locator('[data-testid="ponder-stage"]');
    await expect(stage).toBeVisible();

    // 「设置 · 底部界面」是这一章要讲的那次操作的结果，开场时不该在场。
    const settings = stage.locator('[data-ponder-anchor="settings"]');
    await expect(settings).toHaveAttribute('data-ponder-anchor-hidden', 'true');
    await expect(settings).toHaveCSS('opacity', '0');
    // 胶囊本身是一直在的，不跟着藏。
    await expect(stage.locator('[data-ponder-anchor="bar"]')).toHaveCSS('opacity', '1');

    await expect(settings).toHaveCSS('opacity', '1', { timeout: 6000 });
    // 画的是滑杆加「在播放页拖动调整」，字幕说的就是这两样。
    await expect(stage.locator('[data-ponder-bottom-ui-offset-track]')).toBeVisible();
    await expect(stage.locator('[data-ponder-bottom-ui-reposition]')).toBeVisible();
    // 章节底下那个快速入口按钮去的正是同一处设置。
    await expect(stage.getByRole('button', { name: /bottom ui settings/i })).toBeVisible();
});

test('骨架框逐个落位，而不是整幅图一次性出现', async ({ page }) => {
    await page.locator('[data-probe-open="grid-card-result"]').click();
    const stage = page.locator('[data-testid="ponder-stage"]');
    await expect(stage).toBeVisible();

    const delays = await stage.locator('[data-ponder-anchor]:not([data-ponder-anchor-hidden])')
        .evaluateAll(nodes => nodes.map(node => getComputedStyle(node).animationDelay));
    expect(delays.length).toBeGreaterThan(2);
    expect(new Set(delays).size, '所有框用同一个延迟就等于没有错开').toBeGreaterThan(1);
});

test('播放页画的是整屏形态，四个可单独思索的组件都列出来', async ({ page }) => {
    await page.locator('[data-probe-open="player-page-layout"]').click();
    const stage = page.locator('[data-testid="ponder-stage"]');
    await expect(stage).toBeVisible();
    await settled(stage);

    await expectAligned(stage, 'lyrics', '[data-ponder-player-lyrics]');
    await expectAligned(stage, 'bar', '[data-ponder-player-bar]');
    await expectAligned(stage, 'toggle', '[data-ponder-player-toggle]');
    await expectAligned(stage, 'track', '[data-ponder-player-track]');

    const related = stage.getByTestId('ponder-related-targets');
    for (const name of ['Bottom control bar', 'Command window', 'Side panel toggle', 'Side control panel']) {
        await expect(related.getByRole('button', { name })).toBeVisible();
    }
});

test('执行模式只从冒号进，键位一个键一条命令', async ({ page }) => {
    await page.locator('[data-probe-open="player-page-commands"]').click();
    const stage = page.locator('[data-testid="ponder-stage"]');
    await expect(stage).toBeVisible();

    // 先是普通的命令窗口，输入冒号之后才换成执行模式那一屏。
    await expect(stage.locator('[data-ponder-surface-state="palette-open"]')).toHaveCSS('opacity', '1', { timeout: 6000 });
    await expect(stage.locator('[data-ponder-player-execute-mode]')).toHaveCount(1);
    await expect(stage.locator('[data-ponder-surface-state="execute-mode"]')).toHaveCSS('opacity', '1', { timeout: 15000 });
    await expect(stage.locator('[data-ponder-player-execute-key]')).toHaveCount(3);
});

test('快捷键图例是一排键帽，不是挤成一行的文字', async ({ page }) => {
    await page.locator('[data-probe-open="player-page-layout"]').click();
    const stage = page.locator('[data-testid="ponder-stage"]');
    await expect(stage).toBeVisible();

    const caps = stage.locator('[data-ponder-key-cap]');
    // ← → [ ] Space Esc 六个键帽，各自带说明。
    await expect(caps).toHaveCount(6);
    await expect(caps.first()).toHaveText('←');
    await expect(stage.locator('[data-ponder-key-combo]')).toHaveCount(4);
});

test('字幕会避开「本页可单独思索的组件」那张浮层卡', async ({ page }) => {
    // 卡是浮在骨架之上的，不在 rects 里；不显式交给摆位算法，字幕会被它盖掉半句。
    for (const probe of ['lattice-poster', 'player-page-layout']) {
        await page.locator(`[data-probe-open="${probe}"]`).click();
        const stage = page.locator('[data-testid="ponder-stage"]');
        await expect(stage).toBeVisible();
        await expect(stage.getByTestId('ponder-related-targets')).toBeVisible();

        for (let tick = 0; tick < 4; tick += 1) {
            await page.waitForTimeout(2200);
            const worst = await page.evaluate(() => {
                const card = document.querySelector('[data-testid="ponder-related-targets"]')?.getBoundingClientRect();
                if (!card) return 0;
                return Array.from(document.querySelectorAll('[data-testid="ponder-stage"] div'))
                    .filter(node => Number(getComputedStyle(node).opacity) > 0.4
                        && (node as HTMLElement).className.includes('rounded-lg px-3.5'))
                    .reduce((max, node) => {
                        const box = node.getBoundingClientRect();
                        const x = Math.max(0, Math.min(box.right, card.right) - Math.max(box.left, card.left));
                        const y = Math.max(0, Math.min(box.bottom, card.bottom) - Math.max(box.top, card.top));
                        return Math.max(max, x * y);
                    }, 0);
            });
            expect(worst, `${probe} 的字幕压到了浮层卡上`).toBe(0);
        }
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
    }
});

test('Lattice 展开卡片的控制条：中间两个就是底栏那两个槽位', async ({ page }) => {
    await page.locator('[data-probe-open="lattice-chrome-slots"]').click();
    const stage = page.locator('[data-testid="ponder-stage"]');
    await expect(stage).toBeVisible();
    await settled(stage);

    // 两端固定是上一首/下一首，中间两个才是可配置的那一对。
    await expectAligned(stage, 'prev', '[data-ponder-chrome-prev]');
    await expectAligned(stage, 'slotPrimary', '[data-ponder-chrome-slot-primary]');
    await expectAligned(stage, 'slotSecondary', '[data-ponder-chrome-slot-secondary]');
    await expectAligned(stage, 'next', '[data-ponder-chrome-next]');

    // 换掉底栏槽位之后，卡片里那一个跟着换 —— 替换层落在同一个位置上。
    await expect(stage.locator('[data-ponder-surface-state="slots-swapped"]')).toHaveCSS('opacity', '1', { timeout: 8000 });
    await expectAligned(stage, 'slotPrimary', '[data-ponder-chrome-slot-primary-swapped]');
});

test('卡片滚出视口，底栏顶上来并把卡片带走', async ({ page }) => {
    await page.locator('[data-probe-open="lattice-chrome-bar"]').click();
    const stage = page.locator('[data-testid="ponder-stage"]');
    await expect(stage).toBeVisible();

    await expect(stage.locator('[data-ponder-chrome-bottom-bar]')).toHaveCount(1);
    await expect(stage.locator('[data-ponder-surface-state="bottom-bar-shown"]')).toHaveCSS('opacity', '1', { timeout: 10000 });
    // 真实行为里这两者不会同框：海报离开视口，底栏才出现。
    await expect(stage.locator('[data-ponder-surface-state="base"]')).toHaveCSS('opacity', '0');
});

test('右侧面板：Tab 循环换页，四页各有一章', async ({ page }) => {
    await page.locator('[data-probe-open="side-panel-tabs"]').click();
    const stage = page.locator('[data-testid="ponder-stage"]');
    await expect(stage).toBeVisible();
    await expect(stage.getByText('6', { exact: false }).first()).toBeVisible();

    // Tab 往后一格：高亮从封面挪到控制。
    await expect(stage.locator('[data-ponder-surface-state="controls-tab"]')).toHaveCSS('opacity', '1', { timeout: 8000 });
    const activeIndex = await stage.locator('[data-ponder-surface-state="controls-tab"] [data-ponder-panel-tab]')
        .evaluateAll(nodes => nodes.findIndex(node => node.hasAttribute('data-active')));
    expect(activeIndex).toBe(1);

    // 四页各自预渲染在场，一页一章。
    for (const state of ['cover-tab', 'controls-tab', 'queue-tab', 'account-tab']) {
        await expect(stage.locator(`[data-ponder-surface-state="${state}"]`)).toHaveCount(1);
    }
});

test('设置里的歌词动画与配色两组各自能单独思索', async ({ page }) => {
    await page.locator('[data-probe-open="lyrics-animation"]').click();
    let stage = page.locator('[data-testid="ponder-stage"]');
    await expect(stage).toBeVisible();
    await settled(stage);
    await expectAligned(stage, 'entry', '[data-ponder-lyrics-animation-entry]');
    await expectAligned(stage, 'autoHide', '[data-ponder-lyrics-auto-hide]');
    // 点那一条打开的是调参台，不是又一屏设置。
    await expect(stage.locator('[data-ponder-lyrics-playground]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    await page.locator('[data-probe-open="theme-settings"]').click();
    stage = page.locator('[data-testid="ponder-stage"]');
    await expect(stage).toBeVisible();
    await settled(stage);
    await expectAligned(stage, 'presetDefault', '[data-ponder-theme-default]');
    await expectAligned(stage, 'presetCustom', '[data-ponder-theme-custom]');
    await expectAligned(stage, 'source', '[data-ponder-theme-source]');
    await expect(stage.locator('[data-ponder-theme-park-open]')).toHaveCount(1);
});

test('字幕底色不透明，且压在外框和浮层卡之上', async ({ page }) => {
    await page.locator('[data-probe-open="lattice-chrome-slots"]').click();
    const stage = page.locator('[data-testid="ponder-stage"]');
    await expect(stage).toBeVisible();

    const caption = stage.locator('div.rounded-lg.px-3\\.5').first();
    await expect(caption).toBeAttached();
    const look = await caption.evaluate(node => {
        const style = getComputedStyle(node);
        const layer = node.closest('[aria-hidden="true"]') as HTMLElement;
        return { background: style.backgroundColor, layerZ: layer ? getComputedStyle(layer).zIndex : null };
    });
    // 半透明会让压在底下的标题栏文字透上来，两段字叠成一团。
    expect(look.background).not.toMatch(/rgba\([^)]*,\s*0?\.\d+\s*\)/);
    // 外框和浮层卡都在它下面；字幕层自己 pointer-events-none，不挡点击。
    expect(Number(look.layerZ)).toBeGreaterThan(20);
    await expect(stage.getByTestId('ponder-related-targets')).toHaveCSS('z-index', '20');
});

test('字幕不落在上下两条外框上', async ({ page }) => {
    // 摆位算法把外框算成 reserved，但那是加权评分不是硬禁止 —— 权重给小了，
    // 「少盖住一点骨架」就会把字幕留在标题栏上，正是这条要挡住的。
    for (const probe of ['lattice-chrome-slots', 'player-page-layout', 'side-panel-queue']) {
        await page.locator(`[data-probe-open="${probe}"]`).click();
        const stage = page.locator('[data-testid="ponder-stage"]');
        await expect(stage).toBeVisible();

        for (let tick = 0; tick < 3; tick += 1) {
            await page.waitForTimeout(2200);
            const clashes = await page.evaluate(() => {
                const out: string[] = [];
                document.querySelectorAll('[data-testid="ponder-stage"] div').forEach(node => {
                    const el = node as HTMLElement;
                    if (!el.className.includes('rounded-lg') || !el.className.includes('px-3.5')) return;
                    if (Number(getComputedStyle(el).opacity) < 0.4) return;
                    const box = el.getBoundingClientRect();
                    const onTop = Math.max(0, Math.min(box.bottom, 84) - box.top);
                    const onBottom = Math.max(0, box.bottom - Math.max(box.top, innerHeight - 156));
                    if (onTop > 0 || onBottom > 0) out.push(el.innerText.slice(0, 16));
                });
                return out;
            });
            expect(clashes, `${probe} 的字幕压到了外框上`).toEqual([]);
        }
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
    }
});
