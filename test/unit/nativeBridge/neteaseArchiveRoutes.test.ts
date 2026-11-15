// test/unit/nativeBridge/neteaseArchiveRoutes.test.ts
//
// 回归现场（#223）：安卓端「听歌档案」的云端页整页显示「无法连接网易云，请稍后重试」。
// 真因不在模组也不在 rpc：模组取数走 `platform.raw` → `neteaseRaw.requestNeteaseRoute`，
// 安卓这边落到 `src/nativeBridge/api/folia.js` 的网易云分支，而那里没有
// `/user/record`、`/listen/data/total`、`/listen/data/realtime/report` 三条，
// 全部落到末尾的 `ROUTE_NOT_IMPLEMENTED`。`netease.ts` 见到 `__foliaBridgeError` 就抛，
// `neteaseRaw` 把它归成 network —— 于是「桥里没这条路由」在界面上长得和断网一模一样。
//
// 这里钉三件事：三条路由不再回 ROUTE_NOT_IMPLEMENTED、问上游时的路径/加密方式/参数形状与
// 上游模块（`@neteasecloudmusicapienhanced/api` 的 `module/`）一致、上游出错时回桥自己的错误码
// 而不是抛异常（抛出去会被上层归成 network，排查方向就错了）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ weapiRequest: vi.fn(), eapiRequest: vi.fn() }));

// 只换掉真正发请求的那两个函数：加密、UA 这些还走真实现，测的才是桥上那段路由。
vi.mock('../../../src/nativeBridge/api/weapi.js', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, weapiRequest: mocks.weapiRequest };
});
vi.mock('../../../src/nativeBridge/api/eapi.js', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, eapiRequest: mocks.eapiRequest };
});

import { handleFoliaApiRequest } from '../../../src/nativeBridge/api/folia.js';
import { clearCookieCache } from '../../../src/nativeBridge/api/cookies.js';
import { getLibraryTraceLines, resetLibraryTrace } from '../../../src/nativeBridge/api/libraryTrace.js';

const STORAGE_KEY = 'foliaBridgeNeteaseCookie';
const LOGIN_COOKIE = 'MUSIC_U=fixture-session; __csrf=fixture-csrf';

// 宿主的最小替身：桥只从 `chrome.storage.local` 里读那份会话（cookie 罐那条路允许拿空）。
const installHost = () => {
    (globalThis as any).chrome = {
        cookies: {
            getAll: async () => [],
            get: async () => null,
        },
        storage: {
            local: {
                get: async (keys: string[]) => (
                    keys.includes(STORAGE_KEY) ? { [STORAGE_KEY]: LOGIN_COOKIE } : {}
                ),
                set: async () => undefined,
                remove: async () => undefined,
            },
        },
    };
};

