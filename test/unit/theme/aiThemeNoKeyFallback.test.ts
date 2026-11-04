// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_NOT_CONFIGURED } from '@/services/aiCompletion';
import { withAiCloudCache } from '@/services/aiCloudCache';
import { combineStageParts, normalizeStagePayload, type StageParts } from '@/services/aiStage';
import { isMissingAiApiKeyError } from '@/services/gemini';
import { runLyricDirectorDecision } from '@/services/lyricDirector/director';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { useStatusMessageStore } from '@/stores/useStatusMessageStore';
import type { DualTheme } from '@/types';

// 当前文件：**没配置 AI 密钥时的行为**。
//
// 云缓存这个开关默认打开，本来就是为了没填 Key 的人 —— 他自己一个请求都发不出去，
// 能撞上别人推上来的那份就是白赚。所以「没密钥」必须能被认出来：
//
//  1. 它不是「生成失败」。后者是这一次调用出了问题、重试有可能过；前者是根本
//     发不出去、重来多少次都一样。混为一谈的后果是每切一首歌弹一遍「生成失败」，
//     用户只会以为这个功能坏了。
//  2. 自动切歌这条路上没人等结果，弹出来的提示既不是用户要的、也没人处理。
//     手动点「重新决策」的人不一样 —— 那种由调用方拿 kind:'unavailable' 自己说。
//  3. 只生成出一半的结果（部署端点与 Electron 只能出主题）回传时不能整条覆盖，
//     否则会把别人推上去的动画决策抹掉。
//
// 所有模块都静态 import：冷启动要将近两秒，放在用例里会顶过 5 秒超时，变成一条
// 跟代码无关的假失败。

const state = vi.hoisted(() => ({
    /** 云端那条 stage 缓存里现有的 payload；null 表示没命中。 */
    payload: null as unknown,
    /** 每次回传的 payload 都记下来，好断言有没有把已有的一半抹掉。 */
    pushed: [] as unknown[],
}));

vi.mock('@/services/aiNativeFetch', () => ({
    createAiFetch: () => async (input: unknown, init?: RequestInit) => {
        const method = (init?.method || 'GET').toUpperCase();
        if (method === 'PUT') {
            const body = JSON.parse(String(init?.body ?? '{}')) as { payload?: unknown };
            state.pushed.push(body.payload);
            return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
        }
        /*
         * POST = 按歌名捞候选（只回高亮词，判定在本机做）。
         *
         * 有歌词可判时拉缓存**不读精确键** —— 键对了不代表内容对。所以这个 mock 必须
         * 真答得出一条候选，否则用例会因为「接口没给候选」而红，验不到想验的东西。
         */
        if (method === 'POST') {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    ok: true,
                    candidates: state.payload === null
                        ? []
                        /* 这个词在 beforeEach 那两句假歌词里，判定过得去。 */
                        : [{ key: 'a'.repeat(32), words: ['歌词'] }],
                }),
            } as unknown as Response;
        }
        /* GET = 拉缓存 */
        return {
            ok: true,
            status: 200,
            json: async () => (state.payload === null
                ? { hit: false }
                : { hit: true, entry: { payload: state.payload } }),
        } as unknown as Response;
    },
}));

/*
 * 本机没有可以用的 AI 连接 —— 这就是「没配置密钥」时真正的报错。
 *
 * 只 stub 发请求那一个函数；判定函数 `isAiNotConfiguredError` 与常量都用真的，
 * 否则这条测试钉的就是 mock 自己了。
 */
vi.mock('@/services/aiCompletion', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/services/aiCompletion')>();
    return {
        ...actual,
        requestAiCompletion: async () => {
            throw new Error(actual.AI_NOT_CONFIGURED);
        },
    };
});

/*
 * 假主题：只填 `normalizeTheme` 认形状要的那两个字段（backgroundColor / primaryColor），
 * 其余必填项对这条测试没有意义，用断言跳过 —— 别让一份假数据把 Theme 的全套字段
 * 也钉在这里。
 */
const dualTheme = (name: string): DualTheme => ({
    light: { name: `${name}-light`, backgroundColor: '#ffffff', primaryColor: '#111111' },
    dark: { name: `${name}-dark`, backgroundColor: '#000000', primaryColor: '#eeeeee' },
} as unknown as DualTheme);

