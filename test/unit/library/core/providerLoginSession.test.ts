import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createProviderLoginSession,
    PROVIDER_LOGIN_POLL_INTERVAL_MS,
    type ProviderLoginConfirmedHandler,
    type ProviderLoginSession,
} from '@/library/core/services/providerLoginSession';
import type { LibraryAccountAuthPort, LibraryAccountClock, LibraryAccountLogger } from '@/library/core/contracts/account';
import type { QrLoginState } from '@/types/onlineMusic';

// test/unit/library/core/providerLoginSession.test.ts
// 扫码登录会话服务（A2）：test/unit/hooks/useOnlineProviderQrLogin.test.ts 的每一条行为在这里逐条对应（标注 [hook]），
// 外加服务独有的竞态与日志序列。时钟注入一个手动推进的假时钟，不依赖 vi.useFakeTimers。

const QR_POLL_INTERVAL_MS = PROVIDER_LOGIN_POLL_INTERVAL_MS;
// qqProvider 声明的二维码寿命：175 秒，比后端的 180 秒早一步。
const QR_TTL_MS = 175_000;

/** 手动时钟：advance 按到期顺序逐个触发计时器，每次触发前后把微任务排空（让 await 链走完）。 */
const createManualClock = (start = 1_700_000_000_000) => {
    let now = start;
    let seq = 0;
    const timers = new Map<number, { at: number; seq: number; callback: () => void }>();
    const flush = () => new Promise<void>(resolve => setImmediate(resolve));
    const clock: LibraryAccountClock = {
        now: () => now,
        setTimeout: (callback, ms) => {
            const id = ++seq;
            timers.set(id, { at: now + ms, seq: id, callback });
            return id;
        },
        clearTimeout: handle => { timers.delete(handle as number); },
    };
    const advance = async (ms: number) => {
        const target = now + ms;
        for (; ;) {
            await flush();
            const due = [...timers.entries()]
                .filter(([, timer]) => timer.at <= target)
                .sort(([, a], [, b]) => a.at - b.at || a.seq - b.seq)[0];
            if (!due) break;
            timers.delete(due[0]);
            now = due[1].at;
            due[1].callback();
        }
        now = target;
        await flush();
    };
    return { clock, advance, flush, pendingTimers: () => timers.size };
};

const deferred = <T,>() => {
    let resolve: (value: T) => void = () => { };
    let reject: (error: unknown) => void = () => { };
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
};

let auth: {
    [K in keyof LibraryAccountAuthPort]: ReturnType<typeof vi.fn>;
};
let manual: ReturnType<typeof createManualClock>;
let log: ReturnType<typeof vi.fn<LibraryAccountLogger>>;
let onConfirmed: ReturnType<typeof vi.fn<ProviderLoginConfirmedHandler>>;

const createSession = (overrides: { onConfirmed?: ProviderLoginConfirmedHandler | null } = {}): ProviderLoginSession => (
    createProviderLoginSession({
        auth: auth as unknown as LibraryAccountAuthPort,
        clock: manual.clock,
        diagnostics: { appVersion: '9.9.9-test', userAgent: 'vitest agent' },
        log,
        onConfirmed: overrides.onConfirmed === null
            ? undefined
            : overrides.onConfirmed ?? onConfirmed,
    })
);

