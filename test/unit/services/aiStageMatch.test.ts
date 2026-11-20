// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/services/aiStageMatch.test.ts
// 面板那颗「AI 主题同步」按下之后走的那条路：**匹配一次，绝不生成**。
//
// 以前它查的是 kind='theme'（按歌名 + 歌手算键），而主题真正存的地方是舞台那条链路
// （kind='stage'，键 = 歌词正文 + 设置）—— 两个键根本不是一回事。于是切歌时刚从云端
// 匹配到主题，按下这颗却报「云端还没有这首的主题」，看着就是缓存坏了。
//
// matchStage 与主题生成共用 `buildStageContext`，键因此是同一个；它只问云端，
// 没有就返回 null —— 没配 Key 的人按下去只是「没命中」，不会撞一次「AI 不可用」。

const { handlers } = vi.hoisted(() => ({
  handlers: {
    fetch: null as null | ((url: string, init?: RequestInit) => Promise<Response>),
    cloudEnabled: true,
  },
}));

vi.mock('@/services/foliaCloud', () => ({
  isFoliaCloudCacheEnabled: () => handlers.cloudEnabled,
  resolveCloudApiUrl: (path: string) => `https://cloud.test/api/${path}`,
  /* 写入准入（issue C6）：这套用例不断言「谁能写」，给个令牌让推送照常走完。 */
  resolveCloudWriteToken: () => 'synthetic-write-token',
  CLOUD_WRITE_TOKEN_HEADER: 'X-Folia-Cache-Token',
  DEFAULT_CLOUD_BASE_URL: 'https://cloud.test',
}));

vi.mock('@/services/aiNativeFetch', () => ({
  createAiFetch: () => (input: RequestInfo | URL, init?: RequestInit) =>
    (handlers.fetch as NonNullable<typeof handlers.fetch>)(String(input), init),
  fetchAiCacheViaNative: async () => null,
}));

vi.mock('@/services/aiCompletion', () => ({
  describeAiTarget: () => null,
}));

const { matchStage, requestStage } = await import('@/services/aiStage');

/* 只要够认出「这是一份主题」就行：配色完整性是 themeSanitizer 那一层的事。 */
const dualTheme = {
  light: { name: '浅', backgroundColor: '#111111', primaryColor: '#222222' },
  dark: { name: '深', backgroundColor: '#000000', primaryColor: '#eeeeee' },
} as unknown as import('@/types').DualTheme;

const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => body }) as unknown as Response;

/*
 * 一条**会被采信**的云端条目（issue C6）：客户端会复算 `payloadDigest`，摘要绑的是
 * `[verifyKey, kind, key, writer, payloadJson]`。这里照同一套规则算。
 */
const VERIFY_KEY = 'folia-cache-digest-v1';
const hit = async (kind: 'stage' | 'theme', key: string, body: unknown) => {
  const writer = 'token:synthetic';
  const text = JSON.stringify([VERIFY_KEY, kind, key, writer, JSON.stringify(body)]);
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const payloadDigest = Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return json({ hit: true, entry: { payload: body, writer, payloadDigest, verifyKey: VERIFY_KEY } });
};

/** 每首歌用各自的一段歌词：missCache 会把「刚问过没有」记 5 分钟，共用会互相挡掉。 */
const lyricsOf = {
  hit: [{ fullText: '故事的小黄花' }, { fullText: '从出生那年就飘着' }],
  miss: [{ fullText: '完全不同的另一首歌' }],
  half: [{ fullText: '只有动画决策没有主题' }],
  sameKey: [{ fullText: '刮风这天我试过握着你手' }],
};

const baseRequest = (lines: { fullText: string }[]) => ({
  song: { title: '晴天', artist: '周杰伦', album: null as string | null },
  lines,
  songTitle: '晴天',
  require: 'theme' as const,
});

const pullKeyOf = (url: string): string => (url.includes('/ai-cache/stage/') ? (url.split('/').pop() ?? '') : '');

/*
 * 云端那条答案存在哪个键上。
 *
 * 有歌词可判时拉缓存**不读精确键**（精确键里可能躺着别首歌的答案），只能走「按歌名捞候选
 * → 本机拿高亮词判 → 按候选的键取回」，所以每个用例都得先给出一条**词全在歌词里**的候选。
 */
const REMOTE_KEY = 'a'.repeat(32);
const candidatesFor = (words: string[]) => json({ ok: true, candidates: [{ key: REMOTE_KEY, words }] });

