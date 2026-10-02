import { expect, test, type Page } from '@playwright/test';
import { installBaseState, localImportFixture, mockNeteaseApi, openApp } from './helpers/appFixtures';

// test/ui/libraryRendererSwitch.spec.ts
// 完整应用里的 renderer 切换（开发版浮层）。行为探针已经在假宿主里把两套 UI 的语义对齐了；
// 这里只验证探针覆盖不到的那一层：真实 App 的装配——浮层出现在哪、TUI 经由真实的播放端口把歌
// 交给真实的播放控制器、命令面板的筛选与 --play 在 TUI 上同样生效。

const filterBox = (page: Page) => page.getByTestId('command-palette-filter');
const filterInput = (page: Page) => filterBox(page).getByRole('combobox');
const rendererSwitch = (page: Page) => page.getByTestId('dev-library-renderer-switch');
const tui = (page: Page) => page.locator('[data-library-renderer="tui"]');
const grid = (page: Page) => page.locator('[data-library-renderer="grid"]');

const openAllSongs = async (page: Page) => {
    await installBaseState(page, { neteaseMode: 'guest', localImportFixture });
    await mockNeteaseApi(page, 'guest');
    await openApp(page);

    await page.getByRole('button', { name: 'Folder' }).last().click();
    await page.getByRole('button', { name: 'Import Folder' }).last().click();
    await expect(page.getByText('All Songs').first()).toBeVisible();
    await expect(rendererSwitch(page)).toHaveCount(0);
    await page.getByRole('heading', { name: 'All Songs' }).first().click();
    await expect(grid(page)).toHaveCount(1);
    await expect(page.getByText('Midnight Train').first()).toBeVisible();
};

const switchTo = async (page: Page, renderer: 'grid' | 'tui') => {
    await rendererSwitch(page).locator(`[data-renderer="${renderer}"]`).click();
};

const playbackSnapshot = async (page: Page) => page.evaluate(async () => {
    const storeModulePath = '/src/stores/usePlaybackStore.ts';
    const { usePlaybackStore } = await import(/* @vite-ignore */ storeModulePath);
    const state = usePlaybackStore.getState();
    return { queueLength: state.playQueue.length, currentSongName: state.currentSong?.name ?? null };
});

/** 与网格同一个做法：网格 / 列表的注册比首屏晚一拍，反复敲到筛选框真的出现。 */
const typeUntilFilterOpens = async (page: Page, key: string) => {
    await expect.poll(async () => {
        await page.keyboard.press(key);
        return filterBox(page).count();
    }).toBeGreaterThan(0);
};

test('the DEV switch moves the open collection into the TUI and back', async ({ page }) => {
    await openAllSongs(page);

    await switchTo(page, 'tui');
    await expect(tui(page)).toHaveCount(1);
    await expect(grid(page)).toHaveCount(0);
    await expect(tui(page).locator('[data-tui-title]')).toHaveText('All Songs');
    await expect(tui(page).locator('[data-tui-row="0"]')).toContainText('Midnight Train');
    await expect(tui(page).locator('[data-tui-row="0"]')).toHaveAttribute('aria-selected', 'true');

    await switchTo(page, 'grid');
    await expect(grid(page)).toHaveCount(1);
    await expect(tui(page)).toHaveCount(0);
    await expect(page.getByText('Midnight Train').first()).toBeVisible();
});

test('typing filters the TUI through the command palette, and --play reaches the real player', async ({ page }) => {
    await openAllSongs(page);
    await switchTo(page, 'tui');
    await expect(tui(page)).toHaveCount(1);

    await typeUntilFilterOpens(page, 'm');
    await filterInput(page).fill('midnight --play');
    await expect(tui(page).locator('[data-tui-filter]')).toContainText('midnight');
    await page.keyboard.press('Enter');

    await expect.poll(async () => (await playbackSnapshot(page)).currentSongName).toBe('Midnight Train');
    expect((await playbackSnapshot(page)).queueLength).toBe(1);
});

test('Ctrl+Enter in the TUI plays the whole scope through the real playback port', async ({ page }) => {
    await openAllSongs(page);
    await switchTo(page, 'tui');
    await expect(tui(page).locator('[data-tui-row="0"]')).toHaveAttribute('aria-selected', 'true');

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Control+Enter');

    await expect.poll(async () => (await playbackSnapshot(page)).currentSongName).toBe('Midnight Train');
    expect((await playbackSnapshot(page)).queueLength).toBe(1);
});
