import { expect, test, type Page } from '@playwright/test';
import { APP_VERSION, GUIDE_VERSION_STORAGE_KEY } from '../helpers/appState';

// test/ui/commandPaletteSizing.spec.ts
// 命令面板同时是携带 UI 的命令（surface）的画布，所以面板的外框尺寸是一条硬契约：
// 无论当前是匹配列表、空态、全部命令列表还是任何一个 surface，尺寸都必须一模一样。
//
// 这份用例是「先于改动写的基线」，不是对现有实现的描述。它锁住的是
// CommandPalette.tsx 里那个 h-[min(496px,50vh)] 的 body 盒子必须始终由 CSS 解出高度，
// 不允许被内容撑开，也不允许有人改成测量式尺寸（ResizeObserver / AutoSizer /
// getBoundingClientRect）。虚拟化长列表时最容易破坏的就是这条。

const QUEUE_FIXTURE = [
    { id: 1, name: 'Current', artists: [{ id: 10, name: 'Alpha' }], album: { id: 20, name: 'Shared Album' }, durationMs: 180_000 },
    { id: 2, name: 'Same Artist', artists: [{ id: 10, name: 'Alpha' }], album: { id: 21, name: 'Other Album' }, durationMs: 180_000 },
    { id: 3, name: 'Same Album', artists: [{ id: 11, name: 'Beta' }], album: { id: 20, name: 'Shared Album' }, durationMs: 180_000 },
];

/** 对应 src/components/command-palette/pinnedCommandPreferences.ts */
const PINNED_COMMANDS_STORAGE_KEY = 'command_palette_pinned_commands_v1';

const palette = (page: Page) => page.getByTestId('command-palette-panel');
const paletteBody = (page: Page) => page.getByTestId('command-palette-body');
const paletteInput = (page: Page) => palette(page).getByRole('combobox');

type PinnedSlots = [string | null, string | null, string | null];

/** 三个槽全空 —— 注意不能靠删除这个键来表达，缺键会回落到三个默认固定命令。 */
const NO_PINNED_COMMANDS: PinnedSlots = [null, null, null];

/**
 * 三个槽全空时 PinnedCommandRow 直接 return null，外层包装会矮一整行。它挂在被测面板的外面
 * （见最后一条用例），但基线仍然显式钉死这个状态，免得将来结构一变就冒出和虚拟化毫无关系的抖动。
 */
const seedApp = async (page: Page, pinnedCommandIds: PinnedSlots) => {
    await page.addInitScript(([version, guideKey, pinnedKey, pinned]) => {
        localStorage.clear();
        localStorage.setItem('i18nextLng', 'zh-CN');
        localStorage.setItem('open_player_on_launch', 'true');
        localStorage.setItem('visualizer_mode', 'classic');
        localStorage.setItem('static_mode', 'true');
        localStorage.setItem(guideKey, version);
        localStorage.setItem(pinnedKey, JSON.stringify(pinned));
    }, [APP_VERSION, GUIDE_VERSION_STORAGE_KEY, PINNED_COMMANDS_STORAGE_KEY, pinnedCommandIds] as const);

    await page.route('**/__mock_netease__/**', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
};

const openPlayerPage = async (page: Page, pinnedCommandIds: PinnedSlots = NO_PINNED_COMMANDS) => {
    await seedApp(page, pinnedCommandIds);

    await page.goto('/');
    await page.waitForTimeout(2000);
    await page.evaluate(async (songs) => {
        const dbModulePath = '/src/services/db.ts';
        const { saveToCache } = await import(dbModulePath);
        await saveToCache('last_song', songs[0]);
        await saveToCache('last_queue', songs);
    }, QUEUE_FIXTURE);
    await page.reload();
    await page.waitForTimeout(1800);
};

// 全局键盘监听比首屏晚装上一拍，定长 sleep 只是在赌它已经装好了。反复敲直到面板真的响应。
const pressUntilPaletteOpens = async (page: Page, key = 's') => {
    await expect.poll(async () => {
        await page.keyboard.press(key);
        return palette(page).count();
    }).toBeGreaterThan(0);
};

type Box = { width: number; height: number };

/**
 * 面板入场是 framer-motion 的 scale 0.98 -> 1（0.18s），动画途中读到的是缩放后的盒子。
 *
 * 「连续两次读数相同就算稳定」不够：50ms 采样 + 取整，动画尾段两次采样完全可能落在同一个整数上，
 * 于是把一个 0.995 倍的中途值当成了最终值——实测就是这么产生 3px 假阳性的。
 * 所以直接等变换归位：framer-motion 停下时会把 transform 置为 none 或单位矩阵。
 */
const waitForPanelAtRest = async (page: Page) => {
    await expect.poll(async () => page.evaluate(() => {
        const panel = document.querySelector('[data-testid="command-palette-panel"]');
        // 缩放写在带 max-w-2xl 的 motion 包装上，不在面板自身。
        const animated = panel?.parentElement;
        if (!animated) {
            return 'missing';
        }
        const { transform } = window.getComputedStyle(animated);
        return transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)' ? 'rest' : transform;
    }), { timeout: 5_000 }).toBe('rest');
};

