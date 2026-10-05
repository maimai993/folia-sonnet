import type { OnlineProviderId, QrLoginFailureKind, QrLoginState } from '../../../types/onlineMusic';
import type {
    LibraryAccountAuthPort,
    LibraryAccountClock,
    LibraryAccountLogger,
    LibraryLoginDiagnosticsEnvironment,
    LibraryTimerHandle,
} from '../contracts/account';
import { describeAccountError, describeLoginStateMessage } from '../model/accountRules';
import {
    formatQrLoginDiagnosticReport,
    QR_LOGIN_TIMELINE_LIMIT,
    type QrLoginTimelineEvent,
} from '../../../utils/qrLoginDiagnosticReport';

// src/library/core/services/providerLoginSession.ts
// 扫码登录会话（Library v2 · A2）：useOnlineProviderQrLogin 的状态机原样移出 React。无 React、无 window、不直接碰 omni：
// auth 端口、时钟、诊断环境与日志出口都由调用方注入（A3 的账户 controller 组合它，默认装配在 providerAccountDeps）。
// - 串行轮询：上一个 check 结算后才排下一次（2s），不会重叠；
// - 前端 TTL：只有声明了二维码寿命的 provider 才计时，到期先停轮询并 keyed 取消会话，再报「已过期」；
// - 代次：每次 start / stop / TTL 到期都让代次前进，晚到的结果按代次作废；被取代的会话拿到 key 后照样 keyed 归还；
// - 扫码确认后不再取消（后端要让在途轮询继续读到 803），确认回调（账户刷新）返回 false 记为 account-refresh-failed；
// - 时间线 + provider 诊断生成报告（格式与 formatQrLoginDiagnosticReport 相同），同一条记录经日志端口打出。
// - 写进日志与时间线的错误经 accountRules 的 describeAccountError / describeLoginStateMessage：自己接管失败摘要的
//   provider（QQ）只记固定类别，不记原始错误文字与后端返回的 message。
// 快照只放原始状态；文案、后端故障、可见性、能否重试由 A3 用 core/model/accountRules 派生。

/** 两次轮询之间的间隔（上一个请求结算之后才开始计）。 */
export const PROVIDER_LOGIN_POLL_INTERVAL_MS = 2000;

/** idle：还没开始过；loading：正在要码；其余是后端报的状态（与旧 hook 的 QrUiState 相同）。 */
export type ProviderLoginSessionPhase = 'idle' | 'loading' | QrLoginState['state'];

/** 会话的原始状态。没有变化时保持对象身份（useSyncExternalStore 友好）。 */
export type ProviderLoginSessionSnapshot = Readonly<{
    /** 最近一次 start 领到的会话 id（每次要码都换新，对应旧 hook 的 sessionIdRef）；从没 start 过为 0。 */
    sessionId: number;
    /** 最近一次 start 的 provider；从没 start 过为 null。 */
    providerId: OnlineProviderId | null;
    methodId: string | null;
    phase: ProviderLoginSessionPhase;
    /** 二维码图片地址；还没拿到时为空串。 */
    qrImageUrl: string;
    /** 失败形态；没扫就过期、auth 能力缺失都不算失败，为 null。 */
    failure: QrLoginFailureKind | null;
}>;

/** 扫码确认时交给确认回调的事件。 */
export type ProviderLoginConfirmedEvent = {
    sessionId: number;
    providerId: OnlineProviderId;
    methodId: string | null;
};

/**
 * 确认回调：扫码确认后调用（旧 hook 的 onConfirmed），用来刷新账户。resolve `false` 表示扫码确认了却没拿到登录态，
 * 会话回到 error + account-refresh-failed；其余返回值都算完成。回调结算时会话代次已经变了（再次 start / stop），
 * 结果被丢弃。回调抛错按旧行为记为 check-error。
 */
export type ProviderLoginConfirmedHandler = (
    event: ProviderLoginConfirmedEvent,
) => Promise<boolean | void> | boolean | void;

export type ProviderLoginSessionDeps = {
    auth: LibraryAccountAuthPort;
    clock: LibraryAccountClock;
    diagnostics: LibraryLoginDiagnosticsEnvironment;
    /** 省略时打到 console（前缀 [ProviderQrLogin]，与旧 hook 相同）。 */
    log?: LibraryAccountLogger;
    /** 省略时确认即完成（phase 停在 confirmed）。 */
    onConfirmed?: ProviderLoginConfirmedHandler;
};

/**
 * start 的回执：sessionId 同步可得（会话已经进入 loading）；settled 在要码请求结算后 resolve
 * （拿到二维码、失败或被取代），之后的轮询进度只在快照里。
 */
export type ProviderLoginStartTicket = {
    sessionId: number;
    settled: Promise<void>;
};

