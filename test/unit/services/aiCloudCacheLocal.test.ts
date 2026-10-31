// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/services/aiCloudCacheLocal.test.ts
// 云缓存的本地一层：本机存着就用本机、云端给过的落本地、问过没有的别再问、
// 以及「有歌词可判时不认本地那份 exact」这条纪律。

const { store, handlers } = vi.hoisted(() => ({
    store: new Map<string, unknown>(),
    handlers: {
        fetch: null as null | ((url: string, init?: RequestInit) => Promise<Response>),
        calls: 0,
    },
}));

vi.mock('@/services/db', () => ({
    getFromCache: async (key: string) => (store.has(key) ? store.get(key) : null),
    saveToCache: async (key: string, data: unknown) => {
        store.set(key, data);
    },
    removeFromCache: async (key: string) => {
        store.delete(key);
    },
}));

vi.mock('@/services/foliaCloud', () => ({
    isFoliaCloudCacheEnabled: () => true,
    resolveCloudApiUrl: (path: string) => `https://cloud.test/api/${path}`,
    DEFAULT_CLOUD_BASE_URL: 'https://cloud.test',
}));

vi.mock('@/services/aiNativeFetch', () => ({
    createAiFetch: () => (input: RequestInfo | URL, init?: RequestInit) => {
        handlers.calls += 1;
        return (handlers.fetch as NonNullable<typeof handlers.fetch>)(String(input), init);
    },
    fetchAiCacheViaNative: async () => null,
}));

vi.mock('@/services/aiCompletion', () => ({
    describeAiTarget: () => null,
}));

const { pullAiCloudCache, withAiCloudCache } = await import('@/services/aiCloudCache');
const { readLocalCloudEntry, readLocalCloudMiss, rememberLocalCloudMiss, writeLocalCloudEntry } =
    await import('@/services/aiCloudCacheLocal');

/* 每个用例一把自己的键：内存里那份「刚问过没有」和对本地层的写入都按这个键走。 */
const KEY_LOCAL_FIRST = 'aa11bb22'.repeat(4);
const KEY_MISS = 'bb22cc33'.repeat(4);
const KEY_EXACT_ONLY = 'cc33dd44'.repeat(4);
const KEY_TTL = 'dd44ee55'.repeat(4);
const KEY_STALE = 'ee55ff66'.repeat(4);

const jsonResponse = (body: unknown, ok = true) => ({
    ok,
    status: ok ? 200 : 404,
    json: async () => body,
}) as unknown as Response;

const hitBody = { hit: true, entry: { payload: { theme: { mood: 'cloud' } } } };

beforeEach(() => {
    store.clear();
    handlers.calls = 0;
    handlers.fetch = async () => jsonResponse(hitBody);
});

describe('云缓存的本地一层', () => {
    it('把云端给的答案落本地，第二次拉取不再发请求', async () => {
        const first = await pullAiCloudCache('theme', KEY_LOCAL_FIRST, { songTitle: '夜航' });
        expect(first).toEqual({ status: 'hit', payload: { theme: { mood: 'cloud' } }, matched: 'exact' });
        expect(handlers.calls).toBe(1);

        const second = await pullAiCloudCache('theme', KEY_LOCAL_FIRST, { songTitle: '夜航' });
        expect(second.status).toBe('hit');
        expect(second.status === 'hit' && second.local).toBe(true);
        /* 关键：只在本地命中，一次都没再问服务器。 */
        expect(handlers.calls).toBe(1);
    });

    it('记下「问过、云端没有」，下一次不再发请求', async () => {
        handlers.fetch = async () => jsonResponse({ hit: false }, false);

        const first = await pullAiCloudCache('theme', KEY_MISS, { songTitle: '夜航' });
        expect(first.status).toBe('miss');
        const askedOnce = handlers.calls;
        expect(askedOnce).toBeGreaterThan(0);

        const second = await pullAiCloudCache('theme', KEY_MISS, { songTitle: '夜航' });
        expect(second.status).toBe('miss');
        expect(handlers.calls).toBe(askedOnce);
        expect(await readLocalCloudMiss('theme', KEY_MISS)).toBe(true);
    });

    it('有歌词可判的时候不认本地那份 only-exact 的答案', async () => {
        /* 早年的「强制匹配」把别首的答案写在这个键上过，本地存下来的 exact 不能当准。 */
        await writeLocalCloudEntry('stage', KEY_EXACT_ONLY, { decision: { stale: true } }, 'exact');

        const pulled = await pullAiCloudCache('stage', KEY_EXACT_ONLY, {
            songTitle: '夜航',
            lyricText: '第一行\n第二行',
        });
        /* 走到了云端那条路（这次云端全都没有，于是 miss）。 */
        expect(handlers.calls).toBeGreaterThan(0);
        expect(pulled.status).toBe('miss');
    });

    it('本地 miss 过了 TTL 就作废，下次重新问', async () => {
        await rememberLocalCloudMiss('theme', KEY_TTL);
        expect(await readLocalCloudMiss('theme', KEY_TTL)).toBe(true);

        const now = Date.now();
        const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 13 * 60 * 60 * 1000);
        try {
            expect(await readLocalCloudMiss('theme', KEY_TTL)).toBe(false);
        } finally {
            spy.mockRestore();
        }
        /* 过期那条顺手清掉了。 */
        expect(store.has(`ai_cloud_miss_v1_theme_${KEY_TTL}`)).toBe(false);
    });

    it('本地那份没过校验就丢掉，让下一次回云端问', async () => {
        await writeLocalCloudEntry('theme', KEY_STALE, { theme: { broken: true } }, 'words');

        const result = await withAiCloudCache({
            kind: 'theme',
            fingerprint: KEY_STALE,
            generate: async () => ({ theme: { fresh: true } }),
            validate: (value) => (
                (value as { theme?: { fresh?: boolean } })?.theme?.fresh === true
                    ? (value as { theme: { fresh: boolean } })
                    : null
            ),
            skipPull: false,
        });

        expect(result.value).toEqual({ theme: { fresh: true } });
        expect(result.source).toBe('ai');
        /* 脏的那份被抹掉了：老答案不能一直挡着；留下来的是这次新生成的那一份。 */
        const after = await readLocalCloudEntry('theme', KEY_STALE);
        expect(after?.how).toBe('own');
        expect(after?.payload).toEqual({ theme: { fresh: true } });
    });
});
