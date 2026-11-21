// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/services/aiCloudCacheWriteNoToken.test.ts
// 没有写入令牌时也要能写进云缓存。
//
// 云缓存是个**公开服务**：读不需要任何凭据，写也不设门槛 —— 回传得越多，别人命中得越快。
// 以前 `pushAiCloudCache` 在本地直接 `return false`，没有令牌的用户一条都写不进去，
// 于是缓存池永远只有少数人往里放东西。
//
// 这条用例**故意不 mock `resolveCloudWriteToken`**（返回空串），钉住「照样发 PUT」。
// 单独一个文件是因为 `aiCloudCache.test.ts` 在文件级把令牌 mock 成了非空值，
// 那种环境里这个 bug 复现不出来 —— 它一直绿着，掩盖了问题。

const { handlers } = vi.hoisted(() => ({
    handlers: {
        fetch: null as null | ((url: string, init?: RequestInit) => Promise<Response>),
    },
}));

vi.mock('@/services/foliaCloud', () => ({
    isFoliaCloudCacheEnabled: () => true,
    resolveCloudApiUrl: (path: string) => `https://cloud.test/api/${path}`,
    /* 关键：没有令牌。 */
    resolveCloudWriteToken: () => '',
    CLOUD_WRITE_TOKEN_HEADER: 'X-Folia-Cache-Token',
    DEFAULT_CLOUD_BASE_URL: 'https://cloud.test',
}));

vi.mock('@/services/aiNativeFetch', () => ({
    createAiFetch: () => (input: RequestInfo | URL, init?: RequestInit) =>
        (handlers.fetch as NonNullable<typeof handlers.fetch>)(String(input), init),
    fetchAiCacheViaNative: async () => null,
}));

vi.mock('@/services/aiCompletion', () => ({
    describeAiTarget: () => null,
}));

const { pushAiCloudCache } = await import('@/services/aiCloudCache');

const KEY = 'f0e1d2c3'.repeat(4);

beforeEach(() => {
    handlers.fetch = null;
});

describe('没有写入令牌时的推送', () => {
    it('照样发出 PUT，不再本地直接放弃', async () => {
        const seen: { method: string; url: string; token: string | null }[] = [];
        handlers.fetch = async (url, init) => {
            const headers = (init?.headers ?? {}) as Record<string, string>;
            seen.push({
                method: init?.method ?? 'GET',
                url,
                token: headers['X-Folia-Cache-Token'] ?? null,
            });
            return new Response(JSON.stringify({ ok: true, stored: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        };

        const ok = await pushAiCloudCache('stage', KEY, { words: ['小黄花'] }, { songTitle: '晴天' });

        expect(ok).toBe(true);
        expect(seen).toHaveLength(1);
        expect(seen[0].method).toBe('PUT');
        expect(seen[0].url).toContain(KEY);
        /* 没有令牌就不带这一行 —— 但不带也要能写。 */
        expect(seen[0].token).toBeNull();
    });

    it('服务端返回 401 时如实返回 false', async () => {
        handlers.fetch = async () => new Response('{}', { status: 401 });
        const ok = await pushAiCloudCache('stage', KEY, { words: [] }, { songTitle: '晴天' });
        expect(ok).toBe(false);
    });
});
