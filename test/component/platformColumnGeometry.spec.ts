import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

// test/component/platformColumnGeometry.spec.ts
// 登录窗口平台清单的高亮块：它该盖住哪一行，滚动、改窗口宽度、悬停、点一下之后还对不对得上，
// 以及这几件事有没有把量到的像素写回 React state（提交次数不跟着几何走）。
// 行由 dev/probes/platformColumn.probe.tsx 现编，没有账号、没有请求。

type Counters = { commits: number; phases: string[]; chooses: string[]; lie: string };

const readCounters = (page: Page): Promise<Counters | null> => page.evaluate(() => {
    const api = (window as unknown as { __platformColumnProbe?: { commits: number; phases: readonly string[]; chooses: readonly string[]; lie: string } }).__platformColumnProbe;
    return api ? { commits: api.commits, phases: [...api.phases], chooses: [...api.chooses], lie: api.lie } : null;
});

const resetCounters = (page: Page): Promise<void> => page.evaluate(() => {
    (window as unknown as { __platformColumnProbe?: { reset(): void } }).__platformColumnProbe?.reset();
});

const stage = (page: Page) => page.locator('[data-probe-stage]');
const listbox = (page: Page) => stage(page).locator('[role="listbox"]');
const decoration = (page: Page) => page.locator('[data-login-highlight]');
const row = (page: Page, id: string) => stage(page).locator(`[data-row="${id}"]`);
const idOf = (index: number) => `probe-platform-${index}`;

/** 高亮和它该盖住的那一行差多少（px）：位置和大小各算一个数。 */
const gapTo = async (page: Page, rowId: string) => {
    const [box, target] = await Promise.all([decoration(page).boundingBox(), row(page, rowId).boundingBox()]);
    if (!box || !target) throw new Error(`highlight=${JSON.stringify(box)} row=${JSON.stringify(target)}`);
    return {
        max: Math.max(Math.abs(box.x - target.x), Math.abs(box.y - target.y), Math.abs(box.width - target.width), Math.abs(box.height - target.height)),
        box,
        target,
    };
};

/** 等它落定（高亮带着 transition），再要求它和那一行对齐到 1px 以内。 */
const expectOnRow = async (page: Page, rowId: string, tolerance = 1) => {
    await expect.poll(async () => (await gapTo(page, rowId)).max, {
        message: `highlight should cover ${rowId}`,
        timeout: 5_000,
    }).toBeLessThanOrEqual(tolerance);
};

/** 先等提交安静下来：挂载后语言资源之类的异步更新会晚到一步，不先等它们，计数就没法归到这一次动作上。 */
const quiesce = async (page: Page) => {
    await expect.poll(async () => {
        const first = (await readCounters(page))?.commits ?? 0;
        await page.waitForTimeout(250);
        return ((await readCounters(page))?.commits ?? 0) - first;
    }, { timeout: 10_000, intervals: [300] }).toBe(0);
};

const mountProbe = async (mount: (story: string, props?: Record<string, unknown>) => Promise<Locator>, props: Record<string, unknown> = {}) => {
    const root = await mount('platformColumn', { count: 8, ...props });
    await expect(root.locator('[role="listbox"]')).toBeVisible();
    return root;
};

/** 这一块装饰不属于滚动内容：不在 listbox 里，被一个 overflow 裁切的框扣着。 */
const whereDecoration = (page: Page) => page.evaluate(() => {
    const box = document.querySelector('[data-probe-stage] [role="listbox"]');
    const all = [...document.querySelectorAll('[data-probe-stage] [data-login-highlight]')];
    const clip = all.length === 1 ? all[0].parentElement : null;
    return {
        count: all.length,
        insideListbox: box ? box.contains(all[0] ?? box) : null,
        clipIsListbox: clip === box,
        clipOverflow: clip ? getComputedStyle(clip).overflow : null,
    };
});

