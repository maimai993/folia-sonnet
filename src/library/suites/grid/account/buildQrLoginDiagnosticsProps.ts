import type { TFunction } from 'i18next';
import type { OnlineProviderId, QrLoginFailureKind } from '../../../../types/onlineMusic';
import { buildQrLoginIssueUrl } from '../../../../utils/qrLoginDiagnosticReport';
import { resolveLoginDiagnosticsPrompt } from '../../../core/model/accountRules';
import { translateHomeMessage } from '../../../core/model/homeSources';
import type { QrLoginDiagnosticsPromptProps } from './QrLoginDiagnosticsPrompt';

// src/library/suites/grid/account/buildQrLoginDiagnosticsProps.ts
// 把扫码登录失败的诊断入口翻译成登录弹窗要的 props，Grid3D 只负责在失败时传进来。

export const buildQrLoginDiagnosticsProps = ({
    t,
    providerId,
    failure,
    buildReport,
}: {
    t: TFunction;
    providerId: OnlineProviderId;
    failure: QrLoginFailureKind;
    buildReport: () => Promise<string>;
}): QrLoginDiagnosticsPromptProps => ({
    prompt: translateHomeMessage(t, resolveLoginDiagnosticsPrompt(failure)),
    privacyNote: t('home.qrDiagnosticsPrivacy'),
    copyLabel: t('home.qrDiagnosticsCopy'),
    copiedLabel: t('home.qrDiagnosticsCopied'),
    copyFailedLabel: t('home.qrDiagnosticsCopyFailed'),
    reportLabel: t('home.qrDiagnosticsReport'),
    buildReport,
    buildIssueUrl: report => buildQrLoginIssueUrl({
        providerId,
        report,
        pasteHint: t('home.qrDiagnosticsPasteHint'),
    }),
});
