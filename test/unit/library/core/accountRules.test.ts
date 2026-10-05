import { describe, expect, it } from 'vitest';
import en from '@/i18n/locales/en';
import type { LibraryLoginPhase, LibraryNeteaseBackendHealth } from '@/library/core/contracts/account';
import {
    LOGIN_METHOD_STEP_COPY,
    canLogoutProvider,
    canRetryLogin,
    canShowLoginDiagnostics,
    isAwaitingLoginMethod,
    isLoginDialogVisible,
    resolveActiveProviderId,
    resolveActiveProviderSummary,
    resolveLoginBackendState,
    resolveLoginCopy,
    resolveLoginDiagnosticsPrompt,
    resolveLoginSessionCopy,
    resolveLoginStatusMessage,
    resolveLogoutEligibility,
    resolveProviderSelectLabel,
    resolveProviderSelection,
    resolveProviderSwitchCopy,
    shouldResumeLoginAfterBackendRestart,
} from '@/library/core/model/accountRules';
import type { ProviderAccountSummary, QrLoginMethod } from '@/types/onlineMusic';

// test/unit/library/accountRules.test.ts
// 在线账户的纯规则：选平台的三支（未配置 / 直接切 / 扫码）、当前平台回落、登录文案与状态 key（未知 provider 回落网易）、
// 选方式 / 重试 / 诊断 / 登录界面可见性的派生、网易后端故障、只能登出当前已登录平台。每个 key 都要在英文语言包里存在。

const summary = (patch: Partial<ProviderAccountSummary> = {}): ProviderAccountSummary => ({
    providerId: 'netease',
    displayName: 'NetEase Cloud Music',
    shortName: 'NetEase',
    availability: { configured: true },
    status: 'anonymous',
    user: null,
    collections: [],
    ...patch,
});

// Folium mod 源：capabilities.auth=false，永远没有账户条目（status 一直是 unknown）。
const modSource = (patch: Partial<ProviderAccountSummary> = {}) => summary({
    providerId: 'folium.mod-a.source',
    displayName: 'Mod Source',
    shortName: '',
    requiresAccount: false,
    status: 'unknown',
    hydration: 'loading',
    ...patch,
});

const QQ_METHODS: QrLoginMethod[] = [
    { id: 'qq', labelKey: 'home.qqLoginMethodQq', iconKey: 'qq' },
    { id: 'wechat', labelKey: 'home.qqLoginMethodWechat', iconKey: 'wechat' },
];

const health = (patch: Partial<LibraryNeteaseBackendHealth> = {}): LibraryNeteaseBackendHealth => ({
    supported: true,
    status: 'running',
    error: null,
    restarting: false,
    ...patch,
});

const OK_BACKEND = { failed: false };
const FAILED_BACKEND = { failed: true };

/** 'home.loginTitle' → en.home.loginTitle，确认 key 真的存在。 */
const translate = (key: string): unknown => key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    en,
);
const expectKey = (key: string) => expect(typeof translate(key), key).toBe('string');

describe('provider selection', () => {
    it('logs in to a configured provider that is not signed in', () => {
        expect(resolveProviderSelection(summary({ status: 'anonymous' }))).toEqual({ kind: 'login' });
    });

    it('logs in while the account is still unknown or errored (nothing to switch to yet)', () => {
        expect(resolveProviderSelection(summary({ status: 'unknown', hydration: 'loading' }))).toEqual({ kind: 'login' });
        expect(resolveProviderSelection(summary({ status: 'error' }))).toEqual({ kind: 'login' });
    });

    it('logs in again when the stored session expired (needsRelogin: error auth-required)', () => {
        expect(resolveProviderSelection(summary({ status: 'anonymous', error: 'auth-required' }))).toEqual({ kind: 'login' });
    });

    it('switches directly to a signed-in provider', () => {
        expect(resolveProviderSelection(summary({ providerId: 'kugou', status: 'authenticated' }))).toEqual({ kind: 'switch' });
    });

    it('switches directly to a mod source, which has no account at all', () => {
        expect(resolveProviderSelection(modSource())).toEqual({ kind: 'switch' });
    });

    it('treats an unconfigured provider as unavailable before anything else', () => {
        expect(resolveProviderSelection(summary({ availability: { configured: false, reason: 'not-configured' } })))
            .toEqual({ kind: 'unavailable', reason: 'not-configured' });
        // 已登录或无账户也一样：界面上那一项本就是禁用的。
        expect(resolveProviderSelection(summary({ status: 'authenticated', availability: { configured: false } })))
            .toEqual({ kind: 'unavailable', reason: 'not-configured' });
        expect(resolveProviderSelection(modSource({ availability: { configured: false, reason: 'runtime-unavailable' } })))
            .toEqual({ kind: 'unavailable', reason: 'not-configured' });
    });

    it('treats a provider missing from the list as unavailable', () => {
        expect(resolveProviderSelection(undefined)).toEqual({ kind: 'unavailable', reason: 'unknown-provider' });
    });

    it('labels the action by the branch it will take', () => {
        expect(resolveProviderSelectLabel(summary({ providerId: 'kugou', shortName: 'KuGou', status: 'authenticated' })))
            .toEqual({ key: 'home.switchToProvider', values: { provider: 'KuGou' } });
        expect(resolveProviderSelectLabel(summary({ providerId: 'qq', shortName: 'QQ' })))
            .toEqual({ key: 'home.loginToProvider', values: { provider: 'QQ' } });
        // shortName 为空时用 displayName。
        expect(resolveProviderSelectLabel(modSource())).toEqual({ key: 'home.switchToProvider', values: { provider: 'Mod Source' } });
        expectKey('home.switchToProvider');
        expectKey('home.loginToProvider');
    });
});

