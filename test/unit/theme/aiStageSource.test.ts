// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestStage } from '@/services/aiStage';

// 当前文件：`source` 说的是**这次结果从哪来**，界面靠它选提示文案。
//
//  'cloud' = 这会儿没调模型，用的是别人推上去（或云端既有）的那份；
//  'ai'    = 这台机器刚真的问了一次模型。
//
// 进程内去重命中时不能一律标 'cloud' —— 那一次的答案正是这台机器刚算出来的，标成
// cloud 会让刚生成完的用户看到「已从云端拉取缓存」，而这一句本来是留给「白拿别人的」
// 那种情况。两条链路（主题、导演）共用同一个指纹，撞的就是这一层。

const state = vi.hoisted(() => ({ payload: null as unknown, candidateKey: 'a'.repeat(32) }));

/*
 * 云端有两条接口，形状不一样：
 *  - POST /api/ai-cache/resolve       → { candidates: [{ key, words }] }
 *  - GET  /api/ai-cache/<kind>/<key>  → { hit: true, entry: { payload } }
 *
 * 2026-10-17 起「精确键没中时按歌名捞一条内容合规的」：带歌名又有歌词的请求**先**走候选
 * 那条，只有没歌名可判时才直接读精确键。所以桩要按地址分开答 —— 只答精确键那种形状，
 * 候选会一直是空的，于是「云端明明有」也会被判成没命中，测出来的来源永远是 'ai'。
 */
vi.mock('@/services/aiNativeFetch', () => ({
    createAiFetch: () => async (url: string) => {
        const hit = state.payload !== null;
        const body = url.endsWith('/ai-cache/resolve')
            ? (hit ? { candidates: [{ key: state.candidateKey, words: ['另一首的第一句'] }] } : { candidates: [] })
            : (hit ? { hit: true, entry: { payload: state.payload } } : { hit: false });
        return {
            ok: true,
            status: 200,
            json: async () => body,
        } as unknown as Response;
    },
}));

/* 一台「有密钥、能生成」的机器。 */
vi.mock('@/services/aiCompletion', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/services/aiCompletion')>();
    const theme = {
        light: { name: 'gen-light', backgroundColor: '#ffffff', primaryColor: '#111111' },
        dark: { name: 'gen-dark', backgroundColor: '#000000', primaryColor: '#eeeeee' },
    };
    return {
        ...actual,
        requestAiCompletion: async () => ({
            text: JSON.stringify({ theme, mode: 'sonnet', reason: 'r', params: {} }),
            target: { provider: 'gemini', model: 'm' },
        }),
    };
});

const lines = (a: string, b: string) => [{ fullText: a }, { fullText: b }];

beforeEach(() => {
    state.payload = null;
    /*
     * 选一个「填了 Key、能生成」的服务商。
     *
     * 默认服务商现在是免费渠道（foliawork），它走自己那条原生端点（见
     * services/aiCompletion.ts 的 requestThemeFromFoliaWork），而本文件把
     * `requestAiCompletion` 换成了假实现 —— 走免费渠道就绕过了它，验的东西就变了。
     * 这个文件钉的是来源标签，与哪一家无关，写死一个能走到那条假实现的服务商即可。
     */
    localStorage.setItem('foliaAiProviderSettings', JSON.stringify({ provider: 'gemini', geminiApiKey: 'test-key' }));
    localStorage.setItem('foliaCloudSettings.v2', JSON.stringify({
        enabled: true,
        baseUrl: 'https://cloud.test',
    }));
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('stage 结果的来源标签', () => {
    it('自己刚生成完的，不能说成是从云端拉的', async () => {
        const shared = { lines: lines('这一首的第一句', '这一首的第二句'), songTitle: '甲' };

        const themeRun = await requestStage({ ...shared, require: 'theme' });
        expect(themeRun.source).toBe('ai');

        /*
         * 导演这条链路接着问同一段歌词，命中进程内「刚算完」那份。
         * 那份是这台机器生成的，来源就该还是 'ai'。
         */
        const directorRun = await requestStage({ ...shared, require: 'decision' });
        expect(directorRun.source).toBe('ai');
        expect(directorRun.decision?.mode).toBe('sonnet');
    });

    it('真从云端拿到的才标成云端', async () => {
        state.payload = {
            theme: {
                light: { name: 'cached-light', backgroundColor: '#ffffff', primaryColor: '#111111' },
                dark: { name: 'cached-dark', backgroundColor: '#000000', primaryColor: '#eeeeee' },
            },
            decision: { mode: 'sonnet', reason: 'r', params: {} },
        };

        const result = await requestStage({
            lines: lines('另一首的第一句', '另一首的第二句'),
            songTitle: '乙',
            require: 'theme',
        });

        expect(result.source).toBe('cloud');
        expect(result.theme?.light?.name).toBe('cached-light');
    });
});
