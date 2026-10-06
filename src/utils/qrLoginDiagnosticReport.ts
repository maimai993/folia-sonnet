import type { OnlineProviderId, QrLoginFailureKind } from '../types/onlineMusic';

// src/utils/qrLoginDiagnosticReport.ts
// 扫码登录诊断报告的格式。报告是给用户原样贴进 issue 的，所以用固定的英文字段、包在代码块里，
// 不随界面语言变化；provider 专属的内容由 provider 自己排好行再交进来。

export type QrLoginTimelineEvent = {
    at: number;
    event: string;
    detail: Record<string, unknown>;
};

export const QR_LOGIN_TIMELINE_LIMIT = 60;

// UTC 时刻，精确到毫秒。渲染进程时间线和主进程请求记录都用它，两边的行才能对着看。
export const formatDiagnosticClock = (at: number): string => new Date(at).toISOString().slice(11, 23);

const formatDetailValue = (value: unknown): string => {
    if (typeof value === 'string') return /\s/.test(value) || value === '' ? JSON.stringify(value) : value;
    if (typeof value === 'number' || typeof value === 'boolean' || value == null) return String(value);
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
};

const formatTimelineEvent = ({ at, event, detail }: QrLoginTimelineEvent): string => {
    const fields = Object.entries(detail)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${formatDetailValue(value)}`);
    return [`  ${formatDiagnosticClock(at)} ${event}`, ...fields].join(' ');
};

// 把一次扫码会话排成可以直接贴进 GitHub issue 的 Markdown 文本。
export const formatQrLoginDiagnosticReport = ({
    generatedAt,
    appVersion,
    userAgent,
    providerId,
    methodId,
    failure,
    timeline,
    providerLines,
}: {
    generatedAt: number;
    appVersion: string | null;
    userAgent: string;
    providerId: OnlineProviderId;
    methodId: string | null;
    failure: QrLoginFailureKind | null;
    timeline: readonly QrLoginTimelineEvent[];
    providerLines: readonly string[];
}): string => [
    '### Folia QR login diagnostics',
    '',
    '```text',
    `generated: ${new Date(generatedAt).toISOString()}`,
    `app: ${appVersion ?? 'unknown'}`,
    `user agent: ${userAgent || 'unknown'}`,
    `provider: ${providerId}${methodId ? ` (method ${methodId})` : ''}`,
    `failure: ${failure ?? 'none'}`,
    `QR session timeline (${timeline.length}, UTC):`,
    ...(timeline.length > 0 ? timeline.map(formatTimelineEvent) : ['  (none)']),
    `${providerId} details:`,
    ...(providerLines.length > 0 ? providerLines.map(line => `  ${line}`) : ['  (none)']),
    '```',
].join('\n');

const FOLIA_NEW_ISSUE_URL = 'https://github.com/chthollyphile/folia-major/issues/new';
// GitHub 对过长的 new-issue 链接会直接报错；超过这个长度就不把报告塞进链接，改让用户粘贴剪贴板里的内容。
const MAX_ISSUE_URL_LENGTH = 7000;

// 生成预填好的 new-issue 链接：报告不长就直接放进正文，太长则只留粘贴提示。
export const buildQrLoginIssueUrl = ({
    providerId,
    report,
    pasteHint,
}: {
    providerId: OnlineProviderId;
    report: string;
    pasteHint: string;
}): string => {
    const title = `[QR login] ${providerId} login failed`;
    const build = (body: string) => `${FOLIA_NEW_ISSUE_URL}?${new URLSearchParams({ title, body }).toString()}`;
    // 报告为空说明生成或复制失败了，同样只留粘贴提示。
    const withReport = report ? build(report) : '';
    return withReport && withReport.length <= MAX_ISSUE_URL_LENGTH ? withReport : build(pasteHint);
};
