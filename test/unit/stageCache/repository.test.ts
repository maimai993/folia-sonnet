import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStageRepository, type StagePayload } from '@/services/stageCache/repository';
import { normalizeStageIdentity } from '@/services/stageCache/identity';

// test/unit/stageCache/repository.test.ts — 原子写失败、半截结果、云命名空间和本机回退。
const storage = vi.hoisted(() => ({ rows: new Map<string, unknown>(), fail: false }));
vi.mock('@/services/repositories/cacheRepository', () => ({
    putCacheEntry: async (key: string, value: unknown) => {
        if (storage.fail) throw Error('quota');
        storage.rows.set(key, structuredClone(value));
    },
    readCacheEntry: async (key: string) => structuredClone(storage.rows.get(key) ?? null),
    readCacheEntriesByKey: async (filter: (key: string) => boolean) => [...storage.rows]
        .filter(([key]) => filter(key)).map(([key, data]) => ({ key, data, timestamp: 0 })),
    removeCacheEntry: async (key: string) => { storage.rows.delete(key); },
}));
const payload = { theme: { light: {}, dark: {} }, decision: { mode: 'flow', reason: '', params: {} } } as StagePayload;
const validate = (value: unknown) => {
    const candidate = value as StagePayload | null;
    return candidate?.theme?.light && candidate.theme.dark && candidate.decision?.mode ? candidate : null;
};
const identity = normalizeStageIdentity({ title: 'Song', artists: ['Artist'] })!;
const input = { identity, baseUrl: 'https://one', payload, revision: 'v1', source: 'cloud' as const };
beforeEach(() => { storage.rows.clear(); storage.fail = false; });
describe('stage repository', () => {
    it('recovers after recreation and isolates cloud addresses', async () => {
        await createStageRepository({ validate }).save(input);
        const repository = createStageRepository({ validate });
        expect((await repository.read('https://one/', identity.key))?.current.revision).toBe('v1');
        expect(await repository.read('https://two', identity.key)).toBeNull();
    });
    it('keeps the full old version on invalid data or storage failure', async () => {
        const repository = createStageRepository({ validate });
        await repository.save(input);
        await expect(repository.save({ ...input, payload: { theme: payload.theme }, revision: 'v2' })).rejects.toThrow();
        storage.fail = true;
        await expect(repository.save({ ...input, revision: 'v2' })).rejects.toThrow('quota');
        expect((await repository.read(input.baseUrl, identity.key))?.current.revision).toBe('v1');
    });
    it('pins rollback across repeated and newer remote arrivals until explicit acceptance', async () => {
        const repository = createStageRepository({ validate });
        await repository.save(input);
        await repository.save({ ...input, revision: 'v2' });
        const reverted = await repository.rollback(input.baseUrl, identity.key);
        expect(reverted).toMatchObject({ pinned: true, rejectedRevision: 'v2', current: { revision: 'v1' } });
        await repository.save({ ...input, revision: 'v2' });
        await repository.save({ ...input, revision: 'v3' });
        expect((await repository.read(input.baseUrl, identity.key))?.current.revision).toBe('v1');
        expect((await repository.acceptUpdate(input.baseUrl, identity.key, 'v3'))).toMatchObject({ pinned: false, current: { revision: 'v3' } });
    });
    it('stores background updates without activating and rejects corrupted persisted payloads', async () => {
        const repository = createStageRepository({ validate });
        await repository.save(input);
        expect(await repository.save({ ...input, revision: 'v2', activate: false })).toMatchObject({ current: { revision: 'v1' }, remoteRevision: 'v2' });
        const row = [...storage.rows.values()][0] as { current: { payload: unknown } };
        row.current.payload = { theme: payload.theme };
        expect(await repository.read(input.baseUrl, identity.key)).toBeNull();
    });
    it('rejects stale notification rollback and acceptance atomically', async () => {
        const repository = createStageRepository({ validate });
        await repository.save(input);
        await repository.save({ ...input, revision: 'v2' });
        expect(await repository.rollback(input.baseUrl, identity.key, 'v1')).toBeNull();
        expect((await repository.rollback(input.baseUrl, identity.key, 'v2'))?.current.revision).toBe('v1');
        expect(await repository.acceptUpdate(input.baseUrl, identity.key, 'v2', 'v2')).toBeNull();
        expect((await repository.acceptUpdate(input.baseUrl, identity.key, 'v2', 'v1'))?.current.revision).toBe('v2');
    });
    it('atomically refuses a late generated candidate when a newer full version exists', async () => {
        const repository = createStageRepository({ validate });
        await repository.save({ ...input, revision: 'remote-v3' });
        expect(await repository.save({ ...input, revision: 'late-ai', source: 'ai', onlyIfAbsent: true }))
            .toMatchObject({ current: { revision: 'remote-v3' } });
        expect((await repository.read(input.baseUrl, identity.key))?.previous).toBeUndefined();
    });
    it('enforces capacity while preserving rollback records', async () => {
        const repository = createStageRepository({ validate, maxEntries: 1 });
        await repository.save(input);
        await repository.save({ ...input, revision: 'v2' });
        await expect(repository.save({ ...input, identity: normalizeStageIdentity({ title: 'Other', artists: ['Artist'] })! })).rejects.toThrow('protected');
        expect((await repository.read(input.baseUrl, identity.key))?.current.revision).toBe('v2');
    });
});
