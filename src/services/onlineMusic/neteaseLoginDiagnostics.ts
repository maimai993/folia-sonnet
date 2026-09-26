import { formatDiagnosticClock } from '../../utils/qrLoginDiagnosticReport';
import { readProviderSessionValue } from './providerStorage';

// src/services/onlineMusic/neteaseLoginDiagnostics.ts
// 网易扫码登录诊断报告里的 provider 专属部分。真正有用的现场在 Electron 主进程：上游会把网易的
// 真实返回码吞成 404，只有主进程的请求层记下了它（electron/neteaseLoginDiagnostics.cjs）。

type NeteaseLoginSession = {
    hasLoginCookie: boolean;
    hasAnonymousCookie: boolean;
};

const yesNo = (value: boolean | undefined): string => (value === undefined ? 'unknown' : value ? 'yes' : 'no');

const formatRequest = (request: ElectronNeteaseLoginRequestRecord): string => {
    const { outcome } = request;
    return [
        `  ${formatDiagnosticClock(request.at)} ${request.uri}`,
        outcome.settled,
        `status=${outcome.status ?? '-'}`,
        `code=${outcome.code ?? '-'}`,
        outcome.message ? `msg="${outcome.message}"` : '',
        request.durationMs === null ? '' : `${request.durationMs}ms`,
        `ip-header=${request.ipHeader}`,
        `device=…${request.deviceIdTail || '-'}`,
        `MUSIC_U=${yesNo(request.hasMusicU)}`,
        `MUSIC_A=${yesNo(request.hasMusicA)}`,
    ].filter(Boolean).join(' ');
};

// 把主进程快照和渲染进程会话状态排成报告行；纯函数，便于测试。
export const formatNeteaseLoginDiagnostics = (
    snapshot: ElectronNeteaseLoginDiagnostics | null,
    session: NeteaseLoginSession,
): string[] => {
    const lines = [
        `session: login cookie=${yesNo(session.hasLoginCookie)}, anonymous cookie=${yesNo(session.hasAnonymousCookie)}`,
    ];
    if (!snapshot) {
        return ['runtime: web (remote API, no main-process record)', ...lines];
    }

    const { app, apiStatus, startup, network, requests } = snapshot;
    const interfaces = network.interfaces
        .map(item => `${item.name}[${[item.ipv4 ? 'v4' : '', item.globalIpv6 ? 'v6' : ''].filter(Boolean).join(',') || '-'}]`)
        .join(', ');
    const deviceTails = [...new Set(requests.map(request => request.deviceIdTail).filter(Boolean))];
    return [
        'runtime: electron (local API)',
        `app: ${app.version} electron ${app.electron} ${app.platform} ${app.arch} (${app.osRelease})`,
        `local api: ${apiStatus.status} ${startup.listenHost ?? '?'}:${apiStatus.port ?? '-'}${apiStatus.error ? ` error="${apiStatus.error}"` : ''}`,
        `startup: anonymous token at load=${startup.anonymousTokenAtLoad ?? 'unknown'}, anonymous refresh=${yesNo(startup.anonymousTokenRefreshed)}, xeapi key=${startup.xeapiKeySource ?? 'unknown'} v${startup.xeapiKeyVersion ?? '?'}`,
        `network: global IPv6 addresses=${network.globalIpv6Count}; interfaces: ${interfaces || 'none'}`,
        ...lines,
        // 同一轮扫码里 deviceId 变过，是已知的一个可疑点（渲染进程注册匿名身份会改掉主进程的全局 deviceId）。
        `device ids seen in login requests: ${deviceTails.length}`,
        `login requests (${requests.length}, oldest first, UTC):`,
        ...(requests.length > 0 ? requests.map(formatRequest) : ['  (none)']),
    ];
};

// 收集网易扫码登录的诊断行。Web 端没有主进程可问，只报会话状态。
export const collectNeteaseLoginDiagnostics = async (): Promise<string[]> => {
    const session = {
        hasLoginCookie: Boolean(readProviderSessionValue('netease', 'cookie', ['netease_cookie'])),
        hasAnonymousCookie: Boolean(readProviderSessionValue('netease', 'anonymous_cookie', ['netease_anonymous_cookie'])),
    };
    const getSnapshot = typeof window === 'undefined' ? undefined : window.electron?.getNeteaseLoginDiagnostics;
    const snapshot = getSnapshot ? await getSnapshot() : null;
    return formatNeteaseLoginDiagnostics(snapshot, session);
};
