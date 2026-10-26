import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * AI 请求走哪一条路（aiNativeFetch.ts）。
 *
 * 这条链路是「后台切歌，AI 主题一次都没生成」的修复本身：整趟交给原生之后，
 * WebView 被冻结也不影响请求跑完。所以这里钉的是**选路**与**回落**：
 * 原生在就走原生、原生不在或出错就回落通用转发，且回落的请求不能丢。
 */

const aiRequest = vi.fn();
const baseFetch = vi.fn();

vi.mock('../../../src/services/nativeHttpFetch', () => ({
    createNativeFetch: () => baseFetch,
    isNativeHttpFetchAvailable: () => true,
}));

const installCapacitor = (plugins: Record<string, unknown>, platform = 'android') => {
    (globalThis as unknown as { window: unknown }).window = {
        Capacitor: {
            isNativePlatform: () => platform === 'android',
            getPlatform: () => platform,
            isPluginAvailable: (name: string) => name in plugins,
            Plugins: plugins,
        },
    };
};

describe('createAiFetch', () => {
    beforeEach(() => {
        vi.resetModules();
        aiRequest.mockReset();
        baseFetch.mockReset();
    });

    afterEach(() => {
        delete (globalThis as unknown as { window?: unknown }).window;
    });

    it('sends through the native bridge when it is there', async () => {
        installCapacitor({ FoliaNative: { aiRequest } });
        aiRequest.mockResolvedValue({ ok: true, status: 200, body: '{"ok":1}' });
        const { createAiFetch } = await import('../../../src/services/aiNativeFetch');
        const response = await createAiFetch()('https://api.example/v1/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"q":1}',
        });
        expect(aiRequest).toHaveBeenCalledTimes(1);
        const sent = aiRequest.mock.calls[0][0];
        expect(sent.url).toBe('https://api.example/v1/chat');
        expect(sent.method).toBe('POST');
        expect(sent.body).toBe('{"q":1}');
        expect(baseFetch).not.toHaveBeenCalled();
        // 回给调用方的仍是一个正常的 Response：状态码与正文都要在。
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('{"ok":1}');
        // 正文是 JSON，调用方按 JSON 解析：这条头不能丢。
        expect(response.headers.get('content-type')).toBe('application/json');
    });

    it('falls back to the shared forwarder when the native bridge is absent', async () => {
        installCapacitor({ FoliaNative: {} });
        baseFetch.mockResolvedValue(new Response('{}', { status: 200 }));
        const { createAiFetch } = await import('../../../src/services/aiNativeFetch');
        await createAiFetch()('https://api.example/v1/chat', { method: 'POST', body: '{}' });
        expect(aiRequest).not.toHaveBeenCalled();
        expect(baseFetch).toHaveBeenCalledTimes(1);
    });

    it('falls back when the native bridge answers nothing', async () => {
        // 桥出错时 requestAiViaNative 回 null：请求不能因此丢掉，得走回落那条。
        installCapacitor({ FoliaNative: { aiRequest } });
        aiRequest.mockResolvedValue(null);
        baseFetch.mockResolvedValue(new Response('{}', { status: 200 }));
        const { createAiFetch } = await import('../../../src/services/aiNativeFetch');
        await createAiFetch()('https://api.example/v1/chat', { method: 'POST', body: '{}' });
        expect(baseFetch).toHaveBeenCalledTimes(1);
    });

    it('falls back when the native bridge throws', async () => {
        installCapacitor({ FoliaNative: { aiRequest } });
        aiRequest.mockRejectedValue(new Error('bridge exploded'));
        baseFetch.mockResolvedValue(new Response('{}', { status: 200 }));
        const { createAiFetch } = await import('../../../src/services/aiNativeFetch');
        await createAiFetch()('https://api.example/v1/chat', { method: 'POST', body: '{}' });
        expect(baseFetch).toHaveBeenCalledTimes(1);
    });

    it('does not reach for the bridge off Android', async () => {
        installCapacitor({ FoliaNative: { aiRequest } }, 'web');
        baseFetch.mockResolvedValue(new Response('{}', { status: 200 }));
        const { createAiFetch } = await import('../../../src/services/aiNativeFetch');
        await createAiFetch()('https://api.example/v1/chat', { method: 'POST', body: '{}' });
        expect(aiRequest).not.toHaveBeenCalled();
        expect(baseFetch).toHaveBeenCalledTimes(1);
    });
});
