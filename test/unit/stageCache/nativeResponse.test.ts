// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAiFetch } from '@/services/aiNativeFetch';

// test/unit/stageCache/nativeResponse.test.ts — 条件请求的原生304不能构造带body的Response。
afterEach(() => { delete (window as unknown as { Capacitor?: unknown }).Capacitor; });
describe('native conditional cache response', () => {
    it('preserves 304 and ETag without a response body', async () => {
        Object.assign(window, { Capacitor: { isNativePlatform: () => true,
            Plugins: { FoliaNative: { httpRequest: vi.fn().mockResolvedValue({ status: 304, bodyBase64: '', headers: { ETag: '"v1"' } }) } } } });
        const response = await createAiFetch()('https://cloud.test/api/ai-stage');
        expect(response.status).toBe(304);
        expect(response.headers.get('ETag')).toBe('"v1"');
        expect(await response.text()).toBe('');
    });
});
