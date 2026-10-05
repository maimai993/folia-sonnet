import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
    ACCOUNT_ALPHA,
    ACCOUNT_BETA,
    ACCOUNT_GAMMA,
    ACCOUNT_MODO,
    ACCOUNT_NETEASE,
    ACCOUNT_QUILL,
    accountRule,
} from '../../dev/probes/accountBehavior/accountFixtureRules';
import type { AccountCall, AccountCallOp, AccountQrState } from '../../dev/probes/accountBehavior/probeApi';
import '../../dev/probes/accountBehavior/probeApi';

// test/component/accountBehavior.spec.ts
// 在线账户的行为回归闸门（Library v2 账户重构 A0 起每一步都跑）：扫码登录、选平台、切换确认、登出。
//
// 断言的是语义：调用账（要码 / 轮询 / keyed 取消 / 账户刷新 / 宿主登出 / 切换清理，见 dev/probes/accountBehavior/probeApi.ts）、
// 账户 store、当前平台、待确认切换，再加上界面上用户能看到的结果（弹窗、状态文案、诊断入口、确认框）。
// 界面操作集中在下面的 grid 驱动函数里（切换器菜单、登录弹窗、App 同形的确认框）；A6 加 TUI 时按 suite 换一套驱动，
// 用例本身不动。
//
// 时序：二维码每 2 秒轮询一次（useOnlineProviderQrLogin 的 QR_POLL_INTERVAL_MS），探针用真实时钟，所以
// 编排的状态要在要码之前排好，每一步最多等一个轮询周期。
// test.fixme 记录的是现状缺陷，注释里写明由哪一步转正。

const shortName = (providerId: string) => accountRule(providerId)!.shortName;

// ---- 探针接口 ----
const calls = (page: Page, op?: AccountCallOp, providerId?: string): Promise<AccountCall[]> => page.evaluate(
    ([callOp, callProvider]) => window.__accountProbe!.calls().filter(call => (
        (callOp === null || call.op === callOp) && (callProvider === null || call.providerId === callProvider)
    )),
    [op ?? null, providerId ?? null] as const,
);
const countCalls = async (page: Page, op: AccountCallOp, providerId?: string) => (await calls(page, op, providerId)).length;
const lastKey = async (page: Page, providerId: string) => (await calls(page, 'create', providerId)).at(-1)?.key;
const activeProvider = (page: Page) => page.evaluate(() => window.__accountProbe!.activeProvider());
const accountStatus = (page: Page, providerId: string) => page.evaluate(id => window.__accountProbe!.accountStatus(id), providerId);
const pendingSwitch = (page: Page) => page.evaluate(() => window.__accountProbe!.pendingSwitch());
const requestGeneration = (page: Page) => page.evaluate(() => window.__accountProbe!.requestGeneration());
const scriptQr = (page: Page, providerId: string, states: AccountQrState[]) => page.evaluate(
    ([id, queued]) => window.__accountProbe!.scriptQr(id, queued),
    [providerId, states] as const,
);
const setQrTtl = (page: Page, providerId: string, ttlMs: number | null) => page.evaluate(
    ([id, ttl]) => window.__accountProbe!.setQrTtl(id, ttl),
    [providerId, ttlMs] as const,
);
const setAccount = (page: Page, providerId: string, status: 'authenticated' | 'anonymous') => page.evaluate(
    ([id, value]) => window.__accountProbe!.setAccount(id, value),
    [providerId, status] as const,
);
const setActive = (page: Page, providerId: string) => page.evaluate(id => window.__accountProbe!.setActive(id), providerId);

const mountAccount = async (mount: (id: string) => Promise<unknown>, page: Page) => {
    await mount('accountBehavior');
    await expect.poll(() => page.evaluate(() => window.__accountProbe?.ready() ?? false), { timeout: 30_000 }).toBe(true);
    await expect(switcher(page)).toBeVisible();
};

