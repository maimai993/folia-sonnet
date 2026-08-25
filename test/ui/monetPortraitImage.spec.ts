import { expect, test } from '@playwright/test';
import { openProbe } from './helpers/probe';

// test/ui/monetPortraitImage.spec.ts

test('异步封面 URL 到达时替换旧图片节点并显示新封面', async ({ page }) => {
    await openProbe(page, 'monetPortraitImage');

    const portrait = page.locator('[data-monet-portrait-image]');
    const initialNode = await portrait.elementHandle();
    await expect.poll(() => portrait.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Resolve cached cover' }).click();

    await expect.poll(() => initialNode?.evaluate(image => image.isConnected)).toBe(false);
    await expect.poll(() => portrait.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
});
