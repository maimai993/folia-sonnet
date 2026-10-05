import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TFunction } from 'i18next';
import { describe, expect, it, vi } from 'vitest';
import { translateLoginSession } from '../../../src/library/core/bindings/useLibraryAccount';
import { resolveLoginSessionCopy } from '../../../src/library/core/model/accountRules';
import type { LibraryLoginSessionSnapshot } from '../../../src/library/core/contracts/account';
import { buildQrLoginDiagnosticsProps } from '../../../src/library/suites/grid/account/buildQrLoginDiagnosticsProps';
import OnlineProviderLoginModal from '../../../src/library/suites/grid/account/OnlineProviderLoginModal';
import type { QrLoginFailureKind } from '../../../src/types/onlineMusic';

// test/unit/navigation/qrLoginDiagnosticsPresentation.test.ts
// 登录失败后的诊断区块：是否显示由 core 规则（canShowLoginDiagnostics → 视图的 diagnosticsPrompt）决定，
// grid 的登录弹窗与 TUI 的 F4 都只认它。这里走「快照 → translateLoginSession → 网格弹窗」这一条，
// 与 GridAccountSurface 的装配同形；QQ 不给诊断区块（PR #495），其余 provider 保持原样。

const failures: QrLoginFailureKind[] = [
    'start-error', 'check-error', 'expired-after-scan', 'account-refresh-failed',
];

const t = ((key: string) => key) as unknown as TFunction;

const errorSession = (providerId: string, failure: QrLoginFailureKind): LibraryLoginSessionSnapshot => {
    const base = {
        id: 1,
        providerId,
        phase: 'error' as const,
        methods: [],
        selectedMethodId: null,
        qrImageUrl: '',
        failure,
        retryCooldownSeconds: null,
        backend: { failed: false, detail: null, restarting: false, canRestart: false },
    };
    return { ...base, copy: resolveLoginSessionCopy(base) };
};

const renderFailure = (providerId: string, failure: QrLoginFailureKind) => {
    const buildReport = vi.fn(async () => 'report');
    const view = translateLoginSession(t, errorSession(providerId, failure));
    const diagnostics = view.diagnosticsPrompt && view.session.failure
        ? buildQrLoginDiagnosticsProps({ t, providerId, failure: view.session.failure, buildReport })
        : undefined;
    const html = renderToStaticMarkup(createElement(OnlineProviderLoginModal, {
        title: view.title, note: view.note, qrCodeImg: '', statusText: view.status ?? '',
        state: 'error', retryLabel: view.retryLabel, closeLabel: view.closeLabel, diagnostics,
        onRetry: () => {}, onClose: () => {},
    }));
    return { view, diagnostics, html, buildReport };
};

describe('QR login diagnostics presentation', () => {
    it.each(failures)('removes the entire QQ diagnostics block for %s', failure => {
        const { view, diagnostics, html, buildReport } = renderFailure('qq', failure);
        expect(view.canShowDiagnostics).toBe(false);
        expect(view.diagnosticsPrompt).toBeNull();
        expect(diagnostics).toBeUndefined();
        expect(html).not.toContain('home.qrDiagnostics');
        expect(html).toContain('home.loginError');
        expect(html).toContain('home.retryQr');
        expect(html).toContain('home.closeLogin');
        expect(buildReport).not.toHaveBeenCalled();
    });

    it.each(['netease', 'kugou'])('keeps %s diagnostics and buttons', providerId => {
        for (const failure of failures) {
            const { view, diagnostics, html, buildReport } = renderFailure(providerId, failure);
            const prompt = failure === 'expired-after-scan' ? 'home.qrDiagnosticsPromptScanned' : 'home.qrDiagnosticsPrompt';
            expect(view.diagnosticsPrompt).toBe(prompt);
            expect(diagnostics?.prompt).toBe(prompt);
            expect(html).toContain('home.qrDiagnosticsPrivacy');
            expect(html).toContain('home.qrDiagnosticsCopy');
            expect(html).toContain('home.qrDiagnosticsReport');
            expect(diagnostics?.buildReport).toBe(buildReport);
            expect(buildReport).not.toHaveBeenCalled();
        }
    });
});
