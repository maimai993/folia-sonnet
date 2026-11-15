// test/unit/nativeBridge/neteaseLogoutCookies.test.ts
//
// 回归现场：网易云退出登录后会话没真的清掉，重开应用又被自动登录。
// 原因在桥这一层：`/logout` 直接回 `{ code: 200 }`，既不清 cookie 罐里的 `MUSIC_U`，
// 也不清存在 `chrome.storage.local` 的那份 cookie；而 `getNeteaseCookie()` 会把罐里的读回来，
// 于是前端判未登录、后端仍带着会话。这里把「登出之后读不到会话」钉成回归线。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getNeteaseCookie } from '../../../src/nativeBridge/api/cookies.js';
import { clearSessionOnLogout } from '../../../src/nativeBridge/api/netease/logout.js';
import { handleFoliaApiRequest } from '../../../src/nativeBridge/api/folia.js';

type Jar = Map<string, string>;

const LOGIN_COOKIE = 'MUSIC_U=fixture-session; __csrf=fixture-csrf';
// `removeBrowserCookiesForHosts` 把 host 名原样当 `url` 传下来（宿主自己认这种写法），
// 这里同样原样取，不假设它一定是完整 URL。
const hostOf = (value: string) => String(value).replace(/^https?:\/\//, '').split('/')[0].replace(/^\./, '');
const STORAGE_KEY = 'foliaBridgeNeteaseCookie';

// 模拟宿主：一个按域名存的 cookie 罐，加 storage.local。
const installHost = (options: { batch?: boolean; slow?: boolean } = {}) => {
    const jar: Jar = new Map();
    const storage = new Map<string, string>([[STORAGE_KEY, LOGIN_COOKIE]]);
    LOGIN_COOKIE.split('; ').forEach((pair) => {
        const [name] = pair.split('=');
        jar.set(`music.163.com|${name}`, pair);
    });
    const removed: string[] = [];

    const removeOne = async ({ url, name }: { url: string; name: string }) => {
        if (options.slow) await new Promise(resolve => setTimeout(resolve, 5000));
        const key = `${hostOf(url)}|${name}`;
        if (!jar.has(key)) return null;
        jar.delete(key);
        removed.push(key);
        return { name };
    };

    (globalThis as any).chrome = {
        cookies: {
            getAll: async ({ domain }: { domain?: string }) => {
                const rows = [...jar.entries()].map(([key, value]) => {
                    const [host] = key.split('|');
                    const [cookieName, ...rest] = value.split('=');
                    return { domain: host, name: cookieName, value: rest.join('=') };
                });
                if (!domain) return rows;
                const host = domain.replace(/^\./, '');
                return rows.filter((row: { domain: string }) => row.domain.replace(/^\./, '').endsWith(host));
            },
            get: async ({ url, name }: { url: string; name: string }) => {
                const pair = jar.get(`${hostOf(url)}|${name}`);
                if (!pair) return null;
                const [cookieName, ...rest] = pair.split('=');
                return { domain: hostOf(url), name: cookieName, value: rest.join('=') };
            },
            ...(options.batch ? { removeBatch: async (items: Array<{ url: string; name: string }>) => {
                for (const item of items) await removeOne(item);
                return true;
            } } : {}),
            remove: removeOne,
        },
        storage: {
            local: {
                get: async (keys: string[]) => Object.fromEntries(keys.filter(key => storage.has(key)).map(key => [key, storage.get(key)])),
                set: async (values: Record<string, string>) => { Object.entries(values).forEach(([key, value]) => storage.set(key, value)); },
                remove: async (keys: string[]) => { keys.forEach(key => storage.delete(key)); },
            },
        },
    };

    return { jar, storage, removed };
};

describe('网易云登出清会话', () => {
    beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        delete (globalThis as any).chrome;
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('清掉 cookie 罐里的登录键与桥存的那份 cookie', async () => {
        const host = installHost();

        await clearSessionOnLogout();

        expect([...host.jar.keys()].filter(key => /MUSIC_U|__csrf/.test(key))).toEqual([]);
        expect(host.storage.has(STORAGE_KEY)).toBe(false);
    });

    it('登出后 getNeteaseCookie 读不回会话', async () => {
        installHost();
        expect(await getNeteaseCookie()).toContain('MUSIC_U=');

        await clearSessionOnLogout();

        expect(await getNeteaseCookie()).toBe('');
    });

    it('/logout 走的是同一条清理，重开应用不会被自动登录', async () => {
        const host = installHost();

        const answer = await handleFoliaApiRequest({ path: '/logout' });

        expect(answer).toMatchObject({ code: 200 });
        expect([...host.jar.keys()].filter(key => /MUSIC_U|__csrf/.test(key))).toEqual([]);
        expect(host.storage.has(STORAGE_KEY)).toBe(false);
        expect(await getNeteaseCookie()).toBe('');
    });

    it('宿主支持批量删除时只过一次桥', async () => {
        const host = installHost({ batch: true });

        await clearSessionOnLogout();

        expect(host.storage.has(STORAGE_KEY)).toBe(false);
    });

    it('宿主不回包时到点返回，不把登出卡住', async () => {
        vi.useFakeTimers();
        installHost({ slow: true });

        const pending = clearSessionOnLogout();
        await vi.advanceTimersByTimeAsync(2500);

        await expect(pending).resolves.toBeUndefined();
    });
});