export interface ProviderLoginSession {
    getSnapshot(): ProviderLoginSessionSnapshot;
    subscribe(listener: () => void): () => void;
    /**
     * 停掉上一轮（keyed 取消它的会话），换新的会话 id 并开始要码。methodId 是 provider 声明的扫码登录方式；
     * 不传由 provider 取默认值。
     */
    start(providerId: OnlineProviderId, methodId?: string): ProviderLoginStartTicket;
    /** 停轮询、清 TTL、keyed 取消当前会话（确认后的会话不取消）。不改快照（与旧 hook 的 stop 相同）。 */
    stop(): void;
    /** 本轮时间线 + provider 诊断；从没 start 过时为 null。 */
    buildDiagnosticReport(): Promise<string | null>;
    /** stop 并放掉全部订阅；之后的 start 不再生效。 */
    dispose(): void;
}

/** 默认日志出口：与旧 hook 打到 console 的记录相同。 */
export const consoleProviderLoginLogger: LibraryAccountLogger = (level, event, detail) => {
    console[level](`[ProviderQrLogin] ${event}`, detail);
};

// 记住活跃会话归谁：keyed 取消必须向开始会话的 provider 发，只存 key 就不知道该向谁取消。
type ActiveQrSession = { providerId: OnlineProviderId; key: string };
type ScheduledTimer = { handle: LibraryTimerHandle };

const INITIAL_SNAPSHOT: ProviderLoginSessionSnapshot = Object.freeze({
    sessionId: 0,
    providerId: null,
    methodId: null,
    phase: 'idle',
    qrImageUrl: '',
    failure: null,
});

const sameSnapshot = (a: ProviderLoginSessionSnapshot, b: ProviderLoginSessionSnapshot): boolean => (
    a.sessionId === b.sessionId
    && a.providerId === b.providerId
    && a.methodId === b.methodId
    && a.phase === b.phase
    && a.qrImageUrl === b.qrImageUrl
    && a.failure === b.failure
);

