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

test('load 被外部资源阻塞时仍按 boot-ready 注入，晚到 load 不覆盖编辑', async ({ mount, page }) => {
    // 只让受控资源阻塞 load，排除真实字体网络的不确定性。
    await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
    await page.route('https://fonts.gstatic.com/**', route => route.abort());
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/__kinetic_pending_resource', async route => {
        await held;
        await route.fulfill({ status: 204, body: '' });
    });
    await page.route('**/jizura/editor.html', async route => {
        const response = await route.fetch();
        const html = (await response.text()).replace('</body>', '<img src="/__kinetic_pending_resource" hidden></body>');
        await route.fulfill({ response, body: html });
    });
    try {
        await mount('kineticIdentity');
        await open(page);
        await assertLyrics(page, 'Alpha');
        expect(await editorFrame(page).evaluate(() => document.readyState)).toBe('interactive');
        await editorFrame(page).evaluate(() => {
            (window as any).J.ui.project.seed = 456789;
            (window as any).J.uiApi.replan();
        });
        release();
        await expect.poll(() => editorFrame(page).evaluate(() => document.readyState)).toBe('complete');
        expect(await editorFrame(page).evaluate(() => (window as any).J.ui.project.seed)).toBe(456789);
        await assertLyrics(page, 'Alpha');
    } finally {
        release();
    }
});

test('稳定打开后随机/预览操作不能重启编辑台独立时钟', async ({ mount, page }) => {
    await mount('kineticIdentity');
    await open(page);
    await assertLyrics(page, 'Alpha');
    await page.waitForTimeout(3000); // 经过原有接管定时器，避免初始 pause 偶然掩盖 restartPreview。
    await editorFrame(page).evaluate(() => (window as any).J.uiApi.restartPreview());
    expect(await editorFrame(page).evaluate(() => (window as any).J.ui.playing)).toBe(false);
    await expect(page.locator('[data-probe-track]')).toHaveAttribute('data-probe-seek', '');
});

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

test('同歌手工改词后仍保存布局，并在重开时保留已归属的改词', async ({ mount, page }) => {
    await mount('kineticIdentity');
    await open(page);
    await assertLyrics(page, 'Alpha');
    const textarea = page.frameLocator('iframe[title="JIZURA 原版编辑台"]').locator('#lyrics');
    await textarea.fill('[00:01]Alpha edited！\n[00:12]Alpha final line');
    await expect.poll(() => editorFrame(page).evaluate(() => (window as any).J.ui.plan.lines[0].text)).toBe('Alpha edited！');
    await editorFrame(page).evaluate(() => { (window as any).J.ui.project.seed = 887766; (window as any).J.uiApi.replan(); });
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('kinetic_projects') || '{}')['online:netease:Alpha']?.project.seed)).toBe(887766);
    await page.getByRole('button', { name: '退出编辑台' }).click();
    await open(page);
    await expect(textarea).toHaveValue('[00:01]Alpha edited！\n[00:12]Alpha final line');
});

test('关闭时刷新尚在节流中的改词再保存最后快照', async ({ mount, page }) => {
    await mount('kineticIdentity');
    await open(page);
    await assertLyrics(page, 'Alpha');
    await expect.poll(() => page.evaluate(() => Boolean(JSON.parse(localStorage.getItem('kinetic_projects') || '{}')['online:netease:Alpha']))).toBe(true);
    // input 与关闭同一个浏览器任务，不给 replanSoon(260ms) 偷跑的机会。
    await page.evaluate(() => {
        const frame = document.querySelector('iframe[title="JIZURA 原版编辑台"]') as HTMLIFrameElement;
        const textarea = frame.contentDocument!.getElementById('lyrics') as HTMLTextAreaElement;
        textarea.value = '[00:04]Alpha distinct first line\n[00:18]Alpha final line';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        (document.querySelector('button[aria-label="退出编辑台"]') as HTMLButtonElement).click();
    });
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('kinetic_projects') || '{}')['online:netease:Alpha']?.project.lyrics)).toBe('[00:04]Alpha distinct first line\n[00:18]Alpha final line');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('kinetic_projects') || '{}')['online:netease:Alpha']?.project.plan.lines.map((line: any) => line.start))).toEqual([4, 18]);
});

test('歌词 pending 超过保存静默期也不能覆盖该歌改词存档', async ({ mount, page }) => {
    await mount('kineticIdentity');
    await page.evaluate(() => localStorage.setItem('kinetic_projects', JSON.stringify({
        'online:netease:Bravo': { at: 1, project: {
            sourceLyrics: '[00:01.00]Bravo distinct first line\n[00:12.00]Bravo final line',
            lyrics: '[00:01]Bravo edited！', seed: 12345,
        } },
    })));
    await selectTrack(page, 'Bravo', true);
    await open(page);
    await expect(page.frameLocator('iframe[title="JIZURA 原版编辑台"]').locator('#lyrics')).toHaveValue('');
    await page.waitForTimeout(3500);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('kinetic_projects') || '{}')['online:netease:Bravo'].project.lyrics)).toBe('[00:01]Bravo edited！');
    await selectTrack(page, 'Bravo');
    await expect(page.frameLocator('iframe[title="JIZURA 原版编辑台"]').locator('#lyrics')).toHaveValue('[00:01]Bravo edited！');
});

test('用户轻点同步启动宿主而不是编辑台预览时钟', async ({ mount, page }) => {
    await mount('kineticIdentity');
    await page.evaluate(() => {
        (window as any).__playingRequests = [];
        window.addEventListener('kinetic:toggle-play', (event: any) => (window as any).__playingRequests.push(event.detail.playing));
    });
    await open(page);
    await assertLyrics(page, 'Alpha');
    await page.frameLocator('iframe[title="JIZURA 原版编辑台"]').locator('#btnTap').click();
    await expect.poll(() => page.evaluate(() => (window as any).__playingRequests.at(-1))).toBe(true);
    expect(await editorFrame(page).evaluate(() => (window as any).J.ui.playing)).toBe(false);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('kinetic:time', { detail: { time: 2 } })));
    await page.frameLocator('iframe[title="JIZURA 原版编辑台"]').locator('#tapBtn').click();
    expect(await editorFrame(page).evaluate(() => (window as any).J.ui.project.timing.lineTimes[0])).toBe(2);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('kinetic:time', { detail: { time: 5 } })));
    await page.frameLocator('iframe[title="JIZURA 原版编辑台"]').locator('#tapBtn').click();
    expect(await editorFrame(page).evaluate(() => (window as any).J.ui.project.timing.lineTimes[1])).toBe(5);
});

test('暂停时编辑台跨句 seek 不启动播放页时钟', async ({ page }) => {
    await page.goto('http://127.0.0.1:4173/dev-probe.html?probe=kineticIdentity&render=1');
    await page.waitForSelector('[data-probe-track]');
    await page.evaluate(() => {
        (window as any).__seeks = [];
        const frame = document.querySelector('iframe[title="文字PV"]') as HTMLIFrameElement;
        frame.contentWindow!.addEventListener('message', event => {
            if (event.data?.type === 'seek') (window as any).__seeks.push(event.data);
        });
    });
    await open(page);
    await assertLyrics(page, 'Alpha');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('kinetic:seek', { detail: { time: 14 } })));
    await expect.poll(() => page.evaluate(() => (window as any).__seeks.at(-1)?.time)).toBe(14);
    expect(await page.evaluate(() => (window as any).__seeks.at(-1)?.playing)).toBe(false);
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
