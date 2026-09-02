import { expect, test, type Page } from '@playwright/test';
import { installBaseState, localImportFixture, mockNeteaseApi, openApp } from './helpers/appFixtures';

// test/ui/gridCommandFilter.spec.ts
// 首页网格的「打字即筛选」现在由命令面板承担：网格只注册自己读键入，面板负责画框、
// 收字符、写回去。这条链路横跨 store 注册、inline 呈现和 portal 定位，单测覆盖不到接缝。

const filterBox = (page: Page) => page.getByTestId('command-palette-filter');
const filterInput = (page: Page) => filterBox(page).getByRole('combobox');
const trackCard = (page: Page) => page.getByText('Midnight Train');

/** 导入固件库，再打开其中一个合集——网格视图是在这一层才出现的。 */
const openTrackGrid = async (page: Page) => {
    await installBaseState(page, { neteaseMode: 'guest', localImportFixture });
    await mockNeteaseApi(page, 'guest');
    await openApp(page);

    await page.getByRole('button', { name: 'Folder' }).last().click();
    await page.getByRole('button', { name: 'Import Folder' }).last().click();
    await expect(page.getByText('All Songs').first()).toBeVisible();
    await page.getByRole('heading', { name: 'All Songs' }).first().click();
    await expect(trackCard(page).first()).toBeVisible();
};

/**
 * 网格的注册和面板的键盘监听都比首屏晚装上一拍，定长 sleep 只是赌它们已经就位。
 * 反复敲直到框真的出现——多敲进去的字符随后被 fill 覆盖。
 */
const typeUntilFilterOpens = async (page: Page, key: string) => {
    await expect.poll(async () => {
        await page.keyboard.press(key);
        return filterBox(page).count();
    }).toBeGreaterThan(0);
};

test('a printable character opens the palette as the grid filter box', async ({ page }) => {
    await openTrackGrid(page);

    await typeUntilFilterOpens(page, 'm');

    await expect(filterInput(page)).toBeFocused();
    // 触发的那一下是被刻意丢掉的：把它补进输入框，会在同一次按键正在启动的输入法
    // 组合前面塞一个多余的拉丁字符。网格自己的框当年就是为此吞掉第一个键的。
    await expect(filterInput(page)).toHaveValue('');
});

test('filters the grid as the listener types, and keeps the box up on Enter', async ({ page }) => {
    await openTrackGrid(page);
    await typeUntilFilterOpens(page, 'm');

    await filterInput(page).fill('nothing matches this');
    await expect(trackCard(page)).toHaveCount(0);

    // Enter 在网格自己的框里也是被吞掉的：关掉框就等于筛过的网格上没有任何说明。
    await page.keyboard.press('Enter');
    await expect(filterBox(page)).toBeVisible();
    await expect(trackCard(page)).toHaveCount(0);
});

test('the primary modifier and F opens it, and Escape puts the grid back', async ({ page }) => {
    await openTrackGrid(page);

    await typeUntilFilterOpens(page, 'ControlOrMeta+f');
    await filterInput(page).fill('nothing matches this');
    await expect(trackCard(page)).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(filterBox(page)).toBeHidden();
    await expect(trackCard(page).first()).toBeVisible();
});

test('a bare key that is a palette shortcut elsewhere still filters here', async ({ page }) => {
    await openTrackGrid(page);

    // ':' 在播放页是执行模式的入口。网格上读键入的一方优先，否则同一次按键会同时做两件事。
    await typeUntilFilterOpens(page, ':');

    await expect(page.getByTestId('command-palette-panel')).toHaveCount(0);
});

test('gives the keyboard back when the grid is left', async ({ page }) => {
    await openTrackGrid(page);
    await typeUntilFilterOpens(page, 'm');
    await page.keyboard.press('Escape');
    await expect(filterBox(page)).toBeHidden();

    // 第二下 Escape 落到网格自己的返回梯子上——筛选已清空，所以直接退出这一层。
    await page.keyboard.press('Escape');
    await expect(trackCard(page)).toHaveCount(0);
    await page.keyboard.press('m');
    await page.waitForTimeout(500);

    // 首页那层没有注册筛选，单字符不该再把框拉起来。
    await expect(filterBox(page)).toBeHidden();
});
