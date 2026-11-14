import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

// test/component/searchScrollBar.spec.ts
// 搜索页：往下滚时底部播放条整条收到屏幕外，往上滚回到原位；「加载更多」是列表的最后一行。
// 见 dev/probes/searchScrollBar.probe.tsx：探针接的是产品代码的滚动方向判定与接线。

const BAR = '[data-ponder="player-bar"]';
const PROBE_ROOT = '[data-probe-bar-hidden]';
const LIST = '.custom-scrollbar';

/** 等收起状态的标志翻值：探针把它镜像到 data 属性上，比等动画更稳。 */
const expectBarHidden = async (page: Page, hidden: boolean) => {
    await expect(page.locator(PROBE_ROOT)).toHaveAttribute('data-probe-bar-hidden', hidden ? '1' : '0');
    // 0.26s 的位移过渡，等它走完再量位置。
    await page.waitForTimeout(500);
};

test.describe('search results scroll hides the bottom bar', () => {
    // 手机竖屏：胶囊正好压在搜索页底下那条列表上，也是这个改动针对的档位。
    test.use({ viewport: { width: 390, height: 844 } });

    test('slides the bar out on the way down and back on the way up', async ({ mount, page }) => {
        await mount('searchScrollBar');

        const bar = page.locator(BAR);
        await expect(bar).toBeVisible();
        const shownBox = (await bar.boundingBox())!;
        expect(shownBox.y + shownBox.height).toBeLessThanOrEqual(844);

        const loadMore = page.getByRole('button', { name: /加载更多|Load more/i });
        const list = page.locator(LIST);

        // 下方这块现在整块都是列表：底下没有一条常驻的页脚把它压短。
        const listBox = (await list.boundingBox())!;
        expect(844 - (listBox.y + listBox.height)).toBeLessThanOrEqual(24);

        // 「加载更多」是列表的最后一行：列表还在顶上时它在视口外，压根没渲染。
        await expect(loadMore).toHaveCount(0);

        // 往下滚：胶囊整条落到视口下面。
        await page.mouse.move(195, 360);
        await page.mouse.wheel(0, 600);
        await expectBarHidden(page, true);
        const hiddenBox = (await bar.boundingBox())!;
        expect(hiddenBox.y).toBeGreaterThanOrEqual(844);

        // 滚到列表末尾：这一行跟着结果滚上来，而且不能有东西压在它上面。
        await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
        await expect(loadMore).toBeVisible();
        const loadMoreBox = (await loadMore.boundingBox())!;
        expect(loadMoreBox.y + loadMoreBox.height).toBeLessThanOrEqual(844);
        const reachable = await loadMore.evaluate((element, point) => {
            const hit = document.elementFromPoint(point.x, point.y);
            return Boolean(hit && (hit === element || element.contains(hit)));
        }, { x: loadMoreBox.x + loadMoreBox.width / 2, y: loadMoreBox.y + loadMoreBox.height / 2 });
        expect(reachable).toBe(true);

        // 往上滚：回到原来那条基线上，而且中途不许往回掉。
        //
        // 「往回掉」曾经真的发生过：胶囊的 layout 按视口量位置，外层一有 y 位移就被当成
        // 「胶囊自己挪了」，于是它同时往下弹 —— 整条先栽出屏幕再弹回来，就是用户看到的那一下抽搐。
        // 这里逐帧采样，只在真的没有反向位移时才算过。
        const samples = page.evaluate(() => new Promise<number[]>((resolve) => {
            const capsule = document.querySelector('[data-ponder="player-bar"]')!;
            const ys: number[] = [];
            const start = performance.now();
            const tick = () => {
                ys.push(capsule.getBoundingClientRect().y);
                if (performance.now() - start < 900) requestAnimationFrame(tick);
                else resolve(ys);
            };
            requestAnimationFrame(tick);
        }));
        await page.mouse.wheel(0, -2000);
        const ys = await samples;
        expect(ys.length).toBeGreaterThan(5);
        const worstDrop = Math.max(...ys.map((y, index) => (index === 0 ? 0 : y - ys[index - 1])));
        expect(worstDrop).toBeLessThan(2);

        await expectBarHidden(page, false);
        const backBox = (await bar.boundingBox())!;
        expect(Math.abs(backBox.y - shownBox.y)).toBeLessThan(2);
    });
});
