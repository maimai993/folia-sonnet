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

vi.mock('@/services/aiNativeFetch', () => ({
  createAiFetch: () => async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    state.requested.push(`${method} ${url}`);
    /* 只有缓存拉取走这里；命中与否由用例决定。 */
    return {
      ok: true,
      status: 200,
      json: async () => (state.hit
        ? {
          hit: true,
          entry: {
            payload: {
              theme: {
                light: state.shapeTheme('cached-light'),
                dark: state.shapeTheme('cached-dark'),
              },
            },
          },
        }
        : { hit: false }),
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

beforeEach(() => {
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
  // 云缓存默认就是开的；这里写一份只是免得受别的用例污染。
  localStorage.setItem('foliaCloudSettings.v2', JSON.stringify({
    enabled: true,
    baseUrl: 'https://cloud.test',
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
