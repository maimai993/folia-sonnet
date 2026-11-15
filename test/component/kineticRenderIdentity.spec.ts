import { test, expect } from './fixtures';

// 真实渲染文档采用编辑台 plan 后切歌，不能因 sharedPlan 而永久忽略新 project。
test('采用 A 的 plan 后 B 工程必须换词，旧 A plan 不得覆盖 B', async ({ page }) => {
    await page.goto('http://127.0.0.1:4173/jizura/render.html');
    await page.waitForFunction(() => Boolean((window as any).J?.Renderer));
    await page.evaluate(() => {
        const w = window as any;
        const original = w.J.Renderer.prototype.frame;
        w.J.Renderer.prototype.frame = function(ctx: unknown, plan: any, ...rest: unknown[]) {
            w.__drawnLines = plan.lines.map((line: any) => line.text).join('\n');
            w.__drawnStarts = plan.lines.map((line: any) => line.start);
            return original.call(this, ctx, plan, ...rest);
        };
        w.__project = (name: string) => ({ lyrics: `[00:01]${name} distinct first line`, fonts: {}, seed: 123 });
        w.__send = (type: string, data: object) => window.postMessage({ target: 'jizura-render', type, ...data }, '*');
        w.__send('project', { project: w.__project('Alpha'), songKey: 'a', playing: false });
    });
    await expect.poll(() => page.evaluate(() => (window as any).__drawnLines)).toContain('Alpha');
    await page.evaluate(() => {
        const w = window as any;
        const project = Object.assign(w.J.defaultProject(), w.__project('Alpha'), { aspect: '4:3', res: 540 });
        w.__plan = w.J.plan(project, null);
        // 让该测试只验证身份，不受历史比例政策干扰。
        w.__plan.W = innerWidth; w.__plan.H = innerHeight;
        w.__send('plan', { plan: w.__plan, songKey: 'a' });
    });
    await expect.poll(() => page.evaluate(() => (window as any).__drawnLines)).toContain('Alpha');
    await page.evaluate(() => {
        const w = window as any;
        w.__send('project', { project: { ...w.__project('Alpha'), lyrics: '[00:04]Alpha distinct first line', sourceLyrics: '[00:04]Alpha distinct first line' }, songKey: 'a' });
    });
    await expect.poll(() => page.evaluate(() => (window as any).__drawnStarts[0])).toBe(4);
    await page.evaluate(() => (window as any).__send('plan', { plan: (window as any).__plan, songKey: 'a', sourceLyrics: '[00:01]Alpha distinct first line' }));
    await expect.poll(() => page.evaluate(() => (window as any).__drawnStarts[0])).toBe(4);
    await page.evaluate(() => (window as any).__send('project', { project: (window as any).__project('Bravo'), songKey: 'b', playing: false }));
    await expect.poll(() => page.evaluate(() => (window as any).__drawnLines)).toContain('Bravo');
    await page.evaluate(() => (window as any).__send('plan', { plan: (window as any).__plan, songKey: 'a' }));
    await expect.poll(() => page.evaluate(() => (window as any).__drawnLines)).toContain('Bravo');
});