beforeEach(async () => {
    /*
     * 「禁用 AI 推理」总闸默认打开（#401）。这里验的是缓存与生成的先后关系，
     * 不是闸门本身，所以先把推理打开。
     */
    const { useAiInferenceSettingsStore } = await import('@/stores/useAiInferenceSettingsStore');
    useAiInferenceSettingsStore.getState().setAiInferenceDisabled(false);
  handlers.fetch = null;
  handlers.cloudEnabled = true;
});

describe('matchStage', () => {
  it('命中就把主题交回来，并且一次都不去生成', async () => {
    handlers.fetch = async (url) => {
      if (url.includes('/ai-cache/resolve')) return candidatesFor(['小黄花']);
      if (url.includes(REMOTE_KEY)) {
        return await hit('stage', REMOTE_KEY, { theme: dualTheme, decision: { mode: 'flow', reason: 'r', params: {} } });
      }
      return json({ hit: false }, false);
    };

    const result = await matchStage({
      ...baseRequest(lyricsOf.hit),
      /* 生成那一支一旦被走到就会炸 —— 它根本不该被走到。 */
      generate: async () => { throw new Error('同步按钮不生成'); },
    });

    expect(result?.theme?.light.backgroundColor).toBe('#111111');
    expect(result?.source).toBe('cloud');
  });

  /* 云端没有就是没有 —— 不生成、不报错、不瞎猜，交给调用方去提示。 */
  it('没命中就返回 null，同样不去生成', async () => {
    handlers.fetch = async (url) => (
      url.includes('/ai-cache/resolve') ? json({ ok: true, candidates: [] }) : json({ hit: false }, false)
    );

    const result = await matchStage({
      ...baseRequest(lyricsOf.miss),
      generate: async () => { throw new Error('同步按钮不生成'); },
    });

    expect(result).toBeNull();
  });

  /*
   * 缺了这次要的那一半就跟没有一样：只要主题的那条链路，拿到一条只有动画决策的
   * 条目不能算命中（否则界面上什么都没变，却弹了「已从云端拿到」）。
   */
  it('缺了要用的那一半不算命中', async () => {
    handlers.fetch = async (url) => {
      if (url.includes('/ai-cache/resolve')) return candidatesFor(['动画决策']);
      if (url.includes(REMOTE_KEY)) {
        return await hit('stage', REMOTE_KEY, { decision: { mode: 'flow', reason: 'r', params: {} } });
      }
      return json({ hit: false }, false);
    };

    expect(await matchStage(baseRequest(lyricsOf.half))).toBeNull();
  });

  it('云服务没开就直接不去问', async () => {
    let asked = 0;
    handlers.fetch = async () => {
      asked += 1;
      return json({ hit: false }, false);
    };
    handlers.cloudEnabled = false;

    expect(await matchStage(baseRequest(lyricsOf.hit))).toBeNull();
    expect(asked).toBe(0);
  });

  /*
   * 这一条是整件事的关键：**同步用的键必须与生成用的键是同一个**。
   * 生成链路把指纹写在 ctx 上，同步链路把键写在请求 URL 上，两边对得上，
   * 「刚才明明匹配上了」之后按同步才不会再报「云端还没有」。
   */
  it('用的键跟主题生成那条链路是同一个', async () => {
    let generatedFingerprint = '';
    handlers.fetch = async (_url, init) => (
      init?.method === 'PUT' ? json({ ok: true, stored: true }) : json({ hit: false }, false)
    );
    await requestStage({
      ...baseRequest(lyricsOf.sameKey),
      generate: async (ctx) => {
        generatedFingerprint = ctx.fingerprint;
        return { theme: dualTheme };
      },
    });
    expect(generatedFingerprint).not.toBe('');

    /*
     * 键从**回填那一次 PUT** 上读：有歌词时 pull 根本不碰精确键（见 REMOTE_KEY 那条注释），
     * 而回填写的正是 `ctx.fingerprint` —— 同一个值，一样对得上。
     */
    let matchedKey = '';
    handlers.fetch = async (url, init) => {
      if (init?.method === 'PUT') {
        matchedKey = pullKeyOf(url);
        return json({ ok: true, stored: true });
      }
      if (url.includes('/ai-cache/resolve')) return candidatesFor(['刮风', '握着']);
      if (url.includes(REMOTE_KEY)) return await hit('stage', REMOTE_KEY, { theme: dualTheme });
      return json({ hit: false }, false);
    };
    await matchStage(baseRequest(lyricsOf.sameKey));

    expect(matchedKey).toBe(generatedFingerprint);
  });
});
