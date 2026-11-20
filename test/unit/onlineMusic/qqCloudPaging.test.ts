import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/qqCloudPaging.test.ts
// 云盘分页的「还有没有更多」（issue H31）。
//
// 曾经 count = Math.max(total ?? 0, entries.length)：服务端没给 total 时，count 就是这一次
// 已经读到的条数，调用方拿 count 跟自己手里的比，永远得出「没有更多」—— 列表静默截断。
// 这里钉住两条：总数未知时按服务端的 has_more 说话；total 已知时仍然用它。

const calls: Array<{ page_no: number }> = [];

vi.mock('../../../src/nativeBridge/api/qq.js', () => ({
    qqAuthRequired: () => ({ code: 0, data: [], count: 0, loginRequired: true }),
    qqBridgeFailure: (message: string) => ({ code: 0, data: [], count: 0, error: message }),
    qqMusicuBatch: vi.fn(),
    qqMusicuCall: async (_module: string, _method: string, params: { page_no: number }) => {
        calls.push(params);
        return { ok: true, data: currentPage(params.page_no) };
    },
}));

// 每一页要回什么，由各用例自己摆。
let currentPage: (page: number) => unknown = () => ({});

const page = (count: number, hasMore: number, total?: number) => {
    const info_list = Array.from({ length: count }, (_, index) => ({
        songmid: `mid-${index}`,
        songname: `song ${index}`,
        singer: [{ name: 'artist' }],
    }));
    return { total, has_more: hasMore, info_list };
};

const COOKIE = 'uin=o0123456789; qm_keyst=fixture';

const load = async () => import('../../../src/nativeBridge/api/qq/explore.js');

// readUserCloud 的返回是「桥失败 | 未登录 | 正常列表」的联合，用例只关心正常那支，
// 收窄放在一处，免得每个断言都要处理另外两支。
type CloudPage = { count: number; hasMore: boolean; data: unknown[] };
const asPage = (value: unknown): CloudPage => {
    const page = value as Partial<CloudPage>;
    if (typeof page.count !== 'number' || typeof page.hasMore !== 'boolean' || !Array.isArray(page.data)) {
        throw new Error(`不是预期的云盘分页结果：${JSON.stringify(value)}`);
    }
    return { count: page.count, hasMore: page.hasMore, data: page.data };
};

beforeEach(() => {
    calls.length = 0;
    currentPage = () => ({});
});

describe('云盘分页', () => {
    it('总数大于这一次读到的量，但服务端说没了，就不该再说还有更多', async () => {
        /*
         * 这就是改前的病根场景：total 900、这一页只回来 37 条且 has_more=0
         * （权限/风控导致实际能看到的比声称的少）。
         *
         * 改前 `hasMore: end < count` → 37 < 900 → true，调用方会一直往下翻，
         * 每一页都空转。改后只看服务端的 has_more，这里应当是没有更多。
         */
        currentPage = () => page(37, 0, 900);
        const { readUserCloud } = await load();

        const result = asPage(await readUserCloud({ offset: '0', limit: '200' }, COOKIE));
        expect(result.count).toBe(900);
        expect(result.hasMore).toBe(false);
    });

    it('总数未知时，还在读第二页就已经知道还有更多', async () => {
        // 首页给满一页且 has_more=1；第二页只有 3 条、has_more=0。
        currentPage = (pageNo) => (pageNo === 1 ? page(200, 1) : page(3, 0));
        const { readUserCloud } = await load();

        const first = asPage(await readUserCloud({ offset: '0', limit: '200' }, COOKIE));
        expect(first.data).toHaveLength(200);
        /*
         * 关键：还有更多。
         *
         * 读满 limit 就停（entries 200），此时服务端最后一页的 has_more 还是 1，
         * 所以要继续往下取。以前这里拿 count（= 已读 200）跟自己比，恒为 false。
         */
        expect(first.hasMore).toBe(true);
    });

    it('读到底、服务端也说没了，才算没有更多', async () => {
        currentPage = (pageNo) => (pageNo === 1 ? page(37, 0) : page(0, 0));
        const { readUserCloud } = await load();

        const result = asPage(await readUserCloud({ offset: '0', limit: '500' }, COOKIE));
        expect(result.count).toBe(37);
        expect(result.hasMore).toBe(false);
    });

    it('服务端给了总数时以它为准', async () => {
        currentPage = (pageNo) => (pageNo === 1 ? page(200, 1, 900) : page(0, 0));
        const { readUserCloud } = await load();

        const result = asPage(await readUserCloud({ offset: '0', limit: '200' }, COOKIE));
        expect(result.count).toBe(900);
        expect(result.hasMore).toBe(true);
    });

    it('总数已知且这一页就取完了，没有更多', async () => {
        currentPage = () => page(12, 0, 12);
        const { readUserCloud } = await load();

        const result = asPage(await readUserCloud({ offset: '0', limit: '200' }, COOKIE));
        expect(result.count).toBe(12);
        expect(result.hasMore).toBe(false);
    });
});
