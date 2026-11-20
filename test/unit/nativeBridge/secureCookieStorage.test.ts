// test/unit/nativeBridge/secureCookieStorage.test.ts
//
// H5：平台 cookie 不再明文进 `chrome.storage.local`（安卓上就是页面 localStorage）。
//
// 这一组钉住三件事：
//   1. 新登录只写加密槽位，localStorage 里不再留一份明文；
//   2. 升级后第一次读：明文搬进加密槽位**成功之后**才删明文（写不进去就留着，下次再试）；
//   3. 解不开的槽位不当成「没登录」，也不拿明文去覆盖它。
//
// H30 的波点会话同样是这套机制（槽位名不同），一起在这里核对。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NEVER = () => new Promise<never>(() => {});

type HostOptions = {
    /** 加密槽位已有内容：slot → 明文。 */
    slots?: Array<[string, string]>;
    /** localStorage 里的明文旧键。 */
    plain?: Array<[string, string]>;
    /** 写加密槽位失败（Keystore 不可用）。 */
    writeFails?: boolean;
    /** 槽位存在但解不开（换机 / Keystore 被重置）。 */
    undecryptable?: boolean;
    /** 桥不回包。 */
    hangs?: boolean;
};

const installHost = (options: HostOptions = {}) => {
    const slots = new Map<string, string>(options.slots ?? []);
    const plain = new Map<string, string>(options.plain ?? []);
    const writes: string[] = [];
    const plugin = {
        readSecureValue: async ({ slot }: { slot: string }) => {
            if (options.hangs) return NEVER();
            if (options.undecryptable) return { ok: true, found: true, decrypted: false, text: null };
            return slots.has(slot)
                ? { ok: true, found: true, decrypted: true, text: slots.get(slot) }
                : { ok: true, found: false, decrypted: false, text: null };
        },
        writeSecureValue: async ({ slot, text }: { slot: string; text: string }) => {
            writes.push(slot);
            if (options.writeFails) return { ok: false };
            slots.set(slot, text);
            return { ok: true };
        },
        clearSecureValue: async ({ slot }: { slot: string }) => {
            slots.delete(slot);
            return { ok: true };
        },
        hasSecureValue: async ({ slot }: { slot: string }) => ({ ok: true, exists: slots.has(slot) }),
    };
    vi.stubGlobal('window', { Capacitor: { Plugins: { FoliaNative: plugin } } });
    // node 环境没有 localStorage（test/unit/jsdomLocalStorage.ts 会把它删掉），给一份内存替身。
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => plain.get(String(key)) ?? null,
        setItem: (key: string, value: string) => { plain.set(String(key), String(value)); },
        removeItem: (key: string) => { plain.delete(String(key)); },
        clear: () => { plain.clear(); },
        key: (index: number) => Array.from(plain.keys())[index] ?? null,
        get length() { return plain.size; },
    });
    vi.stubGlobal('chrome', {
        cookies: {
            getAll: async () => [],
            get: async () => null,
            set: async () => undefined,
            remove: async () => null,
        },
        storage: {
            local: {
                get: async (keys: string[] | string) => {
                    const list = Array.isArray(keys) ? keys : [keys];
                    return Object.fromEntries(list.filter(key => plain.has(key)).map(key => [key, plain.get(key)]));
                },
                set: async (values: Record<string, string>) => {
                    Object.entries(values).forEach(([key, value]) => plain.set(key, value));
                },
                remove: async (keys: string[] | string) => {
                    (Array.isArray(keys) ? keys : [keys]).forEach(key => plain.delete(key));
                },
            },
        },
    });
    return { slots, plain, writes };
};

beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const NET_COOKIE = 'MUSIC_U=fixture-music-u; __csrf=fixture-csrf';

