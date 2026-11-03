import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #208：登出必须清掉桥上的全部账号恢复来源，而不是只让页面暂时忘记账号。
const SESSION_COOKIE = 'userid=42; token=fixture-token; KuGoo=KugooID=42&t=fixture-token; vip_token=fixture-vip';
const SESSION_KEYS = ['foliaBridgeKgCookie', 'kgLoginPersist', 'kgVipSession'];
const hostOf = (value: string) => String(value).replace(/^https?:\/\//, '').split('/')[0].replace(/^\./, '');

type HostOptions = { batch?: boolean; cookiesHang?: boolean; cookiesReject?: boolean; readsHang?: boolean };
const installHost = (options: HostOptions = {}) => {
    const storage = new Map<string, unknown>([
        ['foliaBridgeKgCookie', SESSION_COOKIE],
        ['kgLoginPersist', { userid: '42', token: 'fixture-token' }],
        ['kgVipSession', { userId: '42', appToken: 'fixture-app', vipToken: 'fixture-vip', at: Date.now() }],
        ['kgPlatformMigration', 'lite-v1'],
        ['kgLiteDevice', { guid: 'fixture-guid', mid: 'fixture-mid', dev: 'fixture-dev', mac: 'fixture-mac', webgl: 'fixture-webgl' }],
        ['kgMid', 'fixture-mid'],
        ['foliaBridgeNeteaseCookie', 'MUSIC_U=other-session'],
        ['foliaBridgeQqCookie', 'uin=other-user'],
    ]);
    const jar = new Map<string, string>();
    for (const host of ['kugou.com', 'www.kugou.com', 'm.kugou.com', 'gateway.kugou.com', 'kugou.net']) {
        for (const pair of SESSION_COOKIE.split('; ')) {
            const eq = pair.indexOf('=');
            jar.set(`${host}|${pair.slice(0, eq)}`, pair.slice(eq + 1));
        }
        // 这些别名也被登录解析器接受，不能留着让下次 getAll 再读回。
        jar.set(`${host}|KGLogin`, 'userid=42&token=fixture-alias');
        jar.set(`${host}|kguser`, 'userid=42&token=fixture-alias');
        jar.set(`${host}|kg_token`, 'fixture-alias');
        jar.set(`${host}|dfid`, 'fixture-device');
        jar.set(`${host}|KUGOU_API_GUID`, 'fixture-guid');
        jar.set(`${host}|kg_mid`, 'fixture-mid');
    }
    jar.set('music.163.com|MUSIC_U', 'other-session');
    jar.set('y.qq.com|token', 'other-token');
    const never = () => new Promise<never>(() => {});
    const removeOne = vi.fn(async ({ url, name }: { url: string; name: string }) => {
        if (options.cookiesHang) return never();
        if (options.cookiesReject) throw new Error('fixture host unavailable');
        jar.delete(`${hostOf(url)}|${name}`);
        return { name };
    });
    const batch = vi.fn(async (entries: Array<{ url: string; name: string }>) => {
        if (options.cookiesHang) return never();
        if (options.cookiesReject) throw new Error('fixture batch unavailable');
        entries.forEach(({ url, name }) => jar.delete(`${hostOf(url)}|${name}`));
        return true;
    });
    const getAll = vi.fn(async ({ domain, url }: { domain?: string; url?: string }) => {
        if (options.readsHang) return never();
        const target = hostOf(domain || url || '');
        return [...jar].filter(([key]) => {
            const host = key.split('|')[0];
            return host === target || host.endsWith(`.${target}`);
        }).map(([key, value]) => {
            const [domain, name] = key.split('|');
            return { domain, name, value };
        });
    });
    vi.stubGlobal('chrome', {
        cookies: {
            getAll,
            get: async ({ url, name }: { url: string; name: string }) => {
                if (options.readsHang) return never();
                const value = jar.get(`${hostOf(url)}|${name}`);
                return value ? { name, value } : null;
            },
            set: vi.fn(async ({ url, name, value }: { url: string; name: string; value: string }) => {
                jar.set(`${hostOf(url)}|${name}`, value);
            }),
            remove: removeOne,
            ...(options.batch ? { removeBatch: batch } : {}),
        },
        storage: {
            local: {
                get: async (keys: string[]) => Object.fromEntries(keys.filter(key => storage.has(key)).map(key => [key, storage.get(key)])),
                set: async (values: Record<string, unknown>) => { Object.entries(values).forEach(([key, value]) => storage.set(key, value)); },
                remove: vi.fn(async (keys: string[]) => { keys.forEach(key => storage.delete(key)); }),
            },
        },
    });
    return { storage, jar, batch, removeOne, getAll };
};

const logout = async () => {
    const { handleFoliaApiRequest } = await import('../../../src/nativeBridge/api/folia.js');
    return handleFoliaApiRequest({ provider: 'kugou', operation: 'logout' });
};

beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network is needed for logout'); }));
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('酷狗桥登出清会话（#208）', () => {
    it.each([false, true])('清 cookie、桥副本和登录恢复备份（batch=%s），但保留设备身份与其他平台', async batch => {
        const host = installHost({ batch });
        const answer = await logout();
        expect(answer).toMatchObject({ status: 1, error_code: 0, code: 200 });
        SESSION_KEYS.forEach(key => expect(host.storage.has(key), key).toBe(false));
        expect([...host.jar.keys()].filter(key => /\|(userid|token|KuGoo|KGLogin|kguser|kg_token|vip_token)$/.test(key) && /kugou\./.test(key))).toEqual([]);
        expect(host.storage.has('kgLiteDevice')).toBe(true);
        expect(host.storage.get('kgMid')).toBe('fixture-mid');
        expect(host.storage.get('kgPlatformMigration')).toBe('lite-v1');
        expect(host.jar.get('www.kugou.com|dfid')).toBe('fixture-device');
        expect(host.jar.get('www.kugou.com|KUGOU_API_GUID')).toBe('fixture-guid');
        expect(host.jar.get('www.kugou.com|kg_mid')).toBe('fixture-mid');
        expect(host.jar.get('music.163.com|MUSIC_U')).toBe('other-session');
        expect(host.jar.get('y.qq.com|token')).toBe('other-token');
        expect(host.storage.get('foliaBridgeNeteaseCookie')).toBe('MUSIC_U=other-session');
        expect(host.storage.get('foliaBridgeQqCookie')).toBe('uin=other-user');
        if (batch) expect(host.batch).toHaveBeenCalledTimes(1);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('登出清掉已热读的 cookie 缓存，ensureKGCookie 不能从备份恢复旧登录', async () => {
        installHost({ batch: true });
        const { getKGCookie, kgCookieToken, kgCookieUserId } = await import('../../../src/nativeBridge/api/cookies.js');
        expect(kgCookieToken(await getKGCookie())).toBeTruthy();
        await logout();
        const { ensureKGCookie } = await import('../../../src/nativeBridge/api/kugou.js');
        const after = await ensureKGCookie();
        expect(kgCookieToken(after)).toBe('');
        expect(kgCookieUserId(after)).toBe('');
    });

    it.each(['jar', 'bridge', 'persist'])('仅 %s 存在的会话也被清掉，模块重载后不恢复', async source => {
        const host = installHost({ batch: true });
        if (source !== 'jar') host.jar.clear();
        if (source !== 'bridge') host.storage.delete('foliaBridgeKgCookie');
        if (source !== 'persist') host.storage.delete('kgLoginPersist');
        await logout();
        const cookies = await import('../../../src/nativeBridge/api/cookies.js');
        expect(cookies.kgCookieToken(await cookies.getKGCookie())).toBe('');
        vi.resetModules();
        const { ensureKGCookie } = await import('../../../src/nativeBridge/api/kugou.js');
        expect(cookies.kgCookieToken(await ensureKGCookie())).toBe('');
    });

    it('冷启动只有 kgLoginPersist 时也直接清掉，不先恢复登录', async () => {
        const host = installHost({ batch: true });
        host.jar.clear();
        host.storage.delete('foliaBridgeKgCookie');
        await logout();
        expect((globalThis as any).chrome.cookies.set).not.toHaveBeenCalled();
        expect(host.storage.has('kgLoginPersist')).toBe(false);
        expect(host.getAll).not.toHaveBeenCalled();
    });

    it('cookie 宿主抛错时仍清登录备份和缓存，不阻断登出', async () => {
        const host = installHost({ batch: true, cookiesReject: true });
        await expect(logout()).resolves.toMatchObject({ code: 200 });
        SESSION_KEYS.forEach(key => expect(host.storage.has(key), key).toBe(false));
    });

    it('读 cookie 不回包也不能阻止登出；删除不回包时 2.5 秒内结束且先清存储', async () => {
        vi.useFakeTimers();
        const host = installHost({ batch: true, cookiesHang: true, readsHang: true });
        // 先完成模块加载，让假时钟只控制清理上限。
        const { handleFoliaApiRequest } = await import('../../../src/nativeBridge/api/folia.js');
        const pending = handleFoliaApiRequest({ provider: 'kugou', operation: 'logout' });
        await vi.advanceTimersByTimeAsync(2500);
        await expect(pending).resolves.toMatchObject({ code: 200 });
        SESSION_KEYS.forEach(key => expect(host.storage.has(key), key).toBe(false));
        expect(host.getAll).not.toHaveBeenCalled();
    });

    it('同一模块登出后允许新的明确登录，不复用旧凭据', async () => {
        installHost({ batch: true });
        await logout();
        const bridge = await import('../../../src/nativeBridge/api/kugou.js');
        vi.mocked(fetch).mockResolvedValue(Response.json({ status: 1, data: { status: 4, userid: '77', token: 'fixture-new-token' } }));
        const signedIn = bridge.handleKGLoginQrCheck('new-key');
        // 状态读取只需合成响应，不连接真实服务。
        const result = await signedIn;
        expect(result.loggedIn).toBe(true);
        expect(result).toHaveProperty('token', 'fixture-new-token');
        const cookies = await import('../../../src/nativeBridge/api/cookies.js');
        expect(cookies.kgCookieToken(await bridge.ensureKGCookie())).toBe('fixture-new-token');
    });

    it('登出后迟到的二维码答复不重新保存登录', async () => {
        const host = installHost({ batch: true });
        let answer!: (value: Response) => void;
        vi.mocked(fetch).mockReturnValue(new Promise(resolve => { answer = resolve; }));
        const bridge = await import('../../../src/nativeBridge/api/kugou.js');
        const pending = bridge.handleKGLoginQrCheck('old-key');
        await vi.waitFor(() => expect(fetch).toHaveBeenCalled(), { interval: 1 });
        await bridge.clearKGSessionOnLogout();
        answer(Response.json({ status: 1, data: { status: 4, userid: '42', token: 'fixture-late-token' } }));
        const result = await pending;
        expect(result.loggedIn).toBe(false);
        expect(result).not.toHaveProperty('token');
        SESSION_KEYS.forEach(key => expect(host.storage.has(key)).toBe(false));
    });

    it('登出日志不包含会话值', async () => {
        installHost({ batch: true });
        const logs = ['log', 'info', 'warn', 'error', 'debug'].map(level => vi.spyOn(console, level as 'log').mockImplementation(() => undefined));
        await logout();
        const output = JSON.stringify(logs.flatMap(log => log.mock.calls));
        expect(output).not.toContain('fixture-token');
        expect(output).not.toContain('fixture-vip');
        expect(output).not.toContain('fixture-app');
    });
});