describe('网易云桥的听歌档案路由（#223）', () => {
    beforeEach(() => {
        installHost();
        clearCookieCache();
        resetLibraryTrace();
        mocks.weapiRequest.mockReset();
        mocks.eapiRequest.mockReset();
        mocks.eapiRequest.mockResolvedValue({ status: 200, body: { code: 200 } });
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        delete (globalThis as any).chrome;
        vi.restoreAllMocks();
    });

    it('这三条都不再是 ROUTE_NOT_IMPLEMENTED', async () => {
        for (const path of ['/user/record', '/listen/data/total', '/listen/data/realtime/report']) {
            const answer: any = await handleFoliaApiRequest({ path, query: { uid: '42' } });
            expect(answer?.__foliaBridgeError).not.toBe('ROUTE_NOT_IMPLEMENTED');
        }
    });

    it('表外的路径仍然回 ROUTE_NOT_IMPLEMENTED', async () => {
        const answer: any = await handleFoliaApiRequest({ path: '/not/a/route' });
        expect(answer?.__foliaBridgeError).toBe('ROUTE_NOT_IMPLEMENTED');
    });

    it('被问到的这三条在诊断里留一条 archive:route 的痕', async () => {
        await handleFoliaApiRequest({ path: '/listen/data/total' });

        const lines = getLibraryTraceLines();
        expect(lines.some(line => line.includes('netease:archive:route') && line.includes('/listen/data/total'))).toBe(true);
    });

    it('/user/record 走 weapi 的 /api/v1/play/record，参数是 {uid, type}', async () => {
        const records = { code: 200, allData: [{ playCount: 7, song: { id: 1 } }], weekData: [] };
        mocks.weapiRequest.mockResolvedValue(records);

        const answer = await handleFoliaApiRequest({ path: '/user/record', query: { uid: '42', type: '1' } });

        expect(answer).toBe(records);
        expect(mocks.weapiRequest).toHaveBeenCalledTimes(1);
        expect(mocks.weapiRequest).toHaveBeenCalledWith(
            '/api/v1/play/record',
            { uid: '42', type: 1, csrf_token: 'fixture-csrf' },
            LOGIN_COOKIE,
        );
        // 上游那条是 weapi，不该顺带问 eapi。
        expect(mocks.eapiRequest).not.toHaveBeenCalled();
    });

    it('/user/record 没给 type 时按上游的缺省值 0（所有时间）', async () => {
        mocks.weapiRequest.mockResolvedValue({ code: 200, allData: [], weekData: [] });

        await handleFoliaApiRequest({ path: '/user/record', query: { uid: '42' } });

        expect(mocks.weapiRequest).toHaveBeenCalledWith(
            '/api/v1/play/record',
            { uid: '42', type: 0, csrf_token: 'fixture-csrf' },
            LOGIN_COOKIE,
        );
    });

    it('/listen/data/total 走 eapi 且不带参数，应答原样交回', async () => {
        const body = { code: 200, data: { totalDuration: 123456 } };
        mocks.eapiRequest.mockResolvedValue({ status: 200, body });

        const answer = await handleFoliaApiRequest({ path: '/listen/data/total' });

        expect(answer).toEqual(body);
        expect(mocks.eapiRequest).toHaveBeenCalledWith(
            '/api/content/activity/listen/data/total',
            {},
            LOGIN_COOKIE,
        );
        expect(mocks.weapiRequest).not.toHaveBeenCalled();
    });

    it('/listen/data/realtime/report 带 type，缺省 week', async () => {
        const body = { code: 200, data: { listenTimeDistributionBlock: { playDuration: 3600 } } };
        mocks.eapiRequest.mockResolvedValue({ status: 200, body });

        const month = await handleFoliaApiRequest({ path: '/listen/data/realtime/report', query: { type: 'month' } });
        expect(month).toEqual(body);
        expect(mocks.eapiRequest).toHaveBeenLastCalledWith(
            '/api/content/activity/listen/data/realtime/report',
            { type: 'month' },
            LOGIN_COOKIE,
        );

        await handleFoliaApiRequest({ path: '/listen/data/realtime/report' });
        expect(mocks.eapiRequest).toHaveBeenLastCalledWith(
            '/api/content/activity/listen/data/realtime/report',
            { type: 'week' },
            LOGIN_COOKIE,
        );
    });

    it('上游 5xx 时回桥自己的 NETWORK 错误码，不抛异常', async () => {
        mocks.eapiRequest.mockResolvedValue({ status: 502, body: { message: 'upstream down' } });

        const answer: any = await handleFoliaApiRequest({ path: '/listen/data/total' });

        expect(answer.__foliaBridgeError).toBe('NETWORK');
        expect(answer.path).toBe('/listen/data/total');
        expect(answer.message).toContain('upstream down');
    });

    it('weapi 那条网络层抛错时同样归成 NETWORK', async () => {
        mocks.weapiRequest.mockRejectedValue(new Error('fetch failed'));

        const answer: any = await handleFoliaApiRequest({ path: '/user/record', query: { uid: '42' } });

        expect(answer.__foliaBridgeError).toBe('NETWORK');
        expect(answer.message).toContain('fetch failed');
    });

    it('未登录（301）原样交回给上层判，不在这里当成失败', async () => {
        mocks.eapiRequest.mockResolvedValue({ status: 200, body: { code: 301 } });

        const answer: any = await handleFoliaApiRequest({ path: '/listen/data/total' });

        expect(answer).toEqual({ code: 301 });
        expect(answer.__foliaBridgeError).toBeUndefined();
    });
});