beforeEach(() => {
    state.payload = null;
    state.pushed.length = 0;
    /*
     * 明确选一个「要填 Key 的服务商，但没填」。
     *
     * 默认服务商现在是免费渠道（foliawork），它自带凭据、永远可用，所以「没填 Key」
     * 这件事只有在这种组合下才存在。不写死这一行，本文件验的就不是它想验的那条路了。
     */
    localStorage.setItem('foliaAiProviderSettings', JSON.stringify({ provider: 'gemini', geminiApiKey: '' }));
    localStorage.setItem('foliaCloudSettings.v2', JSON.stringify({
        enabled: true,
        baseUrl: 'https://cloud.test',
    }));
    /*
     * 假歌只填导演真正会读的那几个字段（id / name / artists 用来算 songKey，
     * lines 用来算指纹）。补全 SongResult 与 LyricData 的全套字段对这条测试
     * 没有意义，断言跳过。
     */
    usePlaybackStore.setState({
        currentSong: { id: 7, name: '测试曲', artists: [{ name: '测试歌手' }] },
        lyrics: { lines: [{ fullText: '一句歌词' }, { fullText: '又一句歌词' }] },
        playQueue: [],
        transitionDisplay: null,
    } as never);
    useStatusMessageStore.setState({ message: null });
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('没有配置密钥时', () => {
    it('密钥没填这件事要能被认出来，不能当成普通生成失败', () => {
        expect(isMissingAiApiKeyError(new Error(AI_NOT_CONFIGURED))).toBe(true);
        /* 真出错（接口 500）仍然算失败，不该走「没配置」那条兜底。 */
        expect(isMissingAiApiKeyError(new Error('HTTP 500'))).toBe(false);
    });

    it('只生成出一半的结果回传时不抹掉云端已有的另一半', async () => {
        /*
         * 云端现有的：只有动画决策，没有主题（比如只跑过导演那条路）。
         * 这次要的是主题，于是 validate 判它没命中、走进生成。
         */
        state.payload = { decision: { mode: 'sonnet', reason: 'r', params: {} } };

        /*
         * 部署端点与 Electron 那条路只能出主题 —— 拿到手的「新答案」天生只有半份。
         * 整条回传就会把云端已有的动画决策抹掉。
         */
        /* 显式给泛型：只出一半时 T 会被推断成「只有 theme」，合并不回另一半就说不通。 */
        const result = await withAiCloudCache<StageParts>({
            kind: 'stage',
            fingerprint: 'f'.repeat(32),
            generate: async () => ({ theme: dualTheme('new') }),
            validate: (payload) => {
                const parts = normalizeStagePayload(payload, []);
                return parts && parts.theme ? parts : null;
            },
            combine: (previous, fresh) => combineStageParts(previous, fresh, []),
        });

        expect(result.source).toBe('ai');
        expect(state.pushed).toHaveLength(1);
        /* 新生成的主题用新的，动画决策保留云端那份 —— 两条都在。 */
        const uploaded = state.pushed[0] as { theme?: { light?: { name?: string } }; decision?: { mode?: string } };
        expect(uploaded.theme?.light?.name).toBe('new-light');
        expect(uploaded.decision?.mode).toBe('sonnet');
    });

    it('云缓存里有的那半照常用，缺的那半生不出来就安静跳过', async () => {
        /* 云端只有主题，没有动画决策；本机又发不出去请求。 */
        state.payload = { theme: dualTheme('cached') };

        const outcome = await runLyricDirectorDecision({ announce: true });

        expect(outcome.kind).toBe('unavailable');
        /* 自动这条路上没人等结果 —— 弹一条失败提示既没人要也没人处理。 */
        expect(useStatusMessageStore.getState().message).toBeNull();
    });

    it('别人推上去的动画决策要能被认出来，导演照常切换样式', async () => {
        const { useVisualizerSettingsStore } = await import('@/stores/useVisualizerSettingsStore');
        const { runLyricDirectorDecision: run } = await import('@/services/lyricDirector/director');
        useVisualizerSettingsStore.setState({ visualizerMode: 'classic' } as never);

        /*
         * 云端躺着一条完整的：主题 + 动画决策。
         *
         * 拉回来时决策收在 decision 那半里，不是跟 theme 并列在顶层 —— 解析的要是
         * 认错地方，导演就会一直以为「这首歌还没有决策」。
         */
        state.payload = {
            theme: dualTheme('cached'),
            decision: { mode: 'sonnet', reason: 'r', params: {} },
        };

        const outcome = await run({ announce: true });

        expect(outcome.kind).toBe('applied');
        expect(useVisualizerSettingsStore.getState().visualizerMode).toBe('sonnet');
        /* 命中的那次一个字节都没上传 —— 提示里不该出现「上传成功」。 */
        expect(useStatusMessageStore.getState().message).toBeNull();
    });
});
