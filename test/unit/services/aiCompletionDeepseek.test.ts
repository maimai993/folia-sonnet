// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestAiCompletion } from '@/services/aiCompletion';
import { GEMINI_DEFAULT_API_BASE } from '../../../shared/geminiEndpoint.mjs';

// 当前文件：DeepSeek 必须走 OpenAI 兼容端点。
//
// 它是 OpenAI 兼容的，但**有自己的 provider id** —— 不是 'openai'。任何写成
// `provider === 'openai'` 的分支判断都会把它分到 Gemini 那半去，于是读空的
// geminiApiKey 并抛「未配置」。
//
// 用户能撞到的样子：设置里「测试连接」成功（那条路认的是 isOpenAiCompatibleProvider），
// 点「生成」却说没配置密钥 —— 同一份设置，两条路结论相反。

const state = vi.hoisted(() => ({ urls: [] as string[] }));

vi.mock('@/services/aiNativeFetch', () => ({
    createAiFetch: () => async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        state.urls.push(url);
        /* 两家回包的形状不一样，按端点给，免得解析那一步先炸了，测不到路由。
           判据是动作名 `:generateContent`，**不是域名** —— Gemini 的地址可由用户
           自己填（默认已是反代 apig.tangbot.xyz），按域名判会在换地址后失效。 */
        const body = url.includes(':generateContent')
            ? { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }
            : { choices: [{ message: { content: '{"ok":true}' } }] };
        return { ok: true, status: 200, json: async () => body } as unknown as Response;
    },
}));

beforeEach(async () => {
    state.urls.length = 0;
    // 「禁用 AI 推理」总闸默认打开（#401）。这几条验的是请求发往哪个端点，先把它关掉。
    // 直接改 store：它在 import 时就读过一次 localStorage，光写存储来不及。
    const { useAiInferenceSettingsStore } = await import('@/stores/useAiInferenceSettingsStore');
    useAiInferenceSettingsStore.getState().setAiInferenceDisabled(false);
    localStorage.setItem('foliaAiProviderSettings', JSON.stringify({
        provider: 'deepseek',
        deepseekApiKey: 'sk-test',
        /* Gemini 那半故意留空：一旦路由走错，这里就会让请求发不出去。 */
        geminiApiKey: '',
    }));
});

describe('AI 供应商路由', () => {
    it('DeepSeek 发往 DeepSeek 的端点，不是 Gemini 的', async () => {
        const result = await requestAiCompletion({ system: 's', prompt: 'p', json: true });

        expect(result.target.provider).toBe('deepseek');
        expect(state.urls.some((url) => url.includes('api.deepseek.com'))).toBe(true);
        /* 一条 Gemini 形状的请求都不该有（不看域名，只看动作名）。 */
        expect(state.urls.some((url) => url.includes(':generateContent'))).toBe(false);
    });

    it('Gemini 仍然发往 Gemini 的端点', async () => {
        localStorage.setItem('foliaAiProviderSettings', JSON.stringify({
            provider: 'gemini',
            geminiApiKey: 'gk-test',
        }));

        const result = await requestAiCompletion({ system: 's', prompt: 'p', json: true });

        expect(result.target.provider).toBe('gemini');
        /* 断言对着共享常量走：默认地址改了这里自动跟上，不会再假失败一次。 */
        expect(state.urls.some((url) => url.startsWith(GEMINI_DEFAULT_API_BASE))).toBe(true);
        expect(state.urls.some((url) => url.includes(':generateContent'))).toBe(true);
    });

    it('填了自定义请求地址时，Gemini 发往用户填的那个地址', async () => {
        localStorage.setItem('foliaAiProviderSettings', JSON.stringify({
            provider: 'gemini',
            geminiApiKey: 'gk-test',
            geminiApiUrl: 'https://my-proxy.example.com',
        }));

        const result = await requestAiCompletion({ system: 's', prompt: 'p', json: true });

        expect(result.target.provider).toBe('gemini');
        expect(state.urls.some((url) => url.startsWith('https://my-proxy.example.com/v1beta/models/'))).toBe(true);
        expect(state.urls.some((url) => url.startsWith(GEMINI_DEFAULT_API_BASE))).toBe(false);
    });
});
