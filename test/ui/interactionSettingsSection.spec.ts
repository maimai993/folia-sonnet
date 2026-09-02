import { expect, test } from '@playwright/test';
import { APP_VERSION, GUIDE_VERSION_STORAGE_KEY } from './helpers/appState';

// test/ui/interactionSettingsSection.spec.ts
// 确认这一分区在侧栏里、在「控制」这一组下、点得进去，并且三项设置都真的渲染出来——
// 一个只在导航里存在、点进去什么都没有的分区，是很容易悄悄发出去的。

test('lists Interaction under Controls and opens it', async ({ page }) => {
    await page.addInitScript(([version, guideKey]) => {
        localStorage.clear();
        localStorage.setItem('i18nextLng', 'en');
        localStorage.setItem('static_mode', 'true');
        localStorage.setItem(guideKey, version);
    }, [APP_VERSION, GUIDE_VERSION_STORAGE_KEY]);
    await page.route('**/__mock_netease__/**', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.goto('/');
    await page.evaluate(async () => {
        const storeModulePath = '/src/stores/useSettingsModalStore.ts';
        const { useSettingsModalStore } = await import(storeModulePath);
        useSettingsModalStore.getState().openSettings('options');
    });

    await expect(page.getByText('Controls', { exact: true }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Interaction', exact: true }).first().click();

    await expect(page.getByRole('heading', { name: 'Interaction', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Filter search' })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Open the command palette with S on a grid' })).toBeVisible();
    await expect(page.getByLabel('Key')).toBeVisible();
    await expect(page.getByLabel('Runs')).toBeVisible();
});