test.describe('[platformColumn] 高亮块的几何', () => {
    test('竖着那一列：高亮在滚动内容之外，盖住选中的那一行', async ({ mount, page }) => {
        await mountProbe(mount, { lie: 'column', chosen: idOf(6) });
        const where = await whereDecoration(page);
        expect(where.count).toBe(1);
        expect(where.insideListbox).toBe(false);
        expect(where.clipIsListbox).toBe(false);
        expect(where.clipOverflow).toBe('hidden');
        await expect(decoration(page)).toHaveCSS('opacity', '1');
        await expectOnRow(page, idOf(6));
    });

    test.describe('横着那一排', () => {
        test.use({ viewport: { width: 900, height: 900 } });

        test('滚动之后高亮跟着那一行走，再多滚几次也不再提交', async ({ mount, page }) => {
            await mountProbe(mount, { lie: 'row', chosen: idOf(5) });
            await expectOnRow(page, idOf(5));
            await quiesce(page);
            await resetCounters(page);
            const scrollable = await listbox(page).evaluate(node => ({ width: node.clientWidth, content: node.scrollWidth }));
            expect(scrollable.content).toBeGreaterThan(scrollable.width);
            const step = Math.min(40, scrollable.content - scrollable.width);
            const scrollTo = async (left: number) => {
                await listbox(page).evaluate((node, to) => { node.scrollLeft = to; node.dispatchEvent(new Event('scroll', { bubbles: true })); }, left);
                await expect.poll(() => listbox(page).evaluate(node => node.scrollLeft)).toBe(left);
                await expectOnRow(page, idOf(5));
            };
            await scrollTo(step);
            await scrollTo(step * 2);
            // 滚到头会换边缘淡出的状态（那是 React state，不是几何）；几何本身不该带出 nested-update。
            expect((await readCounters(page))?.phases.filter(phase => phase === 'nested-update')).toEqual([]);
        });
    });

    test('窗口变宽变窄：行宽变了，高亮跟上，提交次数不变', async ({ mount, page }) => {
        await mountProbe(mount, { lie: 'column', chosen: idOf(3) });
        await expectOnRow(page, idOf(3));
        await quiesce(page);
        const before = await readCounters(page);
        const narrowRow = await row(page, idOf(3)).boundingBox();
        await page.setViewportSize({ width: 1000, height: 900 });
        await expect.poll(async () => (await row(page, idOf(3)).boundingBox())?.width, { timeout: 5_000 }).not.toBe(narrowRow?.width);
        await expectOnRow(page, idOf(3));
        await expect.poll(async () => (await readCounters(page))?.commits).toBe(before?.commits);
    });

    test('悬停到另一行：高亮跟过去，而且量到的像素没有写回 state', async ({ mount, page }) => {
        await mountProbe(mount, { lie: 'column', chosen: idOf(6) });
        await expectOnRow(page, idOf(6));
        await quiesce(page);
        await resetCounters(page);
        for (const index of [2, 4]) {
            const box = (await row(page, idOf(index)).boundingBox())!;
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await expectOnRow(page, idOf(index));
        }
        // React 把「在 effect 里跟着同一次提交再 setState」记成 nested-update：旧实现在这里就是它。
        expect((await readCounters(page))?.phases.filter(phase => phase === 'nested-update')).toEqual([]);
    });

    test('键盘方向键把高亮往下挪一行，它跟着走', async ({ mount, page }) => {
        await mountProbe(mount, { lie: 'column', chosen: idOf(2) });
        await expectOnRow(page, idOf(2));
        await listbox(page).focus();
        await page.keyboard.press('ArrowDown');
        await expectOnRow(page, idOf(3));
    });

    test('卸掉再挂上：只剩一个高亮，位置仍然对，ResizeObserver 都关了', async ({ mount, page }) => {
        await page.addInitScript(() => {
            const Real = window.ResizeObserver;
            const state = { created: 0, live: 0 };
            (window as unknown as { __roState: typeof state }).__roState = state;
            class Counted extends Real {
                constructor(callback: ResizeObserverCallback) { super(callback); state.created += 1; state.live += 1; }
                override disconnect(): void { state.live -= 1; super.disconnect(); }
            }
            window.ResizeObserver = Counted as unknown as typeof ResizeObserver;
        });
        await mountProbe(mount, { lie: 'column', chosen: idOf(4) });
        await expectOnRow(page, idOf(4));
        await page.evaluate(() => window.unmount());
        await expect(decoration(page)).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => (window as unknown as { __roState: { live: number } }).__roState.live)).toBe(0);
        await page.evaluate(() => window.mount({ story: 'platformColumn', props: { count: 8, lie: 'column', chosen: 'probe-platform-4' } }));
        await expect(decoration(page)).toHaveCount(1);
        await expectOnRow(page, idOf(4));
    });
});

test.describe('[platformColumn] 触控', () => {
    test.use({ hasTouch: true, viewport: { width: 900, height: 900 } });

    test('点一行就选中它，高亮落到那一行上', async ({ mount, page }) => {
        await mountProbe(mount, { lie: 'column', chosen: idOf(1) });
        await expectOnRow(page, idOf(1));
        const box = (await row(page, idOf(3)).boundingBox())!;
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        await expect.poll(async () => (await readCounters(page))?.chooses).toEqual([idOf(3)]);
        await expectOnRow(page, idOf(3));
    });
});
