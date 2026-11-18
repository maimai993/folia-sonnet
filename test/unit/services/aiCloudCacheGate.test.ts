// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/services/aiCloudCacheGate.test.ts
// 「禁用 AI 推理」与缓存的关系（#401，用户明确要求）：关着推理时**仍然要能用缓存里的结果** ——
// 读缓存不耗本地资源，不该被一起挡掉；只有「没命中、又要现算」才跳过，而且跳过不算失败。
//
// ★ 顺序上的保证在实现里：withAiCloudCache 的 canGenerate 判断写在**整段拉缓存之后**
//   （services/aiCloudCache.ts 里「缓存没命中、而此刻又不允许生成」那一段），命中走的是
//   它上面那条 `return { value: validated, source }` —— 根本到不了闸门。
//   所以「禁用推理不影响用缓存」靠的是这条结构，下面的用例钉住另一半行为。

const { store, generateCalls } = vi.hoisted(() => ({
    store: new Map<string, unknown>(),
    generateCalls: { count: 0 },
}));

vi.mock('@/services/db', () => ({
    getFromCache: async (key: string) => (store.has(key) ? store.get(key) : null),
    saveToCache: async (key: string, data: unknown) => { store.set(key, data); },
    removeFromCache: async (key: string) => { store.delete(key); },
}));

vi.mock('@/services/foliaCloud', () => ({
    isFoliaCloudCacheEnabled: () => true,
    resolveCloudApiUrl: (path: string) => `https://cloud.test/api/${path}`,
    DEFAULT_CLOUD_BASE_URL: 'https://cloud.test',
}));

vi.mock('@/services/aiNativeFetch', () => ({
    // 云端一律「没有」：这一组只验「没命中 + 不许生成」这条路径。
    createAiFetch: () => async () => ({
        ok: true,
        status: 200,
        json: async () => ({ hit: false }),
        text: async () => '{"hit":false}',
    } as unknown as Response),
    fetchAiCacheViaNative: async () => null,
}));

vi.mock('@/services/aiCompletion', () => ({
    describeAiTarget: () => null,
}));

const { withAiCloudCache } = await import('@/services/aiCloudCache');

const KEY = 'a'.repeat(32);

const call = (canGenerate: () => boolean) => withAiCloudCache<{ ok: boolean }>({
    kind: 'theme',
    fingerprint: KEY,
    generate: async () => {
        generateCalls.count += 1;
        return { ok: true };
    },
    validate: (value) => (value && typeof (value as { ok?: unknown }).ok === 'boolean' ? value as { ok: boolean } : null),
    songTitle: '夜航',
    canGenerate,
});

beforeEach(() => {
    store.clear();
    generateCalls.count = 0;
});

describe('缓存与「禁用 AI 推理」', () => {
    it('推理被禁用且缓存没命中：返回 null，不生成、不抛错', async () => {
        const result = await call(() => false);

        expect(result).toBeNull();
        expect(generateCalls.count).toBe(0);
    });

    it('允许生成时，缓存没命中就走生成（对照：闸门没挡住）', async () => {
        const result = await call(() => true);

        expect(result?.value).toEqual({ ok: true });
        expect(generateCalls.count).toBe(1);
    });

    it('不传 canGenerate（老调用方）时行为不变：照常生成', async () => {
        const result = await withAiCloudCache<{ ok: boolean }>({
            kind: 'theme',
            fingerprint: 'd'.repeat(32),
            generate: async () => {
                generateCalls.count += 1;
                return { ok: true };
            },
            validate: value => (value as { ok: boolean } | null) ?? null,
            songTitle: '夜航',
        });

        expect(result?.value).toEqual({ ok: true });
        expect(generateCalls.count).toBe(1);
    });
});
