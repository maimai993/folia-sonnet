// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAiFetch } from '@/services/aiNativeFetch';

// 验证 #353：安卓冷启动桥尚未挂载时，createAiFetch 会短暂等待 FoliaNative 就绪再走原生请求，不提前退回浏览器 fetch 撞 CORS。

vi.mock('@/platform/runtime', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/platform/runtime')>(),
    isAndroidAppShell: () => true,
}));

afterEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('createAiFetch 安卓冷启动等待原生桥 (#353)', () => {
    it('桥在创建后延迟挂载时仍走 FoliaNative.aiRequest 而不回落浏览器 fetch', async () => {
        const browserFetch = vi.fn().mockRejectedValue(new Error('CORS blocked'));
        vi.stubGlobal('fetch', browserFetch);

        const aiRequest = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            body: JSON.stringify({ ok: true }),
        });

        const aiFetch = createAiFetch();

        setTimeout(() => {
            (window as unknown as { Capacitor: unknown }).Capacitor = {
                isNativePlatform: () => true,
                getPlatform: () => 'android',
                isPluginAvailable: (name: string) => name === 'FoliaNative',
                Plugins: {
                    FoliaNative: {
                        aiRequest,
                        httpRequest: vi.fn(),
                    },
                },
            };
        }, 60);

        const response = await aiFetch('https://api.example.com/v1/chat/completions', {
            method: 'POST',
            body: JSON.stringify({ test: true }),
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
        expect(aiRequest).toHaveBeenCalledTimes(1);
        expect(browserFetch).not.toHaveBeenCalled();
    });
});