describe('active provider fallback', () => {
    const providers = [summary(), summary({ providerId: 'kugou' }), modSource()];

    it('keeps the stored provider while it is listed', () => {
        expect(resolveActiveProviderId(providers, 'kugou')).toBe('kugou');
        expect(resolveActiveProviderId(providers, 'folium.mod-a.source')).toBe('folium.mod-a.source');
    });

    it('falls back to netease when the stored provider went away', () => {
        expect(resolveActiveProviderId(providers, 'folium.mod-gone.source')).toBe('netease');
        expect(resolveActiveProviderId([], 'kugou')).toBe('netease');
    });

    it('finds the active summary, or the first provider when even netease is missing', () => {
        expect(resolveActiveProviderSummary(providers, 'kugou')?.providerId).toBe('kugou');
        const withoutNetease = [summary({ providerId: 'kugou' }), summary({ providerId: 'qq' })];
        expect(resolveActiveProviderSummary(withoutNetease, 'netease')?.providerId).toBe('kugou');
        expect(resolveActiveProviderSummary([], 'netease')).toBeUndefined();
    });
});

describe('switch confirmation copy', () => {
    it('names the target provider', () => {
        expect(resolveProviderSwitchCopy('KuGou')).toEqual({
            title: { key: 'home.switchOnlineProvider' },
            description: { key: 'home.confirmOnlineProviderSwitch', values: { provider: 'KuGou' } },
        });
        expectKey('home.switchOnlineProvider');
        expectKey('home.confirmOnlineProviderSwitch');
    });
});

describe('logout eligibility', () => {
    it('allows only the active, signed-in provider', () => {
        const kugou = summary({ providerId: 'kugou', status: 'authenticated' });
        expect(resolveLogoutEligibility(kugou, 'kugou')).toEqual({ allowed: true });
        expect(canLogoutProvider(kugou, 'kugou')).toBe(true);
    });

    it('rejects a signed-in provider that is not the active one', () => {
        const kugou = summary({ providerId: 'kugou', status: 'authenticated' });
        expect(resolveLogoutEligibility(kugou, 'netease')).toEqual({ allowed: false, reason: 'not-active' });
        expect(canLogoutProvider(kugou, 'netease')).toBe(false);
    });

    it('rejects the active provider unless it is authenticated', () => {
        for (const status of ['unknown', 'anonymous', 'error'] as const) {
            expect(resolveLogoutEligibility(summary({ status }), 'netease')).toEqual({ allowed: false, reason: 'not-authenticated' });
        }
        // 登录失效（needsRelogin）也没有可登出的会话。
        expect(canLogoutProvider(summary({ status: 'anonymous', error: 'auth-required' }), 'netease')).toBe(false);
    });

    it('never offers logout for a mod source', () => {
        const mod = modSource();
        expect(resolveLogoutEligibility(mod, mod.providerId)).toEqual({ allowed: false, reason: 'not-authenticated' });
    });

    it('rejects an unknown provider', () => {
        expect(resolveLogoutEligibility(undefined, 'netease')).toEqual({ allowed: false, reason: 'unknown-provider' });
        expect(canLogoutProvider(undefined, 'netease')).toBe(false);
    });
});

