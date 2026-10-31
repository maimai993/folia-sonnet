import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestAiCompletion } from '@/services/aiCompletion';
import { generateThemeWithConfiguredAi, testConfiguredAiConnection } from '@/services/aiThemeClient';

// #54：在实际请求入口核对目的地/Authorization，所有网络都用 mock，不发送合成凭据。
const send = vi.hoisted(() => vi.fn());
vi.mock('@/services/aiNativeFetch', () => ({ createAiFetch: () => send }));
const KEY = 'synthetic-migration-key';
const URL_ = 'https://compat.example.invalid/v1';
const install = (seed: unknown) => {
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'foliaAiProviderSettings' ? JSON.stringify(seed) : null });
    send.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), { status: 200 }));
};
afterEach(() => { vi.unstubAllGlobals(); send.mockReset(); });

describe('AI migration request boundary (#54)', () => {
    it('sends a legacy compatible key only to its original custom endpoint', async () => {
        install({ provider: 'openai', openaiApiKey: KEY, openaiApiUrl: URL_, openaiApiModel: 'synthetic-model' });
        await requestAiCompletion({ system: 'system', prompt: 'hello', json: false });
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0][0]).toBe(`${URL_}/chat/completions`);
        expect(send.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${KEY}`);
    });
    it('sends the connection probe only to the migrated compatible endpoint', async () => {
        install({ provider: 'openai', openaiApiKey: KEY, openaiApiUrl: URL_, openaiApiModel: 'synthetic-model' });
        expect((await testConfiguredAiConnection()).ok).toBe(true);
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0][0]).toBe(`${URL_}/chat/completions`);
        expect(send.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${KEY}`);
    });
    it.each(['', '   '])('does not let the connection probe fall back to official when the old URL is %j', async url => {
        install({ provider: 'openai', openaiApiKey: KEY, openaiApiUrl: url });
        expect(await testConfiguredAiConnection()).toMatchObject({ ok: false, error: 'CUSTOM_API_URL is not configured' });
        await expect(requestAiCompletion({ system: 'system', prompt: 'hello' })).rejects.toThrow('ai-not-configured');
        expect(send).not.toHaveBeenCalled();
    });
    it('rejects a copied official key before both completion and connection probe send anything', async () => {
        install({ provider: 'openai', apiKeys: { openai: KEY, custom: KEY }, customApiUrl: URL_ });
        await expect(requestAiCompletion({ system: 'system', prompt: 'hello' })).rejects.toThrow('ai-not-configured');
        expect(await testConfiguredAiConnection()).toMatchObject({ ok: false, error: 'OPENAI_API_KEY is not configured' });
        await expect(generateThemeWithConfiguredAi('synthetic lyrics')).rejects.toThrow('OPENAI_API_KEY is not configured');
        expect(send).not.toHaveBeenCalled();
    });
});
