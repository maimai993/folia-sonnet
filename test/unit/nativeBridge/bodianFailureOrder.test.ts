import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/nativeBridge/bodianFailureOrder.test.ts
//
// M28 的两半：先判状态码还是先解析响应体，以及带凭据的请求能不能跨主机跟随重定向。
//
// 改前 client.call 的次序是「取响应体 → 判 401 → 判 2xx」：响应体取不出来时抛的是
// invalid-response，401 / 429 / 503 全被错报成「协议格式错误」，状态码直接丢掉 ——
// 限流退避策略（按 429 / 503 认的那一支）于是永远不生效。
// 改前请求还写着 redirect: 'follow'，而 token 在请求头里：上游一旦 302 到别的主机，
// 凭据就跟着过去了。
//
// 这里钉住三种失败各自的分类、以及三种重定向都不带着 token 跨主机。

const SESSION = JSON.stringify({ uid: '42', token: 'fixture-bodian-token', user: { id: '42' } });

/**
 * 发出去的请求条数。
 *
 * 模块级的 client 会在 `user_playlists` 前面先探一次会话（`ensureSessionLoaded`），
 * 那一次也走 fetch —— 数「发了几个请求」必须把它算进来，否则永远数不准。
 */
let sent = 0;

const installSession = async () => {
    sent = 0;
    const slots = new Map<string, string>([['bodian-session', SESSION]]);
    vi.stubGlobal('window', {
        Capacitor: {
            Plugins: {
                FoliaNative: {
                    readSecureValue: async ({ slot }: { slot: string }) => (slots.has(slot)
                        ? { ok: true, found: true, decrypted: true, text: slots.get(slot) }
                        : { ok: true, found: false, decrypted: false, text: null }),
                    writeSecureValue: async ({ slot, text }: { slot: string; text: string }) => {
                        slots.set(slot, text);
                        return { ok: true };
                    },
                    clearSecureValue: async ({ slot }: { slot: string }) => {
                        slots.delete(slot);
                        return { ok: true };
                    },
                    hasSecureValue: async ({ slot }: { slot: string }) => ({ ok: true, exists: slots.has(slot) }),
                },
            },
        },
    });
    const plain = new Map<string, string>();
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => plain.get(String(key)) ?? null,
        setItem: (key: string, value: string) => { plain.set(String(key), String(value)); },
        removeItem: (key: string) => { plain.delete(String(key)); },
        clear: () => { plain.clear(); },
        key: (index: number) => Array.from(plain.keys())[index] ?? null,
        get length() { return plain.size; },
    });
    return import('../../../src/nativeBridge/api/bodian.js');
};

const answer = (status: number, body: string, headers: Record<string, string> = {}) => new Response(body, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
});

/**
 * 一条 3xx 的对象替身。
 *
 * 真的 `Response` 不让把 3xx 当普通响应造出来（会抛 RangeError），而这里要验的正是
 * 「拿到 3xx 之后怎么处理」，所以手搓一个：只要 code 用到的几样。
 */
const redirectTo = (status: number, location: string) => ({
    status,
    ok: false,
    type: 'basic',
    url: 'https://bd-api.kuwo.cn/api/service/playlist/userCreate',
    headers: new Headers({ location }),
    clone() { return this; },
    json: async () => { throw new SyntaxError('no body'); },
});

beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('波点的失败分类（M28）', () => {
    it('响应体不是 JSON 时，401 仍然报要登录，不报协议错误', async () => {
        const bodian = await installSession();
        // 网关常见的样子：401 + 一整页 HTML。
        vi.stubGlobal('fetch', vi.fn(async () => answer(401, '<html><body>unauthorized</body></html>', { 'content-type': 'text/html' })));

        const result = await bodian.handleBodianRequest('user_playlists', { limit: 10, offset: 0 });

        expect(result.ok).toBe(false);
        expect(result.error.code).toBe('auth-required');
    });

    it('响应体是空的 429 仍然报服务不可用那一类，状态码不被解析失败吃掉', async () => {
        const bodian = await installSession();
        vi.stubGlobal('fetch', vi.fn(async () => answer(429, '')));

        const result = await bodian.handleBodianRequest('user_playlists', { limit: 10, offset: 0 });

        expect(result.ok).toBe(false);
        expect(result.error.code).toBe('network');
        // 上游状态码留在文案里：调用方按它决定退避多久（见 bodianFailure.ts）。
        expect(result.error.message).toContain('429');
    });

    it('503 同样按状态码分类，不是 invalid-response', async () => {
        const bodian = await installSession();
        vi.stubGlobal('fetch', vi.fn(async () => answer(503, 'not json at all')));

        const result = await bodian.handleBodianRequest('user_playlists', { limit: 10, offset: 0 });

        expect(result.ok).toBe(false);
        expect(result.error.code).toBe('network');
        expect(result.error.message).toContain('503');
    });

    it('200 但响应体读不出来仍然是协议格式错误', async () => {
        const bodian = await installSession();
        vi.stubGlobal('fetch', vi.fn(async () => answer(200, '<html>proxy page</html>', { 'content-type': 'text/html' })));

        const result = await bodian.handleBodianRequest('user_playlists', { limit: 10, offset: 0 });

        expect(result.ok).toBe(false);
        expect(result.error.code).toBe('invalid-response');
    });
});

describe('波点的重定向（M28）', () => {
    /*
     * 用 `user_albums` 而不是 `user_playlists`：后者一次并发发三条请求，一条撞重定向
     * 时另外两条也已经在路上了，「发了几次」就数不清了。`user_albums` 只发一条。
     */
    const REQUEST = ['user_albums', { limit: 10, offset: 0 }] as const;

    /** 记下每一次 fetch 的地址与 token 头。 */
    const stubRedirect = (status: number, location: string) => {
        const calls: Array<{ url: string; token: string | null }> = [];
        vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
            const headers = (init?.headers ?? {}) as Record<string, string>;
            calls.push({ url: String(input), token: headers.token ?? null });
            sent += 1;
            return redirectTo(status, location);
        }));
        return calls;
    };

    it('跨主机重定向不跟随，凭据不会被带到别的主机上', async () => {
        const bodian = await installSession();
        const calls = stubRedirect(302, 'https://attacker.example.test/steal');

        const result = await bodian.handleBodianRequest(REQUEST[0], REQUEST[1]);

        // 只发了那一次业务请求：看到 3xx 就停，不把带着 token 的请求重发到跳转目标
        // （fetch 的替身根本不会跟，这里验的是我们不再发第二次）。
        expect(sent).toBe(1);
        expect(calls.every(call => !call.url.includes('attacker.example.test'))).toBe(true);
        expect(result.ok).toBe(false);
        // 归成 network（能退避重试的那一类），不是 invalid-response。
        expect(result.error.code).toBe('network');
        // 日志 / 文案说得出跳到了哪台主机，但只给主机，不给完整地址。
        expect(result.error.message).toContain('attacker.example.test');
        expect(result.error.message).not.toContain('/steal');
    });

    it('同主机重定向也不自动跟随：地址变了就重新判一遍', async () => {
        const bodian = await installSession();
        stubRedirect(307, 'https://bd-api.kuwo.cn/api/service/elsewhere');

        const result = await bodian.handleBodianRequest(REQUEST[0], REQUEST[1]);

        expect(sent).toBe(1);
        expect(result.ok).toBe(false);
        expect(result.error.code).toBe('network');
    });

    it('fetch 的 redirect 不再是 follow', async () => {
        const bodian = await installSession();
        const inits: RequestInit[] = [];
        vi.stubGlobal('fetch', vi.fn(async (_input: string, init?: RequestInit) => {
            inits.push(init ?? {});
            sent += 1;
            return answer(200, JSON.stringify({ code: 200, data: { list: [], total: 0 } }));
        }));

        await bodian.handleBodianRequest(REQUEST[0], REQUEST[1]);

        expect(inits).toHaveLength(1);
        expect(inits[0].redirect).toBe('error');
    });

    it('浏览器按 error 拒绝重定向时，同样归成 network 而不是协议错误', async () => {
        const bodian = await installSession();
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new TypeError('Failed to fetch');
        }));

        const result = await bodian.handleBodianRequest(REQUEST[0], REQUEST[1]);

        expect(result.ok).toBe(false);
        expect(result.error.code).toBe('network');
    });
});
