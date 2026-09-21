import { expect, test } from './fixtures';

// test/component/settingsHelpActions.spec.ts

test.beforeEach(async ({ mount }) => {
    await mount('settingsHelpActions');
});

test('版本更新按钮打开当前 release notes，并可关闭返回 Help', async ({ page }) => {
    await page.getByTestId('help-release-notes').click();
    await expect(page.getByTestId('release-notes-dialog')).toBeVisible();
    await page.getByTestId('release-notes-close').click();
    await expect(page.getByTestId('release-notes-dialog')).toHaveCount(0);
});

test('Help Ponder 按钮直接打开 help-page，而不是底下的 Grid 页面', async ({ page }) => {
    await page.getByTestId('help-page-ponder').click();
    await expect(page.getByTestId('ponder-stage')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Help page' })).toBeVisible();
});

test('Ctrl+G 在 Help 覆盖层中打开同一个 help-page', async ({ page }) => {
    await page.keyboard.press('Control+KeyG');
    await expect(page.getByTestId('ponder-stage')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Help page' })).toBeVisible();
});