/** 取整抹掉亚像素抗锯齿：真正的尺寸回归是几十上百像素，不会被取整掩盖。 */
const readBox = async (page: Page, testId: string, label: string): Promise<Box> => {
    const box = await page.getByTestId(testId).boundingBox();
    expect(box, `${label}必须可见才能测量`).not.toBeNull();
    return { width: Math.round(box!.width), height: Math.round(box!.height) };
};

const measure = async (page: Page) => {
    await waitForPanelAtRest(page);
    return {
        panel: await readBox(page, 'command-palette-panel', '面板'),
        body: await readBox(page, 'command-palette-body', 'body 盒子'),
    };
};

/** 输入查询并等匹配列表跟上 120ms 的 matchQuery 防抖。 */
const typeQuery = async (page: Page, query: string) => {
    await paletteInput(page).fill(query);
    await page.waitForTimeout(400);
};

test('面板与 body 的尺寸在所有内容状态下保持一致', async ({ page }) => {
    await openPlayerPage(page);
    await pressUntilPaletteOpens(page);
    await expect(palette(page)).toBeVisible();

    // 空查询的落地列表就是基准。
    const baseline = await measure(page);
    // body 盒子是 min(496px, 50vh)：证明基线本身不是 0 或被内容撑爆的值。
    expect(baseline.body.height).toBeGreaterThan(0);
    expect(baseline.body.height).toBeLessThanOrEqual(496);

    // 满列表：10 条匹配，足以在未虚拟化时溢出 body。
    await typeQuery(page, 'e');
    expect(await measure(page)).toEqual(baseline);

    // 空态：一条都不匹配，内容远少于一屏。
    await typeQuery(page, 'zzzzzzzzzzzz');
    await expect(palette(page).getByText('没有匹配的命令')).toBeVisible();
    expect(await measure(page)).toEqual(baseline);

    // 全部命令列表：125 条，未虚拟化时是最容易撑破盒子的一屏。
    await typeQuery(page, '');
    await palette(page).getByRole('button', { name: '查看全部命令' }).click();
    await page.waitForTimeout(400);
    expect(await measure(page)).toEqual(baseline);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    expect(await measure(page)).toEqual(baseline);
});

test('每个 surface 接管面板后尺寸都不变', async ({ page }) => {
    await openPlayerPage(page);
    await pressUntilPaletteOpens(page);

    const baseline = await measure(page);

    // 音量：居中的单控件 hero 布局，靠 h-full 填满固定父级。
    await typeQuery(page, 'volume');
    await palette(page).getByText('音量条', { exact: true }).first().click();
    await page.waitForTimeout(400);
    await expect(palette(page).locator('input[type="range"]')).toBeVisible();
    expect(await measure(page)).toEqual(baseline);

    await page.keyboard.press('Escape');
    await pressUntilPaletteOpens(page);

    // 队列：唯一内容长度无上限的 surface，已用 react-window 钉在 height:100%。
    await typeQuery(page, 'queue');
    await palette(page).getByText('队列', { exact: true }).first().click();
    await page.waitForTimeout(400);
    expect(await measure(page)).toEqual(baseline);

    await page.keyboard.press('Escape');
    await pressUntilPaletteOpens(page);

    // 可视化选择器：列表型 surface，走匹配行的形状。
    await typeQuery(page, 'visualizer picker');
    await palette(page).getByText('选择可视化', { exact: true }).first().click();
    await page.waitForTimeout(400);
    expect(await measure(page)).toEqual(baseline);
});

test('固定命令行的有无不影响面板与 body 的尺寸', async ({ browser }) => {
    // 两个 page 而不是在同一个 page 上重开：addInitScript 会累积，第二次 seed 不会覆盖第一次，
    // 只是排在它后面，这种依赖注册顺序的写法迟早会咬人。
    const viewport = { width: 1440, height: 1100 };
    const pageWithout = await browser.newPage({ viewport });
    const pageWith = await browser.newPage({ viewport });

    await openPlayerPage(pageWithout, NO_PINNED_COMMANDS);
    await pressUntilPaletteOpens(pageWithout);
    const withoutPins = await measure(pageWithout);

    await openPlayerPage(pageWith, ['playback-shuffle', null, null]);
    await pressUntilPaletteOpens(pageWith);
    await expect(pageWith.getByTestId('command-palette-pinned-row')).toBeVisible();
    const withPins = await measure(pageWith);

    const page = pageWith;

    // PinnedCommandRow 是 command-palette-panel 的**兄弟节点**（同挂在 max-w-2xl 的
    // motion.div 下），不是它的子节点。所以固定命令的有无既不影响 body 盒子，也不影响面板本身——
    // 只有外层包装会高出一行。这条断言把这个结构事实钉住：一旦有人把固定命令行挪进面板内部，
    // 面板高度就会随用户的固定命令数量变化，surface 画布的尺寸契约当场作废。
    expect(withPins.body).toEqual(withoutPins.body);
    expect(withPins.panel).toEqual(withoutPins.panel);

    // 有固定命令时，各内容状态之间仍必须彼此一致。
    await typeQuery(page, 'zzzzzzzzzzzz');
    expect(await measure(page)).toEqual(withPins);

    await pageWithout.close();
    await pageWith.close();
});