/** 建一个扫码登录会话；同一时间只有一轮在跑，再次 start 会先停掉上一轮。 */
export const createProviderLoginSession = (deps: ProviderLoginSessionDeps): ProviderLoginSession => {
    const { auth, clock, diagnostics, onConfirmed } = deps;
    const log = deps.log ?? consoleProviderLoginLogger;
    const listeners = new Set<() => void>();
    let snapshot = INITIAL_SNAPSHOT;
    // 代次：start / stop / TTL 到期都前进；每个 await 之后先验代次。
    let generation = 0;
    // 最近一轮扫码的时间线：失败时连同 provider 的诊断一起生成报告。只保留一轮，重新开始即清空。
    let timeline: QrLoginTimelineEvent[] = [];
    let meta: { providerId: OnlineProviderId | null; methodId: string | null; startedAt: number } = {
        providerId: null,
        methodId: null,
        startedAt: 0,
    };
    let checkTimer: ScheduledTimer | null = null;
    let ttlTimer: ScheduledTimer | null = null;
    let activeSession: ActiveQrSession | null = null;
    let lastLoggedPhase: ProviderLoginSessionPhase = 'idle';
    let disposed = false;

    const update = (patch: Partial<ProviderLoginSessionSnapshot>): void => {
        const next = { ...snapshot, ...patch };
        if (sameSnapshot(snapshot, next)) return;
        snapshot = next;
        for (const listener of [...listeners]) listener();
    };

    const schedule = (callback: () => void, ms: number): ScheduledTimer => ({ handle: clock.setTimeout(callback, ms) });

    const clearTimer = (timer: ScheduledTimer | null): null => {
        if (timer) clock.clearTimeout(timer.handle);
        return null;
    };

    // 同一条记录既进时间线，也照旧经日志端口打出（打包版可在开发者设置的日志面板里看到）。
    const note = (event: string, detail: Record<string, unknown> = {}, level: 'info' | 'warn' = 'info'): void => {
        const at = clock.now();
        const entry = { at, event, detail: { ...detail, elapsedMs: at - meta.startedAt } };
        timeline = [...timeline, entry].slice(-QR_LOGIN_TIMELINE_LIMIT);
        log(level, event, { providerId: meta.providerId, ...entry.detail });
    };

    // 取消是 keyed 的，只放掉自己这一把 key；全局清空会在多客户端场景下杀掉别人正在手机上确认的会话。
    // Fire-and-forget：关窗时不该等后端回话，取消失败最多留下一个会自己过期的会话。
    const releaseSession = (session: ActiveQrSession | null): void => {
        if (!session) return;
        const logCancelError = (error: unknown) => {
            log('warn', 'cancel:error', { providerId: session.providerId, ...describeAccountError(session.providerId, error) });
        };
        try {
            void Promise.resolve(auth.cancelQrLogin(session.providerId, session.key)).catch(logCancelError);
        } catch (error) {
            logCancelError(error);
        }
    };

    const stop = (): void => {
        generation += 1;
        checkTimer = clearTimer(checkTimer);
        ttlTimer = clearTimer(ttlTimer);
        releaseSession(activeSession);
        activeSession = null;
    };

    // 一轮扫码：要码 → TTL → 串行轮询。同步部分（auth 能力判定）在 start 返回前就跑完。
    const run = async (sessionId: number, providerId: OnlineProviderId, methodId: string | undefined): Promise<void> => {
        // 扫过码之后才过期，多半是手机端的确认被拒了，要当失败处理。
        let scanned = false;
        let polls = 0;
        note('start', { methodId });
        if (!auth.getProviderCapabilities(providerId).auth) {
            update({ phase: 'error' });
            return;
        }

        try {
            const { key, imageUrl } = await auth.createQrLogin(providerId, methodId);
            if (sessionId !== generation) {
                // 这一轮已被更新的 start（或 stop）取代（例如连点刷新）：把刚拿到的会话还回去，
                // 否则它会一直占着后端直到 TTL 到期。
                releaseSession({ providerId, key });
                return;
            }
            activeSession = { providerId, key };
            update({ qrImageUrl: imageUrl, phase: 'waiting' });
            lastLoggedPhase = 'waiting';
            note('ready');
            // 只有声明了二维码寿命的 provider 才由前端计时；其余仍旧等后端把过期报上来。
            const ttlMs = auth.getQrTtlMs(providerId);
            if (ttlMs !== null) {
                ttlTimer = schedule(() => {
                    note('state', { state: 'expired', source: 'ttl', scanned, polls });
                    // 先停轮询并取消会话，再报「已过期」——此时界面的重试已经可用。
                    stop();
                    update(scanned ? { phase: 'expired', failure: 'expired-after-scan' } : { phase: 'expired' });
                }, ttlMs);
            }
            // Schedules the next check only after the current request settles, preventing overlapping polls.
            const poll = async (): Promise<void> => {
                if (sessionId !== generation) return;
                try {
                    polls += 1;
                    const result = await auth.checkQrLogin(providerId, key);
                    if (sessionId !== generation) return;
                    update({ phase: result.state });
                    if (result.state === 'scanned') scanned = true;
                    if (lastLoggedPhase !== result.state) {
                        lastLoggedPhase = result.state;
                        note('state', {
                            state: result.state,
                            polls,
                            ...(result.state === 'error' ? describeLoginStateMessage(providerId, result.message) : {}),
                        }, result.state === 'error' ? 'warn' : 'info');
                    }
                    if (result.state === 'confirmed') {
                        checkTimer = clearTimer(checkTimer);
                        ttlTimer = clearTimer(ttlTimer);
                        // 会话已经换成登录凭据，不该再取消：后端要让在途的轮询继续读到 803。
                        activeSession = null;
                        const completed = onConfirmed
                            ? await onConfirmed({ sessionId, providerId, methodId: methodId ?? null })
                            : undefined;
                        if (sessionId !== generation) return;
                        note('complete', { completed: completed !== false }, completed === false ? 'warn' : 'info');
                        if (completed === false) update({ phase: 'error', failure: 'account-refresh-failed' });
                    } else if (result.state === 'expired' || result.state === 'error') {
                        checkTimer = null;
                        // 终态不再轮询，留着 TTL 计时器只会在界面关掉后才触发。
                        ttlTimer = clearTimer(ttlTimer);
                        if (result.state === 'error') update({ failure: 'check-error' });
                        else if (scanned) update({ failure: 'expired-after-scan' });
                    } else {
                        checkTimer = schedule(() => { void poll(); }, PROVIDER_LOGIN_POLL_INTERVAL_MS);
                    }
                } catch (error) {
                    if (sessionId !== generation) return;
                    note('check:error', { polls, scanned, ...describeAccountError(providerId, error) }, 'warn');
                    update({ phase: 'error', failure: 'check-error' });
                    checkTimer = null;
                    ttlTimer = clearTimer(ttlTimer);
                }
            };
            checkTimer = schedule(() => { void poll(); }, PROVIDER_LOGIN_POLL_INTERVAL_MS);
        } catch (error) {
            if (sessionId !== generation) return;
            note('start:error', describeAccountError(providerId, error), 'warn');
            update({ phase: 'error', failure: 'start-error' });
        }
    };

    const start = (providerId: OnlineProviderId, methodId?: string): ProviderLoginStartTicket => {
        if (disposed) return { sessionId: snapshot.sessionId, settled: Promise.resolve() };
        stop();
        const sessionId = generation;
        timeline = [];
        meta = { providerId, methodId: methodId ?? null, startedAt: clock.now() };
        lastLoggedPhase = 'loading';
        update({
            sessionId,
            providerId,
            methodId: methodId ?? null,
            phase: 'loading',
            qrImageUrl: '',
            failure: null,
        });
        return { sessionId, settled: run(sessionId, providerId, methodId) };
    };

    // 生成可以直接贴进 issue 的诊断报告：本轮时间线 + provider 自己的诊断（网易会带上主进程记录）。
    const buildDiagnosticReport = async (): Promise<string | null> => {
        const { providerId, methodId } = meta;
        if (providerId === null) return null;
        return formatQrLoginDiagnosticReport({
            generatedAt: clock.now(),
            appVersion: diagnostics.appVersion,
            userAgent: diagnostics.userAgent,
            providerId,
            methodId,
            failure: snapshot.failure,
            timeline,
            providerLines: await auth.getQrLoginDiagnostics(providerId),
        });
    };

    return {
        getSnapshot: () => snapshot,
        subscribe: listener => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        start,
        stop,
        buildDiagnosticReport,
        dispose: () => {
            stop();
            disposed = true;
            listeners.clear();
        },
    };
};
