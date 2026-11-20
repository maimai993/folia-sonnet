// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateThemeFromLyrics } from '@/services/gemini';

// 当前文件：**没填 Key 的用户也必须先问云端，问到了就直接用。**
//
// 云缓存这个开关默认打开，本来就是为他准备的 —— 他自己一个主题都生成不出来，
// 能撞上别人推上来的那份就是白赚。所以「先拉一次云端」这一步不能只在
// 「有 Key」那两条路上生效，走部署端点那条路同样得先问。
//
// 这里钉的是请求顺序：缓存接口必须在生成接口之前被请求过；命中了就别再生成。

const state = vi.hoisted(() => ({
  hit: true,
  requested: [] as string[],
  /*
   * 形状合法的主题 —— `normalizeTheme` 要 `backgroundColor` 与 `primaryColor`
   * 都是字符串才认，随便给个 `{ name }` 会被判成脏数据、当成没命中。
   */
  shapeTheme: (name: string) => ({
    name,
    backgroundColor: '#101014',
    primaryColor: '#f4f4f6',
    secondaryColor: '#9aa3b2',
    accentColor: '#8b5cf6',
  }),
}));

/*
 * 一条**会被采信**的云端条目（issue C6）：客户端复算 `payloadDigest`，绑的是
 * `[verifyKey, kind, key, writer, payloadJson]`。这里照同一套规则算 —— 否则缓存永远
 * 被判成没命中，这一整套「缓存优先」的用例就全成了假绿。
 */
const signedEntry = async (kind: string, key: string, payload: unknown) => {
  const verifyKey = 'folia-cache-digest-v1';
  const writer = 'token:synthetic';
  const text = JSON.stringify([verifyKey, kind, key, writer, JSON.stringify(payload)]);
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const payloadDigest = Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return { payload, writer, payloadDigest, verifyKey };
};

vi.mock('@/services/aiNativeFetch', () => ({
  createAiFetch: () => async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    state.requested.push(`${method} ${url}`);
    /*
     * 摘要要按**真实地址里的 kind 与 key** 算：客户端拿到的 key 就是 URL 最后那一段。
     * 算错了会被当成「内容被挪过」而丢掉，于是这条桩就白设了。
     */
    const segments = url.split('?')[0].split('/').filter(Boolean);
    const key = segments[segments.length - 1] ?? '';
    const kind = segments[segments.length - 2] ?? 'theme';
    const payload = {
      theme: {
        light: state.shapeTheme('cached-light'),
        dark: state.shapeTheme('cached-dark'),
      },
    };
    const entry = await signedEntry(kind, key, payload);
    /* 只有缓存拉取走这里；命中与否由用例决定。 */
    return {
      ok: true,
      status: 200,
      json: async () => (state.hit ? { hit: true, entry } : { hit: false }),
    } as unknown as Response;
  },
}));

/*
 * 不要用 `await import('@/services/gemini')` 把加载拖进用例里 —— 那个模块连着一大串
 * 依赖，冷启动要将近两秒，全量并行跑时会被 CPU 争抢顶过默认的 5 秒用例超时，
 * 变成一条跟代码无关的假失败。静态 import 让这份开销算进文件收集，不占用例时间。
 *
 * `vi.mock('@/services/aiNativeFetch')` 由 vitest 提到 import 之前，所以这里拿到的是
 * 打过桩的那个工厂。
 */
const TIMEOUT_MS = 20000;

beforeEach(async () => {
    /*
     * 「禁用 AI 推理」总闸默认打开（#401）。这里验的是缓存与生成的先后关系，
     * 不是闸门本身，所以先把推理打开。
     */
    const { useAiInferenceSettingsStore } = await import('@/stores/useAiInferenceSettingsStore');
    useAiInferenceSettingsStore.getState().setAiInferenceDisabled(false);
  state.requested.length = 0;
  state.hit = true;
  /*
   * 明确选一个「要填 Key 的服务商，但没填」。
   *
   * 默认服务商现在是免费渠道（foliawork），它自带凭据、永远可用，于是「没填 Key 的用户」
   * 会走本机直连那条路，而本文件验的是**部署端点**那条 —— 只有「选了要填 Key 的服务商又
   * 没填」才会落到它上面。不写死这一行，这个文件就不再验它想验的东西。
   */
  localStorage.setItem('foliaAiProviderSettings', JSON.stringify({ provider: 'gemini', geminiApiKey: '' }));
  /*
   * 云缓存配置（issue H34 之后是 v3，不再有内置地址）+ 一把写入令牌。
   *
   * 令牌是必须的：C6 之后没有令牌就是只读，`pushAiCloudCache` 会直接返回 false，
   * 「最后 PUT 回传」那条断言就永远不成立。谁能写在服务端那一侧钉。
   */
  localStorage.setItem('foliaCloudSettings.v3', JSON.stringify({
    enabled: true,
    baseUrl: 'https://cloud.test',
    writeToken: 'synthetic-write-token',
  }));
  /*
   * 部署端点那条路用的是全局 fetch，地址还是相对路径（`/api/...`）。
   * 浏览器里没问题，node 下 fetch 解析不了相对 URL，所以一并 stub。
   */
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    state.requested.push(`${(init?.method || 'GET').toUpperCase()} ${String(input)}`);
    return {
      ok: true,
      status: 200,
      json: async () => ({ light: { name: 'generated-light' }, dark: { name: 'generated-dark' } }),
    } as unknown as Response;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AI 主题：无密钥时先问云端', () => {
  it('缓存命中就不再去调生成接口', async () => {
    const result = await generateThemeFromLyrics('一句歌词\n又一句歌词', {
      songTitle: '测试曲',
      artist: '测试歌手',
      trigger: 'auto',
    });

    expect(result.source).toBe('cloud');
    expect(result.theme.light.name).toBe('cached-light');
    // 只发出过一次请求：问缓存。没有去 POST generate-theme。
    expect(state.requested).toHaveLength(1);
    expect(state.requested[0]).toContain('/api/ai-cache/stage/');
    expect(state.requested.some((entry) => entry.includes('generate-theme'))).toBe(false);
  }, TIMEOUT_MS);

  it('缓存没命中才去找服务器生成', async () => {
    state.hit = false;
    const result = await generateThemeFromLyrics('另一句歌词\n再一句歌词', {
      songTitle: '测试曲 2',
      artist: '测试歌手',
      trigger: 'auto',
    });

    expect(result.source).toBe('ai');
    // 顺序：先 GET 缓存（没中），再 POST 生成，最后 PUT 回传。
    expect(state.requested[0]).toContain('/api/ai-cache/');
    expect(state.requested.some((entry) => entry.includes('generate-theme'))).toBe(true);
    expect(state.requested.some((entry) => entry.startsWith('PUT '))).toBe(true);
  }, TIMEOUT_MS);
});