describe('login copy', () => {
    it('uses the provider-specific title and note', () => {
        expect(resolveLoginCopy('kugou')).toEqual({ title: { key: 'home.loginTitleKugou' }, note: { key: 'home.loginNoteKugou' } });
        expect(resolveLoginCopy('qq')).toEqual({ title: { key: 'home.loginTitleQq' }, note: { key: 'home.loginNoteQq' } });
        expect(resolveLoginCopy('bodian')).toEqual({ title: { key: 'home.loginTitleBodian' }, note: { key: 'home.loginNoteBodian' } });
        expect(resolveLoginCopy('netease')).toEqual({ title: { key: 'home.loginTitle' }, note: { key: 'home.loginNote' } });
    });

    it('falls back to the netease copy for unknown and mod providers', () => {
        const netease = { title: { key: 'home.loginTitle' }, note: { key: 'home.loginNote' } };
        expect(resolveLoginCopy('acct-gamma')).toEqual(netease);
        expect(resolveLoginCopy('folium.mod-a.source')).toEqual(netease);
        // 原型链上的名字不算 provider 专属文案。
        expect(resolveLoginCopy('constructor')).toEqual(netease);
        expect(resolveLoginCopy('toString')).toEqual(netease);
    });

    it('maps every QR phase to the status key of the old hook', () => {
        const expected: Record<LibraryLoginPhase, string | null> = {
            'resolving-methods': null,
            'choosing-method': null,
            loading: 'home.loadingQr',
            waiting: 'home.scanQr',
            scanned: 'home.qrScanned',
            confirmed: 'home.loginSuccess',
            expired: 'home.qrExpired',
            error: 'home.loginError',
        };
        for (const [phase, key] of Object.entries(expected) as Array<[LibraryLoginPhase, string | null]>) {
            expect(resolveLoginStatusMessage(phase), phase).toEqual(key ? { key } : null);
        }
    });

    it('picks the scanned-specific diagnostics prompt only for expired-after-scan', () => {
        expect(resolveLoginDiagnosticsPrompt('expired-after-scan')).toEqual({ key: 'home.qrDiagnosticsPromptScanned' });
        for (const failure of ['start-error', 'check-error', 'account-refresh-failed'] as const) {
            expect(resolveLoginDiagnosticsPrompt(failure)).toEqual({ key: 'home.qrDiagnosticsPrompt' });
        }
    });

    it('only hands out keys that exist in the English locale', () => {
        for (const providerId of ['netease', 'kugou', 'qq', 'bodian', 'unknown']) {
            const copy = resolveLoginCopy(providerId);
            expectKey(copy.title.key);
            expectKey(copy.note.key);
        }
        for (const phase of ['loading', 'waiting', 'scanned', 'confirmed', 'expired', 'error'] as const) {
            expectKey(resolveLoginStatusMessage(phase)!.key);
        }
        expectKey(LOGIN_METHOD_STEP_COPY.title.key);
        expectKey(LOGIN_METHOD_STEP_COPY.hint.key);
        expectKey(LOGIN_METHOD_STEP_COPY.pending.key);
        expectKey(resolveLoginDiagnosticsPrompt('expired-after-scan').key);
        expectKey(resolveLoginDiagnosticsPrompt('check-error').key);
    });

    it('hides the status line while choosing a method or when the backend is down', () => {
        expect(resolveLoginSessionCopy({ providerId: 'qq', phase: 'choosing-method', methods: QQ_METHODS, selectedMethodId: null, backend: OK_BACKEND }))
            .toEqual({ title: { key: 'home.loginTitleQq' }, note: { key: 'home.loginNoteQq' }, status: null });
        // 关窗重开回到第一步时，阶段可能还是上一轮的 error：照样不显示。
        expect(resolveLoginSessionCopy({ providerId: 'qq', phase: 'error', methods: QQ_METHODS, selectedMethodId: null, backend: OK_BACKEND }).status)
            .toBeNull();
        expect(resolveLoginSessionCopy({ providerId: 'netease', phase: 'error', methods: [], selectedMethodId: null, backend: FAILED_BACKEND }).status)
            .toBeNull();
        expect(resolveLoginSessionCopy({ providerId: 'qq', phase: 'waiting', methods: QQ_METHODS, selectedMethodId: 'wechat', backend: OK_BACKEND }).status)
            .toEqual({ key: 'home.scanQr' });
        expect(resolveLoginSessionCopy({ providerId: 'acct-gamma', phase: 'expired', methods: [], selectedMethodId: null, backend: OK_BACKEND }))
            .toEqual({ title: { key: 'home.loginTitle' }, note: { key: 'home.loginNote' }, status: { key: 'home.qrExpired' } });
    });
});