// ---- grid 驱动：切换器 ----
const switcher = (page: Page) => page.getByTestId('online-provider-switcher');
const switcherToggle = (page: Page) => switcher(page).getByRole('button', { name: 'Switch online music provider' });
const menu = (page: Page) => switcher(page).getByRole('menu');
const menuItem = (page: Page, providerId: string) => (
    menu(page).getByRole('menuitemradio').filter({ hasText: shortName(providerId) })
);
const openSwitcher = async (page: Page) => {
    if (await switcherToggle(page).getAttribute('aria-expanded') !== 'true') await switcherToggle(page).click();
    await expect(menu(page)).toBeVisible();
};
const closeSwitcher = async (page: Page) => {
    if (await switcherToggle(page).getAttribute('aria-expanded') === 'true') await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);
};
/** 在切换器里选一个平台（与连接面板同一个 selectProvider）。 */
const selectProvider = async (page: Page, providerId: string) => {
    await openSwitcher(page);
    await menuItem(page, providerId).click();
};
const logoutButtons = (page: Page) => menu(page).getByRole('button', { name: 'Logout' });

// ---- grid 驱动：登录弹窗 ----
const loginDialog = (page: Page) => page.getByRole('dialog');
const qrImage = (page: Page) => loginDialog(page).getByAltText('QR Code');
const expectQrKey = async (page: Page, key: string | undefined) => {
    expect(key).toBeTruthy();
    await expect(qrImage(page)).toHaveAttribute('src', new RegExp(encodeURIComponent(key!).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
};
const retryButton = (page: Page) => loginDialog(page).getByRole('button', { name: 'Refresh QR code' });
const closeButton = (page: Page) => loginDialog(page).getByRole('button', { name: 'Close login' });
const diagnosticsButton = (page: Page) => loginDialog(page).getByRole('button', { name: 'Copy diagnostics' });
const methodButton = (page: Page, label: 'QQ scan' | 'WeChat scan') => loginDialog(page).getByRole('button', { name: label });
const restartButton = (page: Page) => loginDialog(page).getByRole('button', { name: /Restart backend|Restarting…/ });
const STATUS = {
    waiting: 'Please scan the QR code',
    scanned: 'Scanned! Confirm on your phone.',
    expired: 'QR Code expired. Refresh to try again.',
    error: 'Login Error',
} as const;
const statusText = (page: Page, key: keyof typeof STATUS) => loginDialog(page).getByText(STATUS[key], { exact: true });

// ---- grid 驱动：切换确认框（App 同形：ConfirmDialog，标题是「切换在线音乐平台」） ----
const confirmDialog = (page: Page): Locator => (
    page.locator('[data-folia-keyboard-window]').filter({ has: page.getByRole('heading', { name: 'Switch online music provider' }) })
);
const expectConfirmFor = async (page: Page, providerId: string) => {
    await expect(confirmDialog(page)).toBeVisible();
    await expect(confirmDialog(page)).toContainText(`Switch to ${shortName(providerId)}?`);
    await expect.poll(() => pendingSwitch(page)).toBe(providerId);
};
const answerConfirm = async (page: Page, answer: 'Confirm' | 'Cancel') => {
    await confirmDialog(page).getByRole('button', { name: answer, exact: true }).click();
    await expect(confirmDialog(page)).toHaveCount(0);
};

test.beforeEach(async ({ page, mount }) => {
    await mountAccount(mount, page);
});

test.describe('switching', () => {
    test('[grid] switching to a signed-in provider asks first; cancel keeps it, confirm switches and cleans up once', async ({ page }) => {
        const generation = await requestGeneration(page);

        // 选当前平台：同一个 provider，直接结束，不问也不清理。
        await selectProvider(page, ACCOUNT_ALPHA);
        await expect(menu(page)).toHaveCount(0);
        await expect(confirmDialog(page)).toHaveCount(0);
        expect(await pendingSwitch(page)).toBeNull();

        await selectProvider(page, ACCOUNT_BETA);
        // 能直接切的平台：菜单关掉，确认框出来，登录弹窗不出现。
        await expect(menu(page)).toHaveCount(0);
        await expectConfirmFor(page, ACCOUNT_BETA);
        await expect(loginDialog(page)).toHaveCount(0);
        expect(await activeProvider(page)).toBe(ACCOUNT_ALPHA);

        await answerConfirm(page, 'Cancel');
        expect(await pendingSwitch(page)).toBeNull();
        expect(await activeProvider(page)).toBe(ACCOUNT_ALPHA);
        expect(await countCalls(page, 'switch-cleanup')).toBe(0);
        expect(await countCalls(page, 'refresh')).toBe(0);
        expect(await requestGeneration(page)).toBe(generation);

        await selectProvider(page, ACCOUNT_BETA);
        await expectConfirmFor(page, ACCOUNT_BETA);
        await answerConfirm(page, 'Confirm');
        await expect.poll(() => activeProvider(page)).toBe(ACCOUNT_BETA);
        // 清理恰好一次、目标是新平台；提交前作废一次在途请求；提交后刷新新平台的账户（App 的 switchProvider 带 refresh）。
        expect((await calls(page, 'switch-cleanup')).map(call => call.providerId)).toEqual([ACCOUNT_BETA]);
        expect(await requestGeneration(page)).toBe(generation + 1);
        await expect.poll(() => calls(page, 'refresh')).toEqual([expect.objectContaining({ providerId: ACCOUNT_BETA, ok: true })]);
        expect(await pendingSwitch(page)).toBeNull();
        await openSwitcher(page);
        await expect(menuItem(page, ACCOUNT_BETA)).toHaveAttribute('aria-checked', 'true');
    });

    test('[grid] a provider without accounts still asks before switching, and the menu closes', async ({ page }) => {
        await selectProvider(page, ACCOUNT_MODO);
        await expect(menu(page)).toHaveCount(0);
        await expectConfirmFor(page, ACCOUNT_MODO);
        await expect(loginDialog(page)).toHaveCount(0);
        expect(await countCalls(page, 'resolve-methods')).toBe(0);
        expect(await countCalls(page, 'create')).toBe(0);

        await answerConfirm(page, 'Confirm');
        await expect.poll(() => activeProvider(page)).toBe(ACCOUNT_MODO);
        expect((await calls(page, 'switch-cleanup')).map(call => call.providerId)).toEqual([ACCOUNT_MODO]);
        // mod 源没有宿主刷新器（App 的刷新表只有内置 provider）。
        expect(await countCalls(page, 'refresh')).toBe(0);
    });

    test('[grid] the connect panel follows the same rules as the switcher', async ({ page }) => {
        // 当前平台未登录时首页显示连接面板：第一下展开、第二下选中。
        await setActive(page, ACCOUNT_GAMMA);
        const panel = page.getByRole('group', { name: 'Connect platform accounts' });
        await expect(panel).toBeVisible();

        const beta = panel.getByRole('button', { name: `Switch to ${shortName(ACCOUNT_BETA)}`, exact: true });
        await beta.click();
        await beta.click();
        await expectConfirmFor(page, ACCOUNT_BETA);
        await answerConfirm(page, 'Cancel');
        expect(await activeProvider(page)).toBe(ACCOUNT_GAMMA);

        const quill = panel.getByRole('button', { name: `Log in to ${shortName(ACCOUNT_QUILL)}`, exact: true });
        await quill.click();
        await quill.click();
        await expect(loginDialog(page)).toBeVisible();
        await expect(confirmDialog(page)).toHaveCount(0);
        await expect.poll(() => countCalls(page, 'resolve-methods', ACCOUNT_QUILL)).toBe(1);
    });
});

test.describe('signing in', () => {
    test('[grid] signing in to another provider opens the login first, then asks to activate; declining keeps the account', async ({ page }) => {
        await scriptQr(page, ACCOUNT_GAMMA, ['scanned', 'confirmed']);
        await selectProvider(page, ACCOUNT_GAMMA);

        // 未登录的平台：先登录，不确认。现状：要登录时切换器菜单不收起（只有能直接切时才收）。
        await expect(loginDialog(page)).toBeVisible();
        await expect(switcherToggle(page)).toHaveAttribute('aria-expanded', 'true');
        await expect(confirmDialog(page)).toHaveCount(0);
        expect(await pendingSwitch(page)).toBeNull();
        // 现状：未知 provider 的弹窗文案回落到网易的（LOGIN_COPY_BY_PROVIDER 只有 kugou / qq / bodian）。
        await expect(loginDialog(page)).toHaveAccessibleName('Scan with Netease App');
        await expect(statusText(page, 'waiting')).toBeVisible();
        await expect.poll(() => calls(page, 'create', ACCOUNT_GAMMA)).toEqual([
            expect.objectContaining({ methodId: null }),
        ]);
        const key = await lastKey(page, ACCOUNT_GAMMA);
        await expectQrKey(page, key);

        await expect(statusText(page, 'scanned')).toBeVisible();
        // 确认后：弹窗收起 → 刷新账户（账户先写进 store）→ 不是当前平台，问要不要切过去。
        await expectConfirmFor(page, ACCOUNT_GAMMA);
        await expect(loginDialog(page)).toHaveCount(0);
        expect(await calls(page, 'refresh')).toEqual([expect.objectContaining({ providerId: ACCOUNT_GAMMA, ok: true })]);
        expect(await accountStatus(page, ACCOUNT_GAMMA)).toBe('authenticated');

        await answerConfirm(page, 'Cancel');
        // 拒绝激活：登录本身成功，账户保留；当前平台不变、不清理，弹窗也不再出现。
        expect(await activeProvider(page)).toBe(ACCOUNT_ALPHA);
        expect(await accountStatus(page, ACCOUNT_GAMMA)).toBe('authenticated');
        expect(await countCalls(page, 'switch-cleanup')).toBe(0);
        await expect(loginDialog(page)).toHaveCount(0);
        // 已确认的会话换成了登录凭据，不再取消。
        expect(await countCalls(page, 'cancel', ACCOUNT_GAMMA)).toBe(0);
        // 切换器里它变成「已登录」：再选它就是直接切换（问确认），不再走登录。
        await selectProvider(page, ACCOUNT_GAMMA);
        await expectConfirmFor(page, ACCOUNT_GAMMA);
        await expect(loginDialog(page)).toHaveCount(0);
    });

    test('[grid] accepting the activation switches and cleans up exactly once', async ({ page }) => {
        await scriptQr(page, ACCOUNT_GAMMA, ['confirmed']);
        await selectProvider(page, ACCOUNT_GAMMA);
        await expectConfirmFor(page, ACCOUNT_GAMMA);
        await answerConfirm(page, 'Confirm');
        await expect.poll(() => activeProvider(page)).toBe(ACCOUNT_GAMMA);
        expect((await calls(page, 'switch-cleanup')).map(call => call.providerId)).toEqual([ACCOUNT_GAMMA]);
        // 激活这一步不再刷新：登录事务里的那一次刷新就是全部。
        expect((await calls(page, 'refresh')).map(call => call.providerId)).toEqual([ACCOUNT_GAMMA]);
        expect(await accountStatus(page, ACCOUNT_GAMMA)).toBe('authenticated');
    });

    test('[grid] signing in to the current provider needs no confirmation', async ({ page }) => {
        await setActive(page, ACCOUNT_GAMMA);
        await scriptQr(page, ACCOUNT_GAMMA, ['confirmed']);
        await selectProvider(page, ACCOUNT_GAMMA);
        await expect(loginDialog(page)).toBeVisible();

        await expect.poll(() => accountStatus(page, ACCOUNT_GAMMA)).toBe('authenticated');
        await expect(loginDialog(page)).toHaveCount(0);
        await expect(confirmDialog(page)).toHaveCount(0);
        expect(await pendingSwitch(page)).toBeNull();
        expect(await activeProvider(page)).toBe(ACCOUNT_GAMMA);
        expect(await countCalls(page, 'switch-cleanup')).toBe(0);
    });

    test('[grid] a failed account refresh after confirmation reopens the dialog with the failure and diagnostics', async ({ page }) => {
        await page.evaluate(id => window.__accountProbe!.failRefresh(id, 1), ACCOUNT_GAMMA);
        await scriptQr(page, ACCOUNT_GAMMA, ['confirmed']);
        await selectProvider(page, ACCOUNT_GAMMA);

        await expect.poll(() => calls(page, 'refresh')).toEqual([expect.objectContaining({ providerId: ACCOUNT_GAMMA, ok: false })]);
        await expect(loginDialog(page)).toBeVisible();
        await expect(statusText(page, 'error')).toBeVisible();
        await expect(diagnosticsButton(page)).toBeVisible();
        await expect(retryButton(page)).toBeVisible();
        await expect(confirmDialog(page)).toHaveCount(0);
        expect(await accountStatus(page, ACCOUNT_GAMMA)).toBe('anonymous');
        expect(await activeProvider(page)).toBe(ACCOUNT_ALPHA);
    });

    test('[grid] several sign-in methods: no QR before a choice, one live session across choices', async ({ page }) => {
        await selectProvider(page, ACCOUNT_QUILL);
        await expect(loginDialog(page)).toBeVisible();
        // 步骤一：占位框，不要码，没有状态文案和重试。
        await expect(loginDialog(page).getByText('Pick a sign-in method to generate the QR code')).toBeVisible();
        await expect.poll(() => countCalls(page, 'resolve-methods', ACCOUNT_QUILL)).toBe(1);
        await expect(methodButton(page, 'QQ scan')).toHaveAttribute('aria-pressed', 'false');
        await expect(retryButton(page)).toHaveCount(0);
        await page.waitForTimeout(500);
        expect(await countCalls(page, 'create')).toBe(0);

        await methodButton(page, 'QQ scan').click();
        await expect.poll(() => calls(page, 'create', ACCOUNT_QUILL)).toEqual([expect.objectContaining({ methodId: 'qq' })]);
        const first = await lastKey(page, ACCOUNT_QUILL);
        await expectQrKey(page, first);
        await expect(methodButton(page, 'QQ scan')).toHaveAttribute('aria-pressed', 'true');
        await expect(loginDialog(page).getByText('Current method: QQ scan')).toBeVisible();
        await expect(statusText(page, 'waiting')).toBeVisible();

        // 换方式：旧会话按自己的 provider 取消，再要新码；任何时候只有一个活跃会话。
        await methodButton(page, 'WeChat scan').click();
        await expect.poll(() => calls(page, 'create', ACCOUNT_QUILL)).toHaveLength(2);
        const second = await lastKey(page, ACCOUNT_QUILL);
        expect((await calls(page, 'create', ACCOUNT_QUILL))[1].methodId).toBe('wechat');
        await expect.poll(() => calls(page, 'cancel')).toEqual([expect.objectContaining({ providerId: ACCOUNT_QUILL, key: first })]);
        await expectQrKey(page, second);

        // 后端报过期（没扫过）：不算失败；重试沿用已选的方式，并取消过期的那个会话。
        await scriptQr(page, ACCOUNT_QUILL, ['expired']);
        await expect(statusText(page, 'expired')).toBeVisible();
        await expect(diagnosticsButton(page)).toHaveCount(0);
        await retryButton(page).click();
        await expect.poll(() => calls(page, 'create', ACCOUNT_QUILL)).toHaveLength(3);
        expect((await calls(page, 'create', ACCOUNT_QUILL))[2].methodId).toBe('wechat');
        expect((await calls(page, 'cancel')).map(call => call.key)).toEqual([first, second]);
        const third = await lastKey(page, ACCOUNT_QUILL);

        await closeButton(page).click();
        await expect(loginDialog(page)).toHaveCount(0);
        await expect.poll(async () => (await calls(page, 'cancel')).map(call => call.key)).toEqual([first, second, third]);
    });
});

test.describe('QR lifetime', () => {
    test('[grid] the TTL expires and cancels the code; an unscanned expiry is not a failure', async ({ page }) => {
        await setQrTtl(page, ACCOUNT_GAMMA, 1200);
        await selectProvider(page, ACCOUNT_GAMMA);
        await expect(statusText(page, 'waiting')).toBeVisible();
        const key = await lastKey(page, ACCOUNT_GAMMA);

        await expect(statusText(page, 'expired')).toBeVisible();
        await expect.poll(() => calls(page, 'cancel')).toEqual([expect.objectContaining({ providerId: ACCOUNT_GAMMA, key })]);
        await expect(retryButton(page)).toBeVisible();
        await expect(diagnosticsButton(page)).toHaveCount(0);
        // 到点即停：之后不再轮询。
        const checks = await countCalls(page, 'check');
        await page.waitForTimeout(2_500);
        expect(await countCalls(page, 'check')).toBe(checks);

        await setQrTtl(page, ACCOUNT_GAMMA, null);
        await retryButton(page).click();
        await expect.poll(() => countCalls(page, 'create', ACCOUNT_GAMMA)).toBe(2);
        await expect(statusText(page, 'waiting')).toBeVisible();
        await expectQrKey(page, await lastKey(page, ACCOUNT_GAMMA));
    });

    test('[grid] expiring after a scan counts as a failure and offers diagnostics', async ({ page }) => {
        // TTL 计时：第一次轮询（约 2 秒）报已扫码，3.5 秒到点。
        await setQrTtl(page, ACCOUNT_GAMMA, 3_500);
        await scriptQr(page, ACCOUNT_GAMMA, ['scanned']);
        await selectProvider(page, ACCOUNT_GAMMA);
        const key = await lastKey(page, ACCOUNT_GAMMA);
        await expect(statusText(page, 'scanned')).toBeVisible();
        await expect(statusText(page, 'expired')).toBeVisible();
        await expect(diagnosticsButton(page)).toBeVisible();
        await expect(loginDialog(page).getByText(/Confirmed on your phone but still not signed in/)).toBeVisible();
        expect((await calls(page, 'cancel')).map(call => call.key)).toEqual([key]);

        // 后端报的过期同理：扫过才算失败。
        await setQrTtl(page, ACCOUNT_GAMMA, null);
        await scriptQr(page, ACCOUNT_GAMMA, ['scanned', 'expired']);
        await retryButton(page).click();
        await expect(statusText(page, 'scanned')).toBeVisible();
        await expect(diagnosticsButton(page)).toHaveCount(0);
        await expect(statusText(page, 'expired')).toBeVisible();
        await expect(diagnosticsButton(page)).toBeVisible();
    });
});

test.describe('closing', () => {
    test('[grid] closing the dialog cancels the session and stops polling', async ({ page }) => {
        await selectProvider(page, ACCOUNT_GAMMA);
        await expect(statusText(page, 'waiting')).toBeVisible();
        const key = await lastKey(page, ACCOUNT_GAMMA);
        await closeButton(page).click();
        await expect(loginDialog(page)).toHaveCount(0);
        await expect.poll(() => calls(page, 'cancel')).toEqual([expect.objectContaining({ providerId: ACCOUNT_GAMMA, key })]);
        const checks = await countCalls(page, 'check');
        await page.waitForTimeout(2_500);
        expect(await countCalls(page, 'check')).toBe(checks);
        expect(await activeProvider(page)).toBe(ACCOUNT_ALPHA);
    });

    test('[grid] the cancel is keyed to the provider that started the session', async ({ page }) => {
        // 弹窗开着时切换器仍在上层可点：先给 gamma 要了码，再在菜单里选 quill（多方式，停在选方式、不要码）。
        await selectProvider(page, ACCOUNT_GAMMA);
        await expect(statusText(page, 'waiting')).toBeVisible();
        const key = await lastKey(page, ACCOUNT_GAMMA);
        await selectProvider(page, ACCOUNT_QUILL);
        await expect(loginDialog(page).getByText('Pick a sign-in method to generate the QR code')).toBeVisible();
        expect(await countCalls(page, 'create', ACCOUNT_QUILL)).toBe(0);

        // 关窗时取消的是 gamma 的会话、交给 gamma，而不是弹窗此刻显示的 quill。
        await closeButton(page).click();
        await expect(loginDialog(page)).toHaveCount(0);
        await expect.poll(() => calls(page, 'cancel')).toEqual([expect.objectContaining({ providerId: ACCOUNT_GAMMA, key })]);
    });
});

test.describe('NetEase backend', () => {
    test('[grid] a backend failure shows the cause and restart instead of retry; a successful restart asks for a code', async ({ page }) => {
        await page.evaluate(() => window.__accountProbe!.setNeteaseBackend({
            supported: true,
            status: 'error',
            error: 'probe: xeapi key missing',
        }));

        // 只有网易读后端状态：别的平台照常出码。
        await selectProvider(page, ACCOUNT_GAMMA);
        await expect(statusText(page, 'waiting')).toBeVisible();
        await expect(restartButton(page)).toHaveCount(0);
        await closeButton(page).click();
        await expect(loginDialog(page)).toHaveCount(0);

        await selectProvider(page, ACCOUNT_NETEASE);
        await expect(loginDialog(page)).toHaveAccessibleName('Scan with Netease App');
        await expect(loginDialog(page).getByText('The local NetEase service is not running')).toBeVisible();
        await expect(loginDialog(page).getByText('probe: xeapi key missing')).toBeVisible();
        await expect(restartButton(page)).toHaveText('Restart backend');
        // 要码照常发出（后端没起来所以失败），但失败被后端故障盖住：没有重试、没有诊断、没有状态文案。
        await expect.poll(() => countCalls(page, 'create', ACCOUNT_NETEASE)).toBe(1);
        await expect(retryButton(page)).toHaveCount(0);
        await expect(diagnosticsButton(page)).toHaveCount(0);
        await expect(statusText(page, 'error')).toHaveCount(0);
        await expect(qrImage(page)).toHaveCount(0);

        // 重启失败：故障留着，不要码。
        await page.evaluate(() => window.__accountProbe!.setBackendRestart('error', 300));
        await restartButton(page).click();
        await expect.poll(() => countCalls(page, 'backend-restart')).toBe(1);
        await expect(restartButton(page)).toHaveText('Restart backend');
        await expect(loginDialog(page).getByText('The local NetEase service is not running')).toBeVisible();
        expect(await countCalls(page, 'create', ACCOUNT_NETEASE)).toBe(1);

        // 重启成功：故障消失，自动要码。
        await page.evaluate(() => window.__accountProbe!.setBackendRestart('running', 600));
        await restartButton(page).click();
        await expect(restartButton(page)).toHaveText('Restarting…');
        await expect(restartButton(page)).toBeDisabled();
        await expect(loginDialog(page).getByText('The local NetEase service is not running')).toHaveCount(0);
        await expect.poll(() => countCalls(page, 'create', ACCOUNT_NETEASE)).toBe(2);
        await expect(statusText(page, 'waiting')).toBeVisible();
        await expectQrKey(page, await lastKey(page, ACCOUNT_NETEASE));
        expect(await countCalls(page, 'backend-restart')).toBe(2);
    });
});

test.describe('logout', () => {
    test('[grid] only the current signed-in provider offers logout, and it runs that provider\'s injected logout', async ({ page }) => {
        await openSwitcher(page);
        // beta 也已登录，但不是当前平台：没有登出按钮。
        await expect(logoutButtons(page)).toHaveCount(1);
        await expect(menuItem(page, ACCOUNT_ALPHA).locator('xpath=..').getByRole('button', { name: 'Logout' })).toHaveCount(1);

        await logoutButtons(page).click();
        await expect(menu(page)).toHaveCount(0);
        await expect.poll(() => calls(page, 'host-logout')).toEqual([expect.objectContaining({ providerId: ACCOUNT_ALPHA })]);
        await expect.poll(() => calls(page, 'auth-logout')).toEqual([expect.objectContaining({ providerId: ACCOUNT_ALPHA })]);
        await expect.poll(() => accountStatus(page, ACCOUNT_ALPHA)).toBe('anonymous');
        expect(await activeProvider(page)).toBe(ACCOUNT_ALPHA);
        expect(await accountStatus(page, ACCOUNT_BETA)).toBe('authenticated');
        await expect(confirmDialog(page)).toHaveCount(0);

        // 当前平台登出后（未登录）：没有任何登出按钮。
        await openSwitcher(page);
        await expect(logoutButtons(page)).toHaveCount(0);
        await closeSwitcher(page);
    });
});

test.describe('account tab', () => {
    const accountTab = (page: Page) => page.locator('[data-probe-account-tab]');

    test('[account-tab] NetEase logout runs the host logout', async ({ page }) => {
        await setAccount(page, ACCOUNT_NETEASE, 'authenticated');
        await setActive(page, ACCOUNT_NETEASE);
        await page.evaluate(() => window.__accountProbe!.showAccountTab(true));
        await accountTab(page).getByRole('button', { name: 'Logout' }).click();
        await expect.poll(() => calls(page, 'host-logout')).toEqual([expect.objectContaining({ providerId: ACCOUNT_NETEASE })]);
        await expect.poll(() => accountStatus(page, ACCOUNT_NETEASE)).toBe('anonymous');
    });

    test('[account-tab] non-NetEase logout signs the provider out', async ({ page }) => {
        await page.evaluate(() => window.__accountProbe!.showAccountTab(true));
        await accountTab(page).getByRole('button', { name: 'Logout' }).click();
        await expect.poll(() => calls(page, 'auth-logout')).toEqual([expect.objectContaining({ providerId: ACCOUNT_ALPHA })]);
        await expect.poll(() => accountStatus(page, ACCOUNT_ALPHA)).toBe('anonymous');
    });

    // 现状缺陷：AccountTab 的非网易登出直接 omni.logout + clearAccount，绕过了平台注入的 per-provider 登出
    // （酷狗的 clearAuthState 等），与切换器的登出路径不一致。A4 让 AccountTab 改走账户 controller 的 logout 时转正。
    test.fixme('[account-tab] non-NetEase logout runs that provider\'s injected logout, like the switcher', async ({ page }) => {
        await page.evaluate(() => window.__accountProbe!.showAccountTab(true));
        await accountTab(page).getByRole('button', { name: 'Logout' }).click();
        await expect.poll(() => calls(page, 'host-logout')).toEqual([expect.objectContaining({ providerId: ACCOUNT_ALPHA })]);
    });
});
