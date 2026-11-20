import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/qqExploreBridge.test.ts
//
// QQ 探索页桥（src/nativeBridge/api/qq/explore.js）的两条契约。
//
// M26：分页归一化 `pageSizeOf(value, fallback, max)` 有一处调用漏传上限，`Math.min(undefined, n)`
// 得 NaN，于是「不能传上限」这件事全靠调用方记得 —— 给 max 默认值，并让返回值永远是安全整数。
//
// M25：读接口失败一律回 `{ code: 0, …空数组 }`，把「网络断了」「上游报错」折叠成「没有内容」；
// 而同文件的建歌单会回 `__foliaBridgeError`。这里钉住：网络失败回统一失败对象，
// 上游明确答「空」仍回空集合，「没登录」仍是 AUTH_REQUIRED —— 三者可区分。

const calls: Array<{ module: string; method: string; param: Record<string, unknown> }> = [];

/** 每一次 qqMusicuCall 要回什么，由各用例自己摆。 */
let answer: (module: string, method: string, param: Record<string, unknown>) => unknown = () => ({ ok: true, data: {} });

vi.mock('../../../src/nativeBridge/api/qq.js', () => ({
    qqAuthRequired: (where: string) => ({ __foliaBridgeError: 'AUTH_REQUIRED', message: `QQ ${where}: login required` }),
    qqBridgeFailure: (where: string, code: unknown) => ({ __foliaBridgeError: 'NETWORK', message: `QQ ${where} failed (code ${code})` }),
    qqMusicuBatch: vi.fn(),
    qqMusicuCall: async (module: string, method: string, param: Record<string, unknown>) => {
        calls.push({ module, method, param: param || {} });
        return answer(module, method, param || {});
    },
}));

const COOKIE = 'uin=o0123456789; qm_keyst=fixture';
const load = async () => import('../../../src/nativeBridge/api/qq/explore.js');

beforeEach(() => {
    calls.length = 0;
    answer = () => ({ ok: true, data: {} });
});

describe('分页归一化（M26）', () => {
    it('不传上限时页码仍然是一个安全整数，不是 NaN', async () => {
        answer = () => ({ ok: true, data: { content: { v_item: [], total_cnt: 0 } } });
        const { readCategoryPlaylists } = await load();

        await readCategoryPlaylists({ id: '1', page: '3' }, COOKIE);

        const param = calls[0].param as { page: unknown };
        expect(Number.isSafeInteger(param.page)).toBe(true);
        // page 对外从 1 起，上游从 0 起：3 → 2，不是 NaN - 1。
        expect(param.page).toBe(2);
    });

    it('页码和页长都有上限：传极大值被压到上限', async () => {
        answer = () => ({ ok: true, data: { body: { item_song: [] }, meta: {} } });
        const { searchCatalog } = await load();

        await searchCatalog({ keyword: 'x', page: '999999', limit: '999999' }, COOKIE);

        const param = calls[0].param as { page_num: unknown; num_per_page: unknown };
        expect(Number.isSafeInteger(param.page_num)).toBe(true);
        expect(Number.isSafeInteger(param.num_per_page)).toBe(true);
        expect(param.page_num).toBe(100);
        expect(param.num_per_page).toBe(20);
    });

    it('负数、非数字、空串都回默认值，而不是 NaN', async () => {
        answer = () => ({ ok: true, data: { content: { v_item: [], total_cnt: 0 } } });
        const { readCategoryPlaylists } = await load();

        for (const page of ['-5', 'abc', '', undefined, null, '1e999']) {
            calls.length = 0;
            await readCategoryPlaylists({ id: '1', page }, COOKIE);
            const param = calls[0].param as { page: unknown; size: unknown };
            expect(Number.isSafeInteger(param.page), `page=${String(page)}`).toBe(true);
            expect(Number.isSafeInteger(param.size), `page=${String(page)}`).toBe(true);
            expect(param.page).toBe(0);
            expect(param.size).toBe(20);
        }
    });

    it('两个调用点都不该再把 NaN 送进上游', async () => {
        // readCategoryPlaylists 与 searchCatalog 是同一函数的两处调用；任何一处漏了上限，
        // 上游拿到的就是 NaN。直接看送出去的参数。
        answer = () => ({ ok: true, data: { content: { v_item: [] }, body: { item_song: [] }, meta: {} } });
        const { readCategoryPlaylists, searchCatalog } = await load();

        await readCategoryPlaylists({ id: '1', page: '2', limit: '999' }, COOKIE);
        await searchCatalog({ keyword: 'x', page: '2', limit: '999' }, COOKIE);

        for (const sent of calls) {
            for (const [key, value] of Object.entries(sent.param)) {
                if (typeof value === 'number') {
                    expect(Number.isNaN(value), `${sent.method}.${key}`).toBe(false);
                }
            }
        }
    });
});

