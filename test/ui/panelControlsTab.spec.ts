import { expect, test } from '@playwright/test';
import { APP_VERSION, GUIDE_VERSION_STORAGE_KEY } from './helpers/appState';

// test/ui/panelControlsTab.spec.ts
// 覆盖播放面板控制页的模式取景器：箭头步进、完整列表入口，以及步进经过商籁时不再被拦截。

const readVisualizerMode = (page: import('@playwright/test').Page) => page.evaluate(async () => {
    const storeModulePath = '/src/stores/useSettingsUiStore.ts';
    const { useSettingsUiStore } = await import(storeModulePath);
    return useSettingsUiStore.getState().visualizerMode as string;
});

const openControlsTab = async (page: import('@playwright/test').Page) => {
    await page.addInitScript(([version, guideKey]) => {
        localStorage.clear();
        localStorage.setItem('i18nextLng', 'zh-CN');
        localStorage.setItem('open_player_on_launch', 'true');
        localStorage.setItem('visualizer_mode', 'classic');
        localStorage.setItem('static_mode', 'true');
        localStorage.setItem(guideKey, version);
    }, [APP_VERSION, GUIDE_VERSION_STORAGE_KEY]);
    await page.route('**/__mock_netease__/**', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/');
    await page.waitForTimeout(2000);
    await page.locator('div.fixed.bottom-8.right-0 button').last().click();
    await page.waitForTimeout(500);
    await page.getByTitle('控制', { exact: true }).click();
    await page.waitForTimeout(600);
};

test('steps lyric modes with the arrows and opens the full list from the name', async ({ page }) => {
    await openControlsTab(page);
    expect(await readVisualizerMode(page)).toBe('classic');

    // 右箭头逐个前进：注册表顺序里 classic 的下一个。
    const lyricRow = page.locator('div.space-y-1 > div').first();
    await lyricRow.getByRole('button', { name: '歌词样式 +' }).click();
    await page.waitForTimeout(200);
    expect(await readVisualizerMode(page)).toBe('cadenza');

    // 左箭头回到原处。
    await lyricRow.getByRole('button', { name: '歌词样式 −' }).click();
    await page.waitForTimeout(200);
    expect(await readVisualizerMode(page)).toBe('classic');

    // 点名称展开完整列表，并且底部有「更多设置」入口。
    await lyricRow.getByRole('button', { name: '歌词样式', exact: true }).click();
    const list = page.getByRole('listbox', { name: '歌词样式' });
    await expect(list).toBeVisible();
    await expect(list.getByRole('option')).toHaveCount(11);
    await expect(page.getByText('更多设置', { exact: true })).toBeVisible();

    await list.getByRole('option', { name: '云阶' }).click();
    await page.waitForTimeout(200);
    expect(await readVisualizerMode(page)).toBe('partita');
});

test('steps straight through sonnet without an interstitial dialog', async ({ page }) => {
    await openControlsTab(page);
    await page.evaluate(async () => {
        const storeModulePath = '/src/stores/useSettingsUiStore.ts';
        const { useSettingsUiStore } = await import(storeModulePath);
        // 停在商籁前一格（注册表顺序里是镜台）。
        useSettingsUiStore.getState().handleSetVisualizerMode('diorama', { notify: false });
    });
    await page.waitForTimeout(300);

    const lyricRow = page.locator('div.space-y-1 > div').first();
    await lyricRow.getByRole('button', { name: '歌词样式 +' }).click();
    await page.waitForTimeout(400);

    expect(await readVisualizerMode(page)).toBe('sonnet');
    await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('closes the audio effect dialog with Escape', async ({ page }) => {
    await openControlsTab(page);

    await page.getByRole('button', { name: '打开音频均衡器' }).click();
    const equalizerTitle = page.getByText('音频效果器', { exact: true });
    await expect(equalizerTitle).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(equalizerTitle).toBeHidden();
});
