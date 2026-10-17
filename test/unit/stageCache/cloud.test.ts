import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pullStageCloud, putStageCloud } from '@/services/stageCache/cloud';
import { normalizeStageIdentity } from '@/services/stageCache/identity';
import type { StagePayload } from '@/services/stageCache/repository';

// test/unit/stageCache/cloud.test.ts — 新协议身份参数、条件请求、补缺响应和有限等待。
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), enabled: true }));
vi.mock('@/services/aiNativeFetch', () => ({ createAiFetch: () => mocks.fetch }));
vi.mock('@/services/foliaCloud', () => ({ isFoliaCloudCacheEnabled: () => mocks.enabled,
    resolveCloudBaseUrl: () => 'https://cloud.test' }));
const identity = normalizeStageIdentity({ title: 'Song (Live)', artists: ['A & B'] })!;
const payload = { theme: { light: {}, dark: {} }, decision: { mode: 'flow', reason: '', params: {} } } as StagePayload;
const hit = { hit: true, identityKey: identity.key, revision: 'remote-v2', payload };
beforeEach(() => { mocks.fetch.mockReset(); mocks.enabled = true; });
afterEach(() => vi.useRealTimers());
describe('stage cloud', () => {
    it('uses the shared native-capable fetch with structured identity and conditional revision', async () => {
        mocks.fetch.mockResolvedValue(new Response(null, { status: 304 }));
        await expect(pullStageCloud({ identity, revision: 'v1', provider: 'qq', mediaId: '42' })).resolves.toEqual({ status: 'not-modified', revision: 'v1' });
        const [raw, init] = mocks.fetch.mock.calls[0];
        const url = new URL(raw);
        expect(url.pathname).toBe('/api/ai-stage');
        expect(JSON.parse(url.searchParams.get('artists')!)).toEqual(['a & b']);
        expect(url.searchParams.get('title')).toBe('song(live)');
        expect(url.searchParams.get('provider')).toBe('qq');
        expect(url.searchParams.get('mediaId')).toBe('42');
        expect(init.headers['If-None-Match']).toBe('"v1"');
    });
    it('returns the existing public version after PUT rather than assuming the submitted candidate won', async () => {
        mocks.fetch.mockResolvedValue(Response.json(hit));
        const result = await putStageCloud({ identity }, payload);
        expect(result).toMatchObject({ status: 'hit', revision: 'remote-v2', payload });
        const [, init] = mocks.fetch.mock.calls[0];
        expect(init.method).toBe('PUT');
        expect(JSON.parse(init.body)).toMatchObject({ title: identity.title, artists: identity.artists, payload });
    });
    it('distinguishes miss from failure and rejects wrong identity', async () => {
        mocks.fetch.mockResolvedValueOnce(Response.json({ hit: false }));
        await expect(pullStageCloud({ identity })).resolves.toEqual({ status: 'miss' });
        mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 500 }));
        await expect(pullStageCloud({ identity })).resolves.toEqual({ status: 'unavailable' });
        mocks.fetch.mockResolvedValueOnce(Response.json({ ...hit, identityKey: 'wrong' }));
        await expect(pullStageCloud({ identity })).resolves.toEqual({ status: 'unavailable' });
    });
    it('stops waiting even if the native bridge ignores JS abort', async () => {
        vi.useFakeTimers();
        mocks.fetch.mockImplementation(() => new Promise(() => {}));
        const pending = pullStageCloud({ identity, timeoutMs: 20 });
        await vi.advanceTimersByTimeAsync(20);
        await expect(pending).resolves.toEqual({ status: 'unavailable' });
        expect(vi.getTimerCount()).toBe(0);
    });
    it('does not access network when disabled or cancelled', async () => {
        mocks.enabled = false;
        await expect(pullStageCloud({ identity })).resolves.toEqual({ status: 'unavailable' });
        expect(mocks.fetch).not.toHaveBeenCalled();
    });
});
