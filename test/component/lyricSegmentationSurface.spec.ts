import { expect, test } from './fixtures';

// test/component/lyricSegmentationSurface.spec.ts
// 命令面板 body 的高度是一条硬契约（见 test/ui/commandPaletteSizing.spec.ts）。歌词分词面板是
// 唯一内容长度跟歌词走、没有上限的新 surface，所以这里单独把「装满也撑不开」量出来。
//
// 走组件探针而不是整应用：整应用的夹具只塞了歌曲，没有已加载的歌词，那条路径量到的是空态。

const body = '[data-probe-body]';

test('预览再长也不会撑开固定高度的 body', async ({ mount, page }) => {
    const component = await mount('lyricSegmentationSurface');
    await expect(component.getByRole('button', { name: 'Copy prompt' })).toBeVisible();

    const box = await page.locator(body).boundingBox();
    expect(box).not.toBeNull();

    // 盒子自身钉在 min(496px, 50vh)。
    const viewportHeight = page.viewportSize()!.height;
    expect(Math.round(box!.height)).toBe(Math.min(496, Math.round(viewportHeight / 2)));

    // 而且它自己不滚动：滚动发生在内部那一层，否则动作行和导入框会被推出视野。
    const scroll = await page.locator(body).evaluate(node => ({
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
    }));
    expect(scroll.scrollHeight).toBe(scroll.clientHeight);
});

test('AI 跑完后按钮回到可用状态，不会永远转圈', async ({ mount, page }) => {
    // 探针页开着 StrictMode，effect 会 mount → cleanup → mount。isMountedRef 的 setup 一旦漏掉
    // 重新置 true，cleanup 写下的 false 就会伴随组件整个生命周期，于是进度不动、结果不保存、
    // finally 也不复位——按钮永远停在「取消 · Ns」。这条就是钉住那个失效模式。
    //
    // 探针没有 electron bridge，所以走 /api/segment-lyrics，probe 服务器上没有这条路由，
    // 每批都会快速失败。失败与否不重要，重要的是跑完之后按钮必须回到初始态。
    const component = await mount('lyricSegmentationSurface');
    const aiButton = component.getByRole('button', { name: /Segment with AI|Cancel/ });
    await expect(aiButton).toHaveText(/Segment with AI/);

    await aiButton.click();

    // 转圈期间标签是「Cancel · Ns」；结束后必须变回去。
    await expect(aiButton).toHaveText(/Segment with AI/, { timeout: 30_000 });
    await expect(aiButton).toBeEnabled();
    // 全部批次失败时要给出错误，而不是静默什么都不做。
    await expect(page.locator('[data-probe-body] .text-red-400')).toBeVisible();
});

test('动作行始终留在视野里，滚动只发生在预览区', async ({ mount, page }) => {
    const component = await mount('lyricSegmentationSurface');
    await expect(component.getByRole('button', { name: 'Segment with AI' })).toBeVisible();

    const preview = page.locator(`${body} .overflow-y-auto`).last();
    const scrolled = await preview.evaluate(node => {
        node.scrollTop = node.scrollHeight;
        return { top: node.scrollTop, overflowing: node.scrollHeight > node.clientHeight };
    });

    expect(scrolled.overflowing, '探针有 60 行，预览区必须溢出才谈得上滚动').toBe(true);
    expect(scrolled.top).toBeGreaterThan(0);
    await expect(component.getByRole('button', { name: 'Segment with AI' })).toBeVisible();
    await expect(component.getByRole('button', { name: 'Restore default' })).toBeVisible();
});
