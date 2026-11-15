import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/qqSessionExpiry.test.ts
//
// #296：QQ 的登录过期之后没有任何提示，界面还显示已登录，而且一直拿旧 cookie 去请求，
// 结果大量歌曲放不出来。
//
// 根因是会话失效时播放接口回的是 **200 + 空播放链接**，不是 401 —— `checkSessionAfterRefusal`
// 只在 401 时触发，所以会话从来没被清掉。这一条测的就是「空链接也要复核一次会话」。

const storage = new Map<string, string>();
/**
 * 会话键：`getProviderSessionKey('qq', 'cookie')` 拼出来的那个（providerStorage.ts），
 * 值是 cookie 字符串本身，不是 JSON。
 */
const SESSION_KEY = 'online_provider:qq:cookie';

const stored = (): string => storage.get(SESSION_KEY) ?? '';
const signIn = (cookie: string) => storage.set(SESSION_KEY, cookie);

describe('QQ Music 会话过期（空播放链接那条路）', () => {
    beforeEach(() => {
        vi.resetModules();
        storage.clear();
        vi.stubEnv('VITE_QQ_API_BASE', 'https://qq.example.test');
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
            removeItem: (key: string) => storage.delete(key),
            key: (index: number) => Array.from(storage.keys())[index] ?? null,
            get length() { return storage.size; },
            clear: () => storage.clear(),
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it('login_status 认不出这个账号时，清掉会话并告诉调用方可以按游客重试', async () => {
        signIn('qqmusic_session=stale');
        // 会话已经失效：login_status 回来的 body 里没有 profile。
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 0, data: {} })));
        const { recheckQqSessionAfterEmptyPlayLink } = await import('@/services/onlineMusic/qq/qqTransport');

        const dropped = await recheckQqSessionAfterEmptyPlayLink();

        expect(dropped).toBe(true);
        expect(stored()).toBe('');
    });

    it('login_status 还认得出账号时不动会话（不能把还能用的登录踢掉）', async () => {
        signIn('qqmusic_session=good');
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 0, data: { profile: { vuin: '123' } } })));
        const { recheckQqSessionAfterEmptyPlayLink } = await import('@/services/onlineMusic/qq/qqTransport');

        const dropped = await recheckQqSessionAfterEmptyPlayLink();

        expect(dropped).toBe(false);
        expect(stored()).not.toBe('');
    });

    it('根本没登录时不问一次 login_status', async () => {
        const fetchMock = vi.fn(async () => Response.json({ code: 0, data: {} }));
        vi.stubGlobal('fetch', fetchMock);
        const { recheckQqSessionAfterEmptyPlayLink } = await import('@/services/onlineMusic/qq/qqTransport');

        expect(await recheckQqSessionAfterEmptyPlayLink()).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('会话被清时广播一条过期事件，界面才有机会提示', async () => {
        signIn('qqmusic_session=stale');
        const events: string[] = [];
        vi.stubGlobal('window', {
            addEventListener: (type: string, listener: (event: Event) => void) => {
                if (type === 'folia-provider-session-expired') (globalThis as any).__qqExpired = listener;
            },
            removeEventListener: () => {},
            dispatchEvent: (event: { detail?: string }) => {
                events.push(String(event.detail));
                return true;
            },
        });
        vi.stubGlobal('CustomEvent', class {
            detail: unknown;
            constructor(_type: string, options?: { detail?: unknown }) {
                this.detail = options?.detail;
            }
        });
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 0, data: {} })));
        const { recheckQqSessionAfterEmptyPlayLink } = await import('@/services/onlineMusic/qq/qqTransport');

        await recheckQqSessionAfterEmptyPlayLink();

        // 事件 detail 是 provider id：界面据此决定提示哪一家过期了。
        expect(events).toContain('qq');
    });

    it('已经有一轮在复核时不再重复发请求', async () => {
        signIn('qqmusic_session=stale');
        let calls = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            calls += 1;
            // 让两次调用真的重叠：复核还没回来时第二个人已经到了。
            await new Promise(resolve => setTimeout(resolve, 10));
            return Response.json({ code: 0, data: {} });
        }));
        const { recheckQqSessionAfterEmptyPlayLink } = await import('@/services/onlineMusic/qq/qqTransport');

        const [first, second] = await Promise.all([
            recheckQqSessionAfterEmptyPlayLink(),
            recheckQqSessionAfterEmptyPlayLink(),
        ]);

        expect(calls).toBe(1);
        expect(first).toBe(true);
        expect(second).toBe(true);
    });
});
