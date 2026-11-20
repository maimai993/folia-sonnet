import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleLoginQrCheck } from '../../../src/nativeBridge/api/netease.js';
import { clearCookieCache } from '../../../src/nativeBridge/api/cookies.js';

// #215：桥存下的扫码会话必须同时交回页面，不能只在重启之后才被读到。
// H5 之后它不再明写 localStorage，改由原生的加密槽位存（见 secureStore.js），
// 所以这里给的是原生插件的替身，断言的是「交回页面的 cookie 与加密槽位里那份一致」。
const mocks = vi.hoisted(() => ({ eapiRequest: vi.fn() }));
vi.mock('../../../src/nativeBridge/api/eapi.js', async importOriginal => ({
    ...await importOriginal<Record<string, unknown>>(),
    eapiRequest: mocks.eapiRequest,
}));

const LOGIN_COOKIE = 'MUSIC_U=fixture-qr-session; __csrf=fixture-qr-csrf';
/** 加密槽位：slot → 明文（测试里不做真加密，只记「存了什么」）。 */
let slots: Map<string, string>;
let plainStorage: Record<string, string>;

const installSecureStore = () => {
    const plugin = {
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
    };
    vi.stubGlobal('window', { Capacitor: { Plugins: { FoliaNative: plugin } } });
};

beforeEach(() => {
    slots = new Map();
    plainStorage = {};
    vi.stubGlobal('chrome', {
        cookies: {
            getAll: async () => [],
            get: async () => null,
            set: vi.fn(async () => undefined),
        },
        storage: {
            local: {
                get: async () => ({ ...plainStorage }),
                set: async (values: Record<string, string>) => { Object.assign(plainStorage, values); },
                remove: async (keys: string[]) => { keys.forEach(key => { delete plainStorage[key]; }); },
            },
        },
    });
    installSecureStore();
    clearCookieCache();
    mocks.eapiRequest.mockReset();
    // 账号资料接口暂未就绪时，仍须把刚确认的会话交回页面。
    mocks.eapiRequest.mockResolvedValue({ status: 200, body: { code: 200 } });
});

afterEach(() => {
    clearCookieCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('网易云扫码确认的 cookie 交接（#215）', () => {
    it('803 只有 Set-Cookie 时，返回与桥保存的同一份 cookie，不带响应头属性', async () => {
        mocks.eapiRequest.mockResolvedValueOnce({
            status: 200,
            body: { code: 803, message: '授权登录成功' },
            setCookies: [
                'MUSIC_U=fixture-qr-session; Path=/; Secure; HttpOnly',
                '__csrf=fixture-qr-csrf; Path=/; Max-Age=3600',
            ],
        });

        const answer = await handleLoginQrCheck('fixture-key');

        expect(answer).toMatchObject({ code: 803, cookie: LOGIN_COOKIE, loggedIn: true, hasCookie: true });
        // H5：桥存的那份在加密槽位里，不再明文进 localStorage。
        expect(slots.get('provider-netease-cookie')).toContain('MUSIC_U=fixture-qr-session');
        expect(plainStorage['foliaBridgeNeteaseCookie']).toBeUndefined();
        expect(answer.cookie).not.toMatch(/HttpOnly|Secure|Path|Max-Age/);
    });

    it.each([
        { cookie: LOGIN_COOKIE },
        { cookie: ['MUSIC_U=fixture-qr-session', '__csrf=fixture-qr-csrf'] },
        { data: { cookie: LOGIN_COOKIE } },
    ])('803 body 的 cookie 同样交回页面：%j', async body => {
        mocks.eapiRequest.mockResolvedValueOnce({ status: 200, body: { code: 803, ...body } });

        const answer = await handleLoginQrCheck('fixture-key');

        expect(answer.cookie).toBe(LOGIN_COOKIE);
        expect(slots.get('provider-netease-cookie')).toContain('MUSIC_U=fixture-qr-session');
        expect(plainStorage['foliaBridgeNeteaseCookie']).toBeUndefined();
    });

    it('803 没有会话时不伪造 cookie，也不把等待状态的 cookie 交回页面', async () => {
        mocks.eapiRequest.mockResolvedValueOnce({ status: 200, body: { code: 803 } });
        const confirmed = await handleLoginQrCheck('fixture-key');
        expect(confirmed.cookie || '').toBe('');
        expect(confirmed.loggedIn).toBe(false);
        expect(slots.has('provider-netease-cookie')).toBe(false);

        mocks.eapiRequest.mockResolvedValueOnce({ status: 200, body: { code: 802, cookie: LOGIN_COOKIE } });
        const waiting = await handleLoginQrCheck('fixture-key');
        expect(waiting.cookie).toBeUndefined();
        expect(slots.has('provider-netease-cookie')).toBe(false);
    });

    it('交回 cookie 的成功路径不把凭据写进 console', async () => {
        const logs = ['log', 'info', 'warn', 'error', 'debug'].map(level => (
            vi.spyOn(console, level as 'log').mockImplementation(() => undefined)
        ));
        mocks.eapiRequest.mockResolvedValueOnce({
            status: 200,
            body: { code: 803 },
            setCookies: ['MUSIC_U=fixture-qr-session; HttpOnly', '__csrf=fixture-qr-csrf; Secure'],
        });

        await handleLoginQrCheck('fixture-key');

        const output = JSON.stringify(logs.flatMap(log => log.mock.calls));
        expect(output).not.toContain('fixture-qr-session');
        expect(output).not.toContain('fixture-qr-csrf');
    });
});