describe('providerLoginSession', () => {
    beforeEach(() => {
        manual = createManualClock();
        log = vi.fn<LibraryAccountLogger>();
        onConfirmed = vi.fn<ProviderLoginConfirmedHandler>();
        auth = {
            resolveQrLoginMethods: vi.fn().mockResolvedValue([]),
            getProviderCapabilities: vi.fn().mockReturnValue({ auth: true }),
            createQrLogin: vi.fn().mockResolvedValue({ key: 'qr-key-1', imageUrl: 'qr-1.png' }),
            checkQrLogin: vi.fn().mockResolvedValue({ state: 'waiting' } satisfies QrLoginState),
            cancelQrLogin: vi.fn().mockResolvedValue(undefined),
            getQrTtlMs: vi.fn().mockReturnValue(QR_TTL_MS),
            getQrLoginDiagnostics: vi.fn().mockResolvedValue(['runtime: test']),
        };
    });

    // ─── 旧 hook 测试的逐条迁移 ──────────────────────────────────────────

    it('[hook] cancels the session with the provider that started it', async () => {
        const session = createSession();

        await session.start('netease').settled;
        await session.start('qq', 'wechat').settled;

        expect(auth.createQrLogin.mock.calls).toEqual([['netease', undefined], ['qq', 'wechat']]);
        expect(session.getSnapshot().phase).toBe('waiting');
        // 换 provider 重开：上一轮按它自己的 provider 取消。
        expect(auth.cancelQrLogin).toHaveBeenCalledExactlyOnceWith('netease', 'qr-key-1');

        session.stop();

        // 活跃会话把 provider 与 key 一起记着，才知道该向谁取消。
        expect(auth.cancelQrLogin).toHaveBeenLastCalledWith('qq', 'qr-key-1');
        expect(auth.cancelQrLogin).toHaveBeenCalledTimes(2);
    });

    it('[hook] sends no cancel at all when there is no session to release', () => {
        const session = createSession();

        session.stop();
        session.stop();

        // 取消必须是 keyed 的：没有活跃会话就什么都不发，绝不存在「清空全部」这条路径。
        expect(auth.cancelQrLogin).not.toHaveBeenCalled();
    });

    it('[hook] releases the live session on dispose (the old unmount) and ignores later starts', async () => {
        const session = createSession();
        const listener = vi.fn();
        await session.start('qq').settled;
        session.subscribe(listener);

        session.dispose();

        expect(auth.cancelQrLogin).toHaveBeenCalledExactlyOnceWith('qq', 'qr-key-1');
        expect(manual.pendingTimers()).toBe(0);
        const ticket = session.start('qq');
        await ticket.settled;
        expect(auth.createQrLogin).toHaveBeenCalledTimes(1);
        expect(ticket.sessionId).toBe(session.getSnapshot().sessionId);
        expect(listener).not.toHaveBeenCalled();
    });

    it('[hook] turns the QR expired and releases the session once the front-end TTL elapses', async () => {
        const session = createSession();
        await session.start('qq').settled;

        await manual.advance(QR_TTL_MS - 1);
        expect(session.getSnapshot().phase).toBe('waiting');
        const pollsBeforeExpiry = auth.checkQrLogin.mock.calls.length;

        await manual.advance(1);

        expect(session.getSnapshot().phase).toBe('expired');
        expect(auth.cancelQrLogin).toHaveBeenCalledExactlyOnceWith('qq', 'qr-key-1');

        // 过期之后不该继续空转轮询：用户看到的是可重试的「已过期」，不是一个还在转的二维码。
        await manual.advance(10 * QR_POLL_INTERVAL_MS);
        expect(auth.checkQrLogin.mock.calls.length).toBe(pollsBeforeExpiry);
    });

    it('[hook] runs no front-end timer for a provider that declares no QR lifetime', async () => {
        auth.getQrTtlMs.mockReturnValue(null);
        const session = createSession();

        await session.start('netease').settled;
        await manual.advance(4 * QR_TTL_MS);

        // netease / kugou 的二维码寿命无从得知，仍旧只认后端报出的过期状态。
        expect(session.getSnapshot().phase).toBe('waiting');
        expect(auth.cancelQrLogin).not.toHaveBeenCalled();
    });

    it('[hook] keeps exactly one active session when start runs twice, e.g. on a login-method switch', async () => {
        auth.createQrLogin
            .mockResolvedValueOnce({ key: 'qr-key-1', imageUrl: 'qr-1.png' })
            .mockResolvedValueOnce({ key: 'qr-key-2', imageUrl: 'qr-2.png' });
        const session = createSession();

        await session.start('qq', 'qq').settled;
        await session.start('qq', 'wechat').settled;

        expect(auth.cancelQrLogin).toHaveBeenCalledExactlyOnceWith('qq', 'qr-key-1');
        expect(session.getSnapshot().qrImageUrl).toBe('qr-2.png');

        session.stop();
        expect(auth.cancelQrLogin.mock.calls).toEqual([['qq', 'qr-key-1'], ['qq', 'qr-key-2']]);
    });

    it('[hook] hands back a session that was superseded while its request was still in flight', async () => {
        const first = deferred<{ key: string; imageUrl: string }>();
        auth.createQrLogin
            .mockImplementationOnce(() => first.promise)
            .mockResolvedValueOnce({ key: 'qr-key-2', imageUrl: 'qr-2.png' });
        const session = createSession();

        const superseded = session.start('qq');
        await session.start('qq').settled;
        first.resolve({ key: 'qr-key-1', imageUrl: 'qr-1.png' });
        await superseded.settled;

        // 连点刷新时第一轮的 key 从没成为活跃会话，不还回去就会一直占着后端到 TTL 到期。
        expect(auth.cancelQrLogin).toHaveBeenCalledExactlyOnceWith('qq', 'qr-key-1');
        expect(session.getSnapshot().qrImageUrl).toBe('qr-2.png');
    });

    it('[hook] clears the TTL timer on a terminal state so it cannot fire behind a closed dialog', async () => {
        auth.checkQrLogin.mockResolvedValue({ state: 'error', message: 'QR login failed' });
        const session = createSession();
        await session.start('qq').settled;

        await manual.advance(QR_POLL_INTERVAL_MS);
        expect(session.getSnapshot().phase).toBe('error');

        await manual.advance(2 * QR_TTL_MS);

        // 计时器要是还活着，就会把一个可重试的错误改写成「已过期」，还多发一次取消。
        expect(session.getSnapshot().phase).toBe('error');
        expect(auth.cancelQrLogin).not.toHaveBeenCalled();
        expect(manual.pendingTimers()).toBe(0);
    });

    it('[hook] never cancels a confirmed session, because a poll in flight still has to read 803', async () => {
        auth.checkQrLogin.mockResolvedValue({ state: 'confirmed' });
        const session = createSession();
        const { sessionId } = session.start('qq', 'wechat');
        await manual.flush();

        await manual.advance(QR_POLL_INTERVAL_MS);
        expect(onConfirmed).toHaveBeenCalledExactlyOnceWith({ sessionId, providerId: 'qq', methodId: 'wechat' });

        session.stop();

        expect(auth.cancelQrLogin).not.toHaveBeenCalled();
        expect(manual.pendingTimers()).toBe(0);
    });

    it('[hook] reports no failure when a QR nobody scanned simply expires', async () => {
        const session = createSession();
        await session.start('qq').settled;

        await manual.advance(QR_TTL_MS);

        expect(session.getSnapshot().phase).toBe('expired');
        expect(session.getSnapshot().failure).toBeNull();
    });

    it('[hook] treats a QR that expires after being scanned as a failed login', async () => {
        auth.checkQrLogin.mockResolvedValue({ state: 'scanned' });
        const session = createSession();
        await session.start('qq').settled;

        await manual.advance(QR_TTL_MS);

        // 扫过码却一直等不到确认，多半是手机端的确认被拒了，用户需要诊断入口。
        expect(session.getSnapshot()).toMatchObject({ phase: 'expired', failure: 'expired-after-scan' });
    });

    it('[hook] marks a confirmed login whose account cannot be loaded as failed', async () => {
        auth.checkQrLogin.mockResolvedValue({ state: 'confirmed' });
        onConfirmed.mockResolvedValue(false);
        const session = createSession();
        await session.start('netease').settled;

        await manual.advance(QR_POLL_INTERVAL_MS);

        expect(session.getSnapshot()).toMatchObject({ phase: 'error', failure: 'account-refresh-failed' });
    });

    it('[hook] builds a report from this session only and clears the failure on retry', async () => {
        auth.checkQrLogin.mockResolvedValue({ state: 'error', message: 'code 404: Not Found' });
        const session = createSession();
        await session.start('netease').settled;
        await manual.advance(QR_POLL_INTERVAL_MS);

        expect(session.getSnapshot().failure).toBe('check-error');
        const report = await session.buildDiagnosticReport();
        expect(report).toContain('app: 9.9.9-test');
        expect(report).toContain('user agent: vitest agent');
        expect(report).toContain('provider: netease');
        expect(report).toContain('failure: check-error');
        expect(report).toMatch(/ state state=error polls=1 message="code 404: Not Found" elapsedMs=2000/);
        expect(report).toContain('  runtime: test');
        expect(auth.getQrLoginDiagnostics).toHaveBeenCalledWith('netease');

        auth.checkQrLogin.mockResolvedValue({ state: 'waiting' });
        await session.start('netease').settled;
        expect(session.getSnapshot().failure).toBeNull();
        expect(await session.buildDiagnosticReport()).not.toContain('state=error');
    });

    // ─── 服务独有的行为 ──────────────────────────────────────────────────

    it('issues a new session id on every start and exposes the raw snapshot from loading on', async () => {
        const session = createSession();
        expect(session.getSnapshot()).toEqual({
            sessionId: 0, providerId: null, methodId: null, phase: 'idle', qrImageUrl: '', failure: null,
        });

        const first = session.start('qq', 'qq');
        expect(session.getSnapshot()).toEqual({
            sessionId: first.sessionId, providerId: 'qq', methodId: 'qq', phase: 'loading', qrImageUrl: '', failure: null,
        });
        await first.settled;
        expect(session.getSnapshot()).toMatchObject({ phase: 'waiting', qrImageUrl: 'qr-1.png' });

        const second = session.start('qq');
        expect(second.sessionId).toBeGreaterThan(first.sessionId);
        expect(session.getSnapshot()).toMatchObject({ sessionId: second.sessionId, methodId: null, qrImageUrl: '' });
    });

    it('keeps the snapshot identity while nothing changes and notifies subscribers only on change', async () => {
        const session = createSession();
        const listener = vi.fn();
        const unsubscribe = session.subscribe(listener);
        await session.start('qq').settled;
        const waiting = session.getSnapshot();
        const notified = listener.mock.calls.length;
        expect(notified).toBe(2); // loading → waiting

        // 后端一直报 waiting：快照不换身份，也不通知。
        await manual.advance(5 * QR_POLL_INTERVAL_MS);
        expect(auth.checkQrLogin).toHaveBeenCalledTimes(5);
        expect(session.getSnapshot()).toBe(waiting);
        expect(listener).toHaveBeenCalledTimes(notified);

        // stop 不改快照（与旧 hook 一致：清快照是 controller 的事）。
        session.stop();
        expect(session.getSnapshot()).toBe(waiting);

        unsubscribe();
        session.start('qq');
        expect(listener).toHaveBeenCalledTimes(notified);
    });

    it('polls serially: the next check is scheduled only after the previous one settles', async () => {
        const slow = deferred<QrLoginState>();
        auth.checkQrLogin.mockImplementationOnce(() => slow.promise);
        const session = createSession();
        await session.start('qq').settled;

        await manual.advance(QR_POLL_INTERVAL_MS);
        expect(auth.checkQrLogin).toHaveBeenCalledTimes(1);
        await manual.advance(5 * QR_POLL_INTERVAL_MS);
        expect(auth.checkQrLogin).toHaveBeenCalledTimes(1);

        slow.resolve({ state: 'scanned' });
        await manual.flush();
        expect(session.getSnapshot().phase).toBe('scanned');
        await manual.advance(QR_POLL_INTERVAL_MS - 1);
        expect(auth.checkQrLogin).toHaveBeenCalledTimes(1);
        await manual.advance(1);
        expect(auth.checkQrLogin).toHaveBeenCalledTimes(2);
        expect(auth.checkQrLogin).toHaveBeenLastCalledWith('qq', 'qr-key-1');
    });

    it('errors straight away without asking for a QR when the provider has no auth capability', async () => {
        auth.getProviderCapabilities.mockReturnValue({ auth: false });
        const session = createSession();

        const ticket = session.start('mod-source');
        // 能力判定在 start 返回前就跑完。
        expect(session.getSnapshot()).toMatchObject({ phase: 'error', failure: null });
        await ticket.settled;

        expect(auth.createQrLogin).not.toHaveBeenCalled();
        expect(manual.pendingTimers()).toBe(0);
    });

    it('classifies a failed QR request as start-error', async () => {
        auth.createQrLogin.mockRejectedValue(new TypeError('Failed to fetch'));
        const session = createSession();

        await session.start('netease').settled;

        expect(session.getSnapshot()).toMatchObject({ phase: 'error', failure: 'start-error' });
        expect(auth.checkQrLogin).not.toHaveBeenCalled();
        expect(log).toHaveBeenLastCalledWith('warn', 'start:error', expect.objectContaining({
            providerId: 'netease', name: 'TypeError', message: 'Failed to fetch',
        }));
    });

    it('classifies a thrown check as check-error and stops polling and the TTL', async () => {
        auth.checkQrLogin
            .mockResolvedValueOnce({ state: 'scanned' })
            .mockRejectedValueOnce(new Error('socket hang up'));
        const session = createSession();
        await session.start('qq').settled;

        await manual.advance(2 * QR_POLL_INTERVAL_MS);

        expect(session.getSnapshot()).toMatchObject({ phase: 'error', failure: 'check-error' });
        expect(manual.pendingTimers()).toBe(0);
        expect(log).toHaveBeenLastCalledWith('warn', 'check:error', expect.objectContaining({
            providerId: 'qq', polls: 2, scanned: true, message: 'socket hang up',
        }));
    });

    it('counts a backend-reported expiry after a scan as expired-after-scan and keeps the session until stop', async () => {
        auth.checkQrLogin
            .mockResolvedValueOnce({ state: 'scanned' })
            .mockResolvedValueOnce({ state: 'expired' });
        const session = createSession();
        await session.start('qq').settled;

        await manual.advance(2 * QR_POLL_INTERVAL_MS);

        expect(session.getSnapshot()).toMatchObject({ phase: 'expired', failure: 'expired-after-scan' });
        expect(manual.pendingTimers()).toBe(0);
        // 后端报的过期不立即取消（A0 钉着的现状）：重试 / 关窗时才释放。
        expect(auth.cancelQrLogin).not.toHaveBeenCalled();
        session.stop();
        expect(auth.cancelQrLogin).toHaveBeenCalledExactlyOnceWith('qq', 'qr-key-1');
    });

    it('drops the confirm callback result when a new start supersedes the session meanwhile', async () => {
        const refresh = deferred<boolean>();
        onConfirmed.mockImplementation(() => refresh.promise);
        auth.checkQrLogin.mockResolvedValueOnce({ state: 'confirmed' });
        auth.createQrLogin
            .mockResolvedValueOnce({ key: 'qr-key-1', imageUrl: 'qr-1.png' })
            .mockResolvedValueOnce({ key: 'qr-key-2', imageUrl: 'qr-2.png' });
        const session = createSession();
        await session.start('qq').settled;
        await manual.advance(QR_POLL_INTERVAL_MS);
        expect(onConfirmed).toHaveBeenCalledTimes(1);

        auth.checkQrLogin.mockResolvedValue({ state: 'waiting' });
        const next = session.start('qq');
        await next.settled;
        refresh.resolve(false);
        await manual.flush();

        // 刷新失败的结论属于上一轮：不能把新一轮改成 account-refresh-failed，也不记 complete。
        expect(session.getSnapshot()).toMatchObject({
            sessionId: next.sessionId, phase: 'waiting', failure: null, qrImageUrl: 'qr-2.png',
        });
        expect(log.mock.calls.map(([, event]) => event)).not.toContain('complete');
        // 已确认的会话不在新 start 时被取消。
        expect(auth.cancelQrLogin).not.toHaveBeenCalled();
    });

    it('hands back a QR that arrives after stop', async () => {
        const pending = deferred<{ key: string; imageUrl: string }>();
        auth.createQrLogin.mockImplementationOnce(() => pending.promise);
        const session = createSession();
        const ticket = session.start('kugou');

        session.stop();
        expect(auth.cancelQrLogin).not.toHaveBeenCalled();
        pending.resolve({ key: 'late-key', imageUrl: 'late.png' });
        await ticket.settled;

        expect(auth.cancelQrLogin).toHaveBeenCalledExactlyOnceWith('kugou', 'late-key');
        expect(session.getSnapshot()).toMatchObject({ phase: 'loading', qrImageUrl: '' });
        expect(manual.pendingTimers()).toBe(0);
    });

    it('logs the same records it keeps in the timeline, in order', async () => {
        auth.checkQrLogin
            .mockResolvedValueOnce({ state: 'waiting' })
            .mockResolvedValueOnce({ state: 'scanned' })
            .mockResolvedValueOnce({ state: 'scanned' })
            .mockResolvedValueOnce({ state: 'confirmed' });
        const session = createSession();
        await session.start('qq', 'wechat').settled;

        await manual.advance(4 * QR_POLL_INTERVAL_MS);

        // 同一状态只记一次；确认后记 complete。
        expect(log.mock.calls).toEqual([
            ['info', 'start', { providerId: 'qq', methodId: 'wechat', elapsedMs: 0 }],
            ['info', 'ready', { providerId: 'qq', elapsedMs: 0 }],
            ['info', 'state', { providerId: 'qq', state: 'scanned', polls: 2, elapsedMs: 4000 }],
            ['info', 'state', { providerId: 'qq', state: 'confirmed', polls: 4, elapsedMs: 8000 }],
            ['info', 'complete', { providerId: 'qq', completed: true, elapsedMs: 8000 }],
        ]);
        const report = await session.buildDiagnosticReport();
        expect(report).toContain('provider: qq (method wechat)');
        expect(report).toContain('QR session timeline (5, UTC):');
    });

    it('logs the TTL expiry, the refresh failure and cancel errors as the old hook did', async () => {
        auth.cancelQrLogin.mockRejectedValue(new Error('gone'));
        const session = createSession();
        await session.start('qq').settled;
        await manual.advance(QR_TTL_MS);

        expect(log.mock.calls.slice(2)).toEqual([
            ['info', 'state', { providerId: 'qq', state: 'expired', source: 'ttl', scanned: false, polls: 87, elapsedMs: QR_TTL_MS }],
            ['warn', 'cancel:error', { providerId: 'qq', name: 'Error', message: 'gone' }],
        ]);

        log.mockClear();
        auth.checkQrLogin.mockResolvedValue({ state: 'confirmed' });
        onConfirmed.mockResolvedValue(false);
        await session.start('qq').settled;
        await manual.advance(QR_POLL_INTERVAL_MS);
        expect(log).toHaveBeenLastCalledWith('warn', 'complete', { providerId: 'qq', completed: false, elapsedMs: 2000 });
    });

    it('treats a throwing confirm callback as check-error (old behaviour, kept)', async () => {
        auth.checkQrLogin.mockResolvedValue({ state: 'confirmed' });
        onConfirmed.mockRejectedValue(new Error('refresh exploded'));
        const session = createSession();
        await session.start('netease').settled;

        await manual.advance(QR_POLL_INTERVAL_MS);

        expect(session.getSnapshot()).toMatchObject({ phase: 'error', failure: 'check-error' });
    });

    it('stays confirmed without a confirm callback', async () => {
        auth.checkQrLogin.mockResolvedValue({ state: 'confirmed' });
        const session = createSession({ onConfirmed: null });
        await session.start('qq').settled;

        await manual.advance(QR_POLL_INTERVAL_MS);

        expect(session.getSnapshot()).toMatchObject({ phase: 'confirmed', failure: null });
        expect(log).toHaveBeenLastCalledWith('info', 'complete', expect.objectContaining({ completed: true }));
    });

    it('has no report before the first start', async () => {
        const session = createSession();
        expect(await session.buildDiagnosticReport()).toBeNull();
        expect(auth.getQrLoginDiagnostics).not.toHaveBeenCalled();
    });

    it('falls back to the console logger with the old prefix when no logger is injected', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => { });
        const session = createProviderLoginSession({
            auth: auth as unknown as LibraryAccountAuthPort,
            clock: manual.clock,
            diagnostics: { appVersion: null, userAgent: '' },
        });

        await session.start('qq').settled;

        expect(info).toHaveBeenCalledWith('[ProviderQrLogin] start', { providerId: 'qq', methodId: undefined, elapsedMs: 0 });
        info.mockRestore();
    });
});
