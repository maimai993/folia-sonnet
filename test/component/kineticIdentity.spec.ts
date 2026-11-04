import type { Page } from '@playwright/test';
import { test, expect } from '@playwright/test';

// 真实编辑台 API 的位置与 boot 时序只能用浏览器验证，不能用仿造 J.ui.uiApi 的桩。
test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        // iframe 与宿主共享 origin；不能在每个子文档导航时清掉工程。
        if (window === window.top) localStorage.clear();
        localStorage.setItem('jizura.tourDone', '1');
    });
});
const editorFrame = (page: Page) => page.frames().find(frame => frame.url().includes('/jizura/editor.html'))!;
const selectTrack = async (page: Page, name: string, pending = false) => {
    await page.evaluate(detail => window.dispatchEvent(new CustomEvent('probe:kinetic-track', { detail })), { name, pending });
};
const open = async (page: Page) => {
    await page.evaluate(() => window.dispatchEvent(new Event('kinetic:open-editor')));
};
const assertLyrics = async (page: Page, track: string) => {
    await expect(page.frameLocator('iframe[title="JIZURA 原版编辑台"]').locator('#lyrics')).toHaveValue(new RegExp(`${track} distinct first line`));
    await expect.poll(() => editorFrame(page).evaluate(() =>
        (window as any).J?.ui?.plan?.lines?.map((line: any) => line.text).join('\n'),
    )).toContain(`${track} distinct first line`);
};

test('首次打开、歌词晚到与快速 A→B→A 同时更新 textarea 和 plan', async ({ mount, page }) => {
    await mount('kineticIdentity');
    await open(page);
    await assertLyrics(page, 'Alpha');
    await selectTrack(page, 'Bravo', true);
    await expect(page.frameLocator('iframe[title="JIZURA 原版编辑台"]').locator('#lyrics')).toHaveValue('');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('kinetic:time', { detail: { time: 8 } })));
    await selectTrack(page, 'Bravo');
    await assertLyrics(page, 'Bravo');
    await expect.poll(() => editorFrame(page).evaluate(() => (window as any).J.ui.t)).toBeCloseTo(8, 1);
    await selectTrack(page, 'Alpha');
    await selectTrack(page, 'Bravo');
    await selectTrack(page, 'Alpha');
    await assertLyrics(page, 'Alpha');
    await expect(page.locator('[data-probe-track]')).toHaveAttribute('data-probe-seek', '');
});

test('旧存档 plan 不覆盖新词，最后一次编辑在关闭时保存并可重开', async ({ mount, page }) => {
    await mount('kineticIdentity');
    await page.evaluate(() => localStorage.setItem('kinetic_projects', JSON.stringify({
        'online:netease:Alpha': { at: 1, project: { seed: 123, lyrics: '[00:01]obsolete', plan: { lines: [{ text: 'obsolete' }], cuts: [], W: 1920, H: 1080 } } },
    })));
    await open(page);
    await assertLyrics(page, 'Alpha');
    await expect.poll(() => page.evaluate(() => {
        const project = JSON.parse(localStorage.getItem('kinetic_projects') || '{}')['online:netease:Alpha']?.project;
        return project?.plan?.lines?.map((line: any) => line.text).join('\n');
    })).toContain('Alpha distinct first line');
    // 等首份快照后，改 seed 并立即退出，必须由退出快照而不是下一个 500ms 轮询保存。
    await editorFrame(page).evaluate(() => { (window as any).J.ui.project.seed = 987654; (window as any).J.uiApi.replan(); });
    await page.getByRole('button', { name: '退出编辑台' }).click();
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('kinetic_projects') || '{}')['online:netease:Alpha']?.project.seed)).toBe(987654);
    await open(page);
    await assertLyrics(page, 'Alpha');
    expect(await editorFrame(page).evaluate(() => (window as any).J.ui.project.seed)).toBe(987654);
});

test('同歌保存后 viewport 重发使用新工程，旧歌广播不能污染当前歌', async ({ page }) => {
    await page.goto('http://127.0.0.1:4173/dev-probe.html?probe=kineticIdentity&render=1');
    await page.waitForSelector('[data-probe-track]');
    await page.evaluate(() => {
        (window as any).__projects = [];
        const frame = document.querySelector('iframe[title="文字PV"]') as HTMLIFrameElement;
        frame.contentWindow!.addEventListener('message', event => {
            if (event.data?.type === 'project') (window as any).__projects.push(event.data);
        });
    });
    await open(page);
    await assertLyrics(page, 'Alpha');
    await editorFrame(page).evaluate(() => { (window as any).J.ui.project.seed = 424242; (window as any).J.uiApi.replan(); });
    await expect.poll(() => page.evaluate(() => (window as any).__projects.at(-1)?.project.seed)).toBe(424242);
    await page.getByRole('button', { name: '退出编辑台' }).click();
    await page.setViewportSize({ width: 1300, height: 900 });
    await expect.poll(() => page.evaluate(() => (window as any).__projects.at(-1)?.project.seed)).toBe(424242);
    await selectTrack(page, 'Bravo');
    await expect.poll(() => page.evaluate(() => (window as any).__projects.at(-1)?.project.lyrics)).toContain('Bravo');
    await page.evaluate(async () => {
        const channel = new BroadcastChannel('kinetic-project');
        channel.postMessage({ type: 'project', songKey: 'online:netease:Alpha', project: { lyrics: 'obsolete', seed: -1 } });
        await new Promise(resolve => setTimeout(resolve, 100));
        channel.close();
    });
    expect(await page.evaluate(() => (window as any).__projects.at(-1)?.project.lyrics)).toContain('Bravo');
});

test('暂停时 timeline 的真实操作能同步，程序性 seek 不回写播放器', async ({ mount, page }) => {
    await mount('kineticIdentity');
    await open(page);
    await assertLyrics(page, 'Alpha');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('kinetic:time', { detail: { time: 10 } })));
    await expect.poll(() => editorFrame(page).evaluate(() => (window as any).J.ui.t)).toBeCloseTo(10, 1);
    await editorFrame(page).evaluate(() => (window as any).J.uiApi.seek(0.38));
    await expect(page.locator('[data-probe-track]')).toHaveAttribute('data-probe-seek', '');
    const timeline = page.frameLocator('iframe[title="JIZURA 原版编辑台"]').locator('#timeline');
    const size = await timeline.boundingBox();
    // 顶部第一行手柄只改行时间，不能发宿主 seek。
    const handle = await editorFrame(page).evaluate(() => {
        const ui = (window as any).J.ui;
        return ui.plan.lines[0].start / ui.plan.duration;
    });
    await timeline.click({ position: { x: size!.width * handle, y: 3 } });
    await expect(page.locator('[data-probe-track]')).toHaveAttribute('data-probe-seek', '');
    await timeline.click({ position: { x: size!.width * 0.7, y: size!.height * 0.8 } });
    await expect(page.locator('[data-probe-track]')).not.toHaveAttribute('data-probe-seek', '');
    const firstSeek = await page.locator('[data-probe-track]').getAttribute('data-probe-seek');
    // range input 覆盖键盘/触摸控件路径，程序性 seek 不产生这个 input 事件。
    await editorFrame(page).evaluate(() => {
        const scrub = document.getElementById('scrub') as HTMLInputElement;
        scrub.value = '3000';
        scrub.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('[data-probe-track]')).not.toHaveAttribute('data-probe-seek', firstSeek!);
});
