// test/unit/sync-server/syncBodyLimit.test.ts
// 同步服务的请求体上限（issue M34）。
//
// 以前整张表没有任何体积上限：持令牌的人（或令牌泄漏之后）可以往 `/themes/put`
// 塞任意大的数组，服务端会完整读进内存、解析、再批量落库。这里钉住四件事：
//
//  1. 超过 2MB 的请求体直接 413 `payload_too_large`，正文一个字都不读；
//  2. 正常大小的同步载荷（含 500 条主题的批量写入）照旧通过；
//  3. 公开接口自己的更严上限没有被这条顶掉：云缓存 PUT 仍是它自己的 128KB；
//  4. 上限来自 `Content-Length` 声明，所以这里手工造请求 —— `fetch` 默认会把正文读流，
//     不带这个头，就只剩「先读完再判」那条路，验不出「连读都不读」。

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../../sync-server/src/app';
import { D1Emulator } from '../../../sync-server/src/d1-emulator';

const SYNC_TOKEN = 'synthetic-sync-token-m34';
const db = new D1Emulator(':memory:');

const env = {
    FOLIA_SYNC_DB: db,
    SYNC_TOKEN,
};

/**
 * 造一个带 `Content-Length` 的请求。Hono 的 `bodyLimit` 先看这个头，超限就直接 413，
 * 不会读正文；没有这个头时它会退化成「先读完再判」，所以验「不读正文」必须显式带上。
 */
const sizedRequest = (route: string, method: string, body: string, headers: Record<string, string>) => (
    new Request(`https://synthetic.invalid${route}`, {
        method,
        headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
        body,
    })
);

const request = (route: string, init?: RequestInit) => app.request(
    `https://synthetic.invalid${route}`,
    init,
    env as never,
);

const auth = {
    authorization: `Bearer ${SYNC_TOKEN}`,
    'content-type': 'application/json',
};

const themeRecord = (index: number) => ({
    // 指纹按十进制编号，前 500 个互不相同（重复指纹会被 ON CONFLICT 合并，行数会少）。
    fingerprint: `m34-${index}`,
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString(),
    source: 'manual',
    theme: { light: { backgroundColor: '#ffffff' }, dark: { backgroundColor: '#000000' } },
});

const themeCount = async () => Number(
    (await db.prepare('SELECT COUNT(*) AS n FROM themes').first<{ n: number }>())?.n ?? 0,
);

beforeAll(async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network access is forbidden in this suite'); }));
    expect((await request('/health')).status).toBe(200);
});

beforeEach(async () => {
    await db.prepare('DELETE FROM themes').run();
    await db.prepare('DELETE FROM theme_buckets').run();
    await db.prepare('DELETE FROM ai_cache').run();
});

afterAll(() => {
    vi.unstubAllGlobals();
    (db as unknown as { db: { close(): void } }).db.close();
});

describe('同步请求体上限（issue M34）', () => {
    it('超过 2MB 的 /themes/put 回 413，且一行都不写', async () => {
        const before = await themeCount();
        const body = JSON.stringify({ themes: [themeRecord(1)], filler: 'x'.repeat(3 * 1024 * 1024) });
        const response = await app.request(sizedRequest('/themes/put', 'POST', body, auth), undefined, env as never);
        expect(response.status).toBe(413);
        expect(await response.json()).toEqual({ ok: false, error: 'payload_too_large' });
        expect(await themeCount()).toBe(before);
    });

    it('超过 2MB 的 /settings PUT 同样被挡下', async () => {
        const body = JSON.stringify({
            schemaVersion: 1,
            updatedAt: new Date().toISOString(),
            data: { filler: 'x'.repeat(3 * 1024 * 1024) },
        });
        const response = await app.request(sizedRequest('/settings', 'PUT', body, auth), undefined, env as never);
        expect(response.status).toBe(413);
    });

    it('500 条主题的合法批量写入仍然通过', async () => {
        const themes = Array.from({ length: 500 }, (_, index) => themeRecord(index));
        const body = JSON.stringify({ themes });
        // 这条用例同时说明 2MB 这个阈值不是随手定的：客户端能发的最坏情况是
        // 500 条（`MAX_THEME_BATCH_SIZE`），它离上限还有两个数量级的余量。
        expect(Buffer.byteLength(body)).toBeLessThan(2 * 1024 * 1024 / 4);
        const response = await app.request(sizedRequest('/themes/put', 'POST', body, auth), undefined, env as never);
        expect(response.status).toBe(200);
        expect((await response.json()).savedCount).toBe(500);
        expect(await themeCount()).toBe(500);
    });

    it('正常大小的设置写入仍然通过', async () => {
        const body = JSON.stringify({
            schemaVersion: 1,
            updatedAt: new Date().toISOString(),
            data: { theme: 'dark', backgroundOpacity: 0.6 },
        });
        const response = await app.request(sizedRequest('/settings', 'PUT', body, auth), undefined, env as never);
        expect(response.status).toBe(200);
        expect((await response.json()).ok).toBe(true);
    });
});

describe('公开接口的上限没有被顶掉（issue M34）', () => {
    it('云缓存 PUT 仍是它自己的 128KB，不是新加的 2MB', async () => {
        // 200KB 高于云缓存的 128KB、低于新加的 2MB：被挡下来就说明拦它的是原来那条。
        const body = JSON.stringify({ payload: { filler: 'x'.repeat(200 * 1024) }, songTitle: 'synthetic' });
        const response = await app.request(
            sizedRequest(`/api/ai-cache/stage/${'d'.repeat(32)}`, 'PUT', body, { 'content-type': 'application/json' }),
            undefined,
            env as never,
        );
        expect(response.status).toBe(413);
        expect((await response.json()).error).toBe('payload_too_large');
    });
});
