import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStageRuntime, subscribeStageUpdates } from '@/services/stageCache/runtime';
import type { StageParts, StageRequest } from '@/services/aiStage';

// test/unit/stageCache/runtime.test.ts — 持久化失败与迟到云版本不触发重复生成或旧版本覆盖。
const mocks = vi.hoisted(() => ({ rows: new Map<string, unknown>(), fail: false, pull: vi.fn(), put: vi.fn() }));
vi.mock('@/services/repositories/cacheRepository', () => ({
    putCacheEntry: async (key: string, data: unknown) => { if (mocks.fail) throw Error('quota'); mocks.rows.set(key, structuredClone(data)); },
    readCacheEntry: async (key: string) => structuredClone(mocks.rows.get(key) ?? null),
    readCacheEntriesByKey: async () => [], removeCacheEntry: async () => {},
}));
vi.mock('@/services/stageCache/cloud', () => ({ resolveStageCloudNamespace: () => 'https://cloud.test',
    pullStageCloud: (...args: unknown[]) => mocks.pull(...args), putStageCloud: (...args: unknown[]) => mocks.put(...args) }));
vi.mock('@/services/aiCloudCache', () => ({ pullAiCloudCache: async () => ({ status: 'miss' }) }));
const payload = (mode: string) => ({ theme: { light: {}, dark: {} }, decision: { mode, reason: '', params: {} } }) as StageParts;
const request = (title: string, extra: Partial<StageRequest> = {}): StageRequest => ({ song: { title, artists: ['Artist'], artist: 'Artist', album: null }, priority: 'manual', ...extra });
const runtime = () => createStageRuntime(value => value as StageParts);
beforeEach(() => { mocks.rows.clear(); mocks.fail = false; mocks.pull.mockReset().mockResolvedValue({ status: 'miss' }); mocks.put.mockReset().mockResolvedValue({ status: 'unavailable' }); });
describe('stage runtime', () => {
    it('uses cloud payload even when offline storage fails, without generating again', async () => {
        mocks.fail = true;
        mocks.pull.mockResolvedValue({ status: 'hit', revision: 'v1', payload: payload('cloud') });
        const generate = vi.fn(async () => payload('ai'));
        expect(await runtime().resolve(request('quota-cloud'), 'quota', generate)).toMatchObject({ source: 'cloud', decision: { mode: 'cloud' } });
        expect(generate).not.toHaveBeenCalled();
    });
    it('returns AI result and still attempts public contribution after local write failure', async () => {
        mocks.fail = true;
        const generate = vi.fn(async () => payload('ai'));
        expect(await runtime().resolve(request('quota-ai'), 'quota-ai', generate)).toMatchObject({ source: 'ai' });
        expect(generate).toHaveBeenCalledTimes(1);
        expect(mocks.put).toHaveBeenCalledTimes(1);
    });
    it('restores forced private selections without uploading them', async () => {
        const service = runtime();
        const song = request('private-song');
        await service.resolve({ ...song, force: true }, 'private', async () => payload('personal'));
        const generate = vi.fn(async () => payload('wrong'));
        expect(await service.resolve(song, 'private', generate)).toMatchObject({ source: 'local', decision: { mode: 'personal' } });
        expect((await service.restore(song.song))?.current.payload.decision.mode).toBe('personal');
        expect(mocks.put).not.toHaveBeenCalled();
        expect(generate).not.toHaveBeenCalled();
    });
    it('shares partial results in memory when trusted identity is missing', async () => {
        const service = runtime();
        const generate = vi.fn(async () => ({ decision: payload('flow').decision }));
        const input: StageRequest = { priority: 'manual' };
        await service.resolve(input, 'partial', generate);
        await service.resolve(input, 'partial', generate);
        expect(generate).toHaveBeenCalledTimes(1);
    });
    it('reports own successful contribution as AI and the existing different public version as cloud', async () => {
        const service = runtime();
        mocks.put.mockResolvedValueOnce({ status: 'hit', revision: 'own', payload: payload('own') });
        expect(await service.resolve(request('own-upload'), 'own', async () => payload('own'))).toMatchObject({ source: 'ai' });
        mocks.put.mockResolvedValueOnce({ status: 'hit', revision: 'existing', payload: payload('existing') });
        expect(await service.resolve(request('other-upload'), 'other', async () => payload('candidate'))).toMatchObject({ source: 'cloud', decision: { mode: 'existing' } });
    });
    it('isolates customized payloads from public and other custom domains', async () => {
        const service = runtime();
        const song = request('custom', { publicEligible: false, hint: 'my custom' });
        await service.resolve(song, 'custom-a', async () => payload('personal-a'));
        const generate = vi.fn(async () => payload('wrong'));
        expect(await service.resolve(song, 'custom-a', generate)).toMatchObject({ source: 'local', decision: { mode: 'personal-a' } });
        expect(generate).not.toHaveBeenCalled();
        expect(await service.resolve({ ...song, hint: 'another' }, 'custom-b', async () => payload('personal-b'))).toMatchObject({ source: 'ai', decision: { mode: 'personal-b' } });
        expect(mocks.put).not.toHaveBeenCalled();
    });
    it('checks local versions in background and emits an accepted update', async () => {
        const service = runtime();
        const song = request('update-song');
        mocks.pull.mockResolvedValue({ status: 'hit', revision: 'v1', payload: payload('v1') });
        await service.resolve(song, 'update', async () => payload('bad'));
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
        mocks.pull.mockResolvedValue({ status: 'hit', revision: 'v2', payload: payload('v2') });
        const listener = vi.fn();
        const off = subscribeStageUpdates(listener);
        expect(await service.resolve(song, 'update', async () => payload('bad'))).toMatchObject({ source: 'local', decision: { mode: 'v1' } });
        await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(expect.objectContaining({ revision: 'v2', reason: 'update' })));
        expect((await service.restore(song.song))?.previous?.revision).toBe('v1');
        off(); vi.restoreAllMocks();
    });
});