describe('读接口的失败语义（M25）', () => {
    /** 桥的失败对象与「空集合」长得不一样：前者带 __foliaBridgeError。 */
    const isFailure = (value: any) => Boolean(value && value.__foliaBridgeError);

    it('网络失败回统一失败对象，不再是一份空集合', async () => {
        answer = () => ({ ok: false, loginRequired: false, code: 502, data: null });
        const { readToplists, readUserCloud, readUserVip } = await load();

        for (const [asked, params] of [
            [readToplists, [COOKIE]],
            [readUserCloud, [{}, COOKIE]],
            [readUserVip, [COOKIE]],
        ] as const) {
            const result: any = await asked(...(params as any));
            expect(isFailure(result), asked.name).toBe(true);
            expect(result.__foliaBridgeError).toBe('NETWORK');
            // 路由名留在文案里：面板上能看出是哪一栏读不出来。
            expect(typeof result.message).toBe('string');
        }
    });

    it('公开栏的读接口也一样：网络断了就说断了', async () => {
        answer = () => ({ ok: false, loginRequired: false, code: 502, data: null });
        const { readNewSongs, readPlaylistCategories } = await load();

        const songs: any = await readNewSongs({}, COOKIE);
        expect(songs.__foliaBridgeError).toBe('NETWORK');
        const categories: any = await readPlaylistCategories(COOKIE);
        expect(categories.__foliaBridgeError).toBe('NETWORK');
    });

    it('没登录仍然是 AUTH_REQUIRED，与「读不出来」分开', async () => {
        answer = () => ({ ok: false, loginRequired: true, code: 1000, data: null });
        const { readNewSongs, readUserCloud } = await load();

        const result: any = await readNewSongs({}, '');
        expect(result.__foliaBridgeError).toBe('AUTH_REQUIRED');

        // 需要登录的那几条：连请求都不发，直接回 AUTH_REQUIRED。
        const cloud: any = await readUserCloud({}, '');
        expect(cloud.__foliaBridgeError).toBe('AUTH_REQUIRED');
    });

    it('上游明确答「空」时仍然是空集合', async () => {
        answer = () => ({ ok: true, data: { songlist: [], lanlist: [], group: [] } });
        const { readNewSongs, readToplists } = await load();

        const songs: any = await readNewSongs({}, COOKIE);
        expect(isFailure(songs)).toBe(false);
        expect(songs.code).toBe(0);
        expect(songs.songs).toEqual([]);

        const charts: any = await readToplists(COOKIE);
        expect(isFailure(charts)).toBe(false);
        expect(charts.groups).toEqual([]);
    });

    it('上游回了但字段认不出来，也算读不出来', async () => {
        // 清单字段换了名字：改前是「内容突然全没了」，现在是明确的错。
        answer = () => ({ ok: true, data: { song_list_renamed: [{ mid: 'x' }] } });
        const { readNewSongs } = await load();

        const result: any = await readNewSongs({}, COOKIE);

        expect(isFailure(result)).toBe(true);
        expect(result.__foliaBridgeError).toBe('NETWORK');
    });
});
