import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// test/unit/onlineMusic/qqAnonymousSearch.test.ts
//
// QQ 匿名搜索的「身份」只能有一处定义（issue M27）。
//
// 同一条上游知识原先散在两处：桥侧的 src/nativeBridge/api/qq/explore.js 自带一套
// ANONYMOUS_LITE_COMM / ANONYMOUS_LITE_COOKIE / search_type 7，页面侧的
// src/services/onlineMusic/qq/qqLyricProvider.ts 又自己写了一套，两边的注释记录的是
// 不同的实验结论，任一侧被改另一侧都不会有人发现。现在两侧都从 qq.js 取。
//
// 这里钉两件事：
//   1. 送给上游的那几样（search_type / 精简版 comm / tmeLoginType=-1）逐字相同 —— 两侧
//      对的是同一条上游，身份不同就是两个不同的实验；
//   2. 两侧的文件里不再各写一份常数：删掉 qq.js 的那份定义，两侧都会读不到（用源码断言
//      落住，因为这些常数只在这两处出现）。

const calls: Array<{ module: string; method: string; param: Record<string, unknown>; cookie: string; comm?: Record<string, unknown> }> = [];

/** 每个用例自己摆：给上游答什么。 */
let answer: (module: string, method: string) => unknown = () => ({ ok: true, data: { body: { item_song: [] } } });

vi.mock('../../../src/nativeBridge/api/qq.js', async () => {
    const actual = await vi.importActual<any>('../../../src/nativeBridge/api/qq.js');
    return {
        ...actual,
        qqMusicuBatch: vi.fn(),
        qqMusicuCall: async (module: string, method: string, param: Record<string, unknown>, cookie: string, comm?: Record<string, unknown>) => {
            calls.push({ module, method, param, cookie, comm });
            return answer(module, method);
        },
    };
});

const COOKIE = 'uin=o0123456789; qm_keyst=fixture';

beforeEach(() => {
    calls.length = 0;
    answer = () => ({ ok: true, data: { body: { item_song: [] } } });
});

describe('匿名搜索的身份只有一处定义（M27）', () => {
    it('桥与页面送出去的匿名身份逐字相同', async () => {
        const shared = await vi.importActual<any>('../../../src/nativeBridge/api/qq/anonymousSearch.js');
        const { searchCatalog } = await import('../../../src/nativeBridge/api/qq/explore.js');

        await searchCatalog({ keyword: '青花瓷', type: 'song' }, '');

        expect(calls).toHaveLength(1);
        const sent = calls[0];
        expect(sent.cookie).toBe(shared.ANONYMOUS_LITE_COOKIE);
        expect(sent.comm).toEqual(shared.ANONYMOUS_LITE_COMM);
        expect(sent.param.search_type).toBe(shared.ANONYMOUS_SONG_SEARCH_TYPE);
    });

    it('两个身份常数都从 qq.js 来，两侧都不再自带副本', async () => {
        const bridge = readFileSync('src/nativeBridge/api/qq/explore.js', 'utf8');
        const page = readFileSync('src/services/onlineMusic/qq/qqLyricProvider.ts', 'utf8');

        // 桥侧不再自建：comm 常数的字面量只在 qq.js 里出现。
        expect(bridge).not.toMatch(/tmeAppID\s*:/);
        expect(bridge).not.toMatch(/tmeLoginType=-1/);
        // 页面侧不再自建：同一串精简版标识不在那里出现。
        // （`search_type: 7` 只剩注释里的历史说明，实际取值走共用常数。）
        expect(page).not.toMatch(/tmeAppID\s*:/);
        expect(page).not.toMatch(/search_type\s*:\s*\d/);
        expect(page).not.toMatch(/tmeLoginType=-1/);
    });

    it('有会话时不送匿名身份（会话路径不能带上精简版常数）', async () => {
        const { searchCatalog } = await import('../../../src/nativeBridge/api/qq/explore.js');

        await searchCatalog({ keyword: '青花瓷', type: 'song' }, COOKIE);

        expect(calls).toHaveLength(1);
        // 带会话搜歌照旧送 0：7 只是匿名时的替代品。
        expect(calls[0].param.search_type).toBe(0);
        expect(calls[0].comm).toBeUndefined();
    });

    it('被上游拒绝时两侧都给「读失败」，不给空清单', async () => {
        // 这里只看桥侧的语义（页面侧由 qqSearch.ts 抛 OnlineProviderError，见它的单测）。
        answer = () => ({ ok: false, loginRequired: false, code: 2001, data: null });
        const { searchCatalog } = await import('../../../src/nativeBridge/api/qq/explore.js');

        const result: any = await searchCatalog({ keyword: '青花瓷', type: 'song' }, '');

        expect(result.__foliaBridgeError).toBe('NETWORK');
        expect(result.message).toContain('2001');
    });
});