describe('平台 cookie 的加密落盘（H5）', () => {
    it('新登录只写加密槽位，localStorage 里没有明文', async () => {
        const host = installHost();
        const { saveProviderCookie } = await import('../../../src/nativeBridge/api/cookies.js');

        await saveProviderCookie('netease', NET_COOKIE);

        expect(host.slots.get('provider-netease-cookie')).toContain('MUSIC_U=fixture-music-u');
        expect(host.plain.size).toBe(0);
    });

    it('升级迁移：明文搬进加密槽位后删掉', async () => {
        const host = installHost({
            slots: [],
            plain: [['foliaBridgeNeteaseCookie', NET_COOKIE]],
        });
        const { getNeteaseCookie } = await import('../../../src/nativeBridge/api/cookies.js');

        // 读一次就触发迁移（读之前要先知道槽位里有没有）。
        await getNeteaseCookie();

        expect(host.slots.get('provider-netease-cookie')).toBe(NET_COOKIE);
        expect(host.plain.has('foliaBridgeNeteaseCookie')).toBe(false);
    });

    it('迁移时加密写失败：明文原样留着，下次还能再试', async () => {
        const host = installHost({
            writeFails: true,
            plain: [['foliaBridgeNeteaseCookie', NET_COOKIE]],
        });
        const { getNeteaseCookie } = await import('../../../src/nativeBridge/api/cookies.js');

        await getNeteaseCookie();

        // 没写进去，也没删：用户的登录不能因为一次写失败就消失。
        expect(host.plain.get('foliaBridgeNeteaseCookie')).toBe(NET_COOKIE);
        expect(host.slots.size).toBe(0);
    });

    it('槽位解不开时不拿明文去覆盖它（升级现场的另一半）', async () => {
        const host = installHost({
            undecryptable: true,
            plain: [['foliaBridgeNeteaseCookie', NET_COOKIE]],
        });
        const { getNeteaseCookie, isCookieReadError } = await import('../../../src/nativeBridge/api/cookies.js');

        await expect(getNeteaseCookie()).rejects.toSatisfy(isCookieReadError);
        expect(host.writes).toEqual([]);
        expect(host.plain.get('foliaBridgeNeteaseCookie')).toBe(NET_COOKIE);
    });

    it('没有原生存储的环境照旧用 localStorage（桌面 / 单测）', async () => {
        vi.stubGlobal('window', {});
        const plain = new Map<string, string>();
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => plain.get(String(key)) ?? null,
            setItem: (key: string, value: string) => { plain.set(String(key), String(value)); },
            removeItem: (key: string) => { plain.delete(String(key)); },
            clear: () => { plain.clear(); },
            key: (index: number) => Array.from(plain.keys())[index] ?? null,
            get length() { return plain.size; },
        });
        vi.stubGlobal('chrome', {
            cookies: { getAll: async () => [], get: async () => null, set: async () => undefined, remove: async () => null },
            storage: {
                local: {
                    get: async (keys: string[]) => Object.fromEntries(keys.filter(key => plain.has(key)).map(key => [key, plain.get(key)])),
                    set: async (values: Record<string, string>) => { Object.entries(values).forEach(([key, value]) => plain.set(key, value)); },
                    remove: async (keys: string[]) => { keys.forEach(key => plain.delete(key)); },
                },
            },
        });
        const { saveProviderCookie } = await import('../../../src/nativeBridge/api/cookies.js');

        await saveProviderCookie('qq', 'uin=fixture-uin; qm_keyst=fixture-key');

        expect(plain.get('foliaBridgeQqCookie')).toContain('uin=fixture-uin');
    });
});

describe('波点会话的加密落盘与查询串（H30）', () => {
    it('升级迁移：旧明文会话搬进加密槽位后删掉明文', async () => {
        const host = installHost({
            plain: [['bodianSessionV1', JSON.stringify({ uid: '42', token: 'fixture-bodian-token', user: { id: '42' } })]],
        });
        const bodian = await import('../../../src/nativeBridge/api/bodian.js');

        const status = await bodian.handleBodianRequest('login_status', {});

        expect(status).toMatchObject({ ok: true, data: { id: '42' } });
        expect(host.slots.get('bodian-session')).toContain('fixture-bodian-token');
        expect(host.plain.has('bodianSessionV1')).toBe(false);
    });

    it('槽位里已有会话时直接读出来，不再需要明文', async () => {
        installHost({ slots: [['bodian-session', JSON.stringify({ uid: '42', token: 'fixture-bodian-token', user: { id: '42' } })]] });
        const bodian = await import('../../../src/nativeBridge/api/bodian.js');

        await expect(bodian.handleBodianRequest('login_status', {}))
            .resolves.toMatchObject({ ok: true, data: { id: '42' } });
    });

    it('token 不进查询串：请求头里有，URL 里没有', async () => {
        installHost({ slots: [['bodian-session', JSON.stringify({ uid: '42', token: 'fixture-bodian-token', user: { id: '42' } })]] });
        const urls: string[] = [];
        vi.stubGlobal('fetch', vi.fn((input: string) => {
            urls.push(String(input));
            return Promise.resolve(new Response(JSON.stringify({ code: 200, data: { id: '77', playLists: [] } }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }));
        }));
        const bodian = await import('../../../src/nativeBridge/api/bodian.js');

        await bodian.handleBodianRequest('user_playlists', { limit: 10, offset: 0 });

        expect(urls.length).toBeGreaterThan(0);
        urls.forEach((url) => {
            expect(url).not.toContain('fixture-bodian-token');
            expect(decodeURIComponent(url)).not.toContain('fixture-bodian-token');
            // uid 仍然在查询串里：服务端按它认账号，它不是凭据。
            expect(url).toContain('uid=42');
        });
        const request = vi.mocked(fetch).mock.calls[0][1] as RequestInit | undefined;
        expect((request?.headers as Record<string, string> | undefined)?.token).toBe('fixture-bodian-token');
    });
});