describe('login session derivations', () => {
    it('awaits a method only when several are declared and none is picked', () => {
        expect(isAwaitingLoginMethod({ methods: QQ_METHODS, selectedMethodId: null })).toBe(true);
        expect(isAwaitingLoginMethod({ methods: QQ_METHODS, selectedMethodId: 'qq' })).toBe(false);
        expect(isAwaitingLoginMethod({ methods: [], selectedMethodId: null })).toBe(false);
    });

    it('allows retry only after expiry or error, outside the method step, with a healthy backend', () => {
        const retry = (phase: LibraryLoginPhase, extra: Partial<{ methods: QrLoginMethod[]; selectedMethodId: string | null; failed: boolean }> = {}) => canRetryLogin({
            phase,
            methods: extra.methods ?? [],
            selectedMethodId: extra.selectedMethodId ?? null,
            backend: { failed: extra.failed ?? false },
        });
        expect(retry('expired')).toBe(true);
        expect(retry('error')).toBe(true);
        for (const phase of ['resolving-methods', 'choosing-method', 'loading', 'waiting', 'scanned', 'confirmed'] as const) {
            expect(retry(phase), phase).toBe(false);
        }
        expect(retry('expired', { methods: QQ_METHODS, selectedMethodId: null })).toBe(false);
        expect(retry('expired', { methods: QQ_METHODS, selectedMethodId: 'wechat' })).toBe(true);
        expect(retry('error', { failed: true })).toBe(false);
    });

    it('offers diagnostics for any failure unless the backend is down', () => {
        expect(canShowLoginDiagnostics({ failure: 'check-error', backend: OK_BACKEND })).toBe(true);
        expect(canShowLoginDiagnostics({ failure: 'account-refresh-failed', backend: OK_BACKEND })).toBe(true);
        expect(canShowLoginDiagnostics({ failure: null, backend: OK_BACKEND })).toBe(false);
        expect(canShowLoginDiagnostics({ failure: 'start-error', backend: FAILED_BACKEND })).toBe(false);
    });

    it('shows the login dialog except while methods resolve and after the scan is confirmed', () => {
        expect(isLoginDialogVisible(null)).toBe(false);
        expect(isLoginDialogVisible({ phase: 'resolving-methods' })).toBe(false);
        expect(isLoginDialogVisible({ phase: 'confirmed' })).toBe(false);
        for (const phase of ['choosing-method', 'loading', 'waiting', 'scanned', 'expired', 'error'] as const) {
            expect(isLoginDialogVisible({ phase }), phase).toBe(true);
        }
    });
});

describe('login backend state', () => {
    it('reports a failure only for netease with a supported backend in error', () => {
        expect(resolveLoginBackendState('netease', health({ status: 'error', error: 'xeapi key missing' })))
            .toEqual({ failed: true, detail: 'xeapi key missing', restarting: false, canRestart: true });
    });

    it('ignores other providers, the web build and a backend that is not in error', () => {
        const healthy = { failed: false, detail: null, restarting: false, canRestart: false };
        expect(resolveLoginBackendState('kugou', health({ status: 'error', error: 'x' }))).toEqual(healthy);
        expect(resolveLoginBackendState('netease', health({ supported: false, status: 'error', error: 'x' }))).toEqual(healthy);
        expect(resolveLoginBackendState('netease', health({ status: 'starting' }))).toEqual(healthy);
        expect(resolveLoginBackendState('netease', health({ status: null }))).toEqual(healthy);
    });

    it('cannot restart while a restart is in flight', () => {
        expect(resolveLoginBackendState('netease', health({ status: 'error', error: null, restarting: true })))
            .toEqual({ failed: true, detail: null, restarting: true, canRestart: false });
    });

    it('resumes the QR request only once the backend runs again', () => {
        expect(shouldResumeLoginAfterBackendRestart(health({ status: 'running' }))).toBe(true);
        expect(shouldResumeLoginAfterBackendRestart(health({ status: 'error' }))).toBe(false);
        expect(shouldResumeLoginAfterBackendRestart(health({ status: 'starting' }))).toBe(false);
        expect(shouldResumeLoginAfterBackendRestart(health({ status: null }))).toBe(false);
    });
});
