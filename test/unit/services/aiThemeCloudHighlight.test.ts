// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/services/aiThemeCloudHighlight.test.ts
// ⭐ **云端命中不止一条路**：舞台那条（kind='stage'）判住了不算完，主题这条
// （`services/aiThemeCloud.ts`）也得判，否则脏条目换个入口照旧进来。
//
// 用户报的就是这个：舞台链路改成「高亮词 100% 才认」之后，他那边**还是一直能匹配上**
// 那一例。原因在这两条上：
//  · `pullCachedThemeByKey` 从「AI 主题」那一屏点播放进来，按**已知键直取** —— 一道判定
//    都不走；
//  · `pullAiThemeFromCloud` 只给了歌名、没给歌词 → 无从判 → 直接信精确键 / 按歌名取回
//    的那一档。
//
// 两条纪律同样钉在这里：
//  · **没歌词 = 没得判**，照旧放行（不因为拿不到歌词就把别人的成果判死）；
//  · **没标高亮词 = 没凭据**，也照旧放行 —— 老主题常常一个 wordColors 都没有。
//    只有**标了词却又对不上**才是真脏。

const { handlers } = vi.hoisted(() => ({
  handlers: {
    fetch: null as null | ((url: string, init?: RequestInit) => Promise<Response>),
  },
}));

vi.mock('@/services/foliaCloud', () => ({
  isFoliaCloudCacheEnabled: () => true,
  resolveCloudApiUrl: (path: string) => `https://cloud.test/api/${path}`,
  /* 写入准入（issue C6）：这套用例验的是高亮词判定，令牌只要「有」。 */
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

const { pullAiThemeFromCloud, pullCachedThemeByKey } = await import('@/services/aiThemeCloud');

const KEY = 'a'.repeat(32);
const OTHER_KEY = 'b'.repeat(32);

const themeWith = (words: string[]) => ({
  name: '云端的主题',
  light: {
    name: '浅',
    backgroundColor: '#f5f0e8',
    primaryColor: '#c5b3a3',
    accentColor: '#8e7d6f',
    secondaryColor: '#6b635a',
    fontStyle: 'sans' as const,
    wordColors: words.map(word => ({ word, color: '#ffcc00' })),
  },
  dark: {
    name: '深',
    backgroundColor: '#101010',
    primaryColor: '#c5b3a3',
    accentColor: '#8e7d6f',
    secondaryColor: '#6b635a',
    fontStyle: 'sans' as const,
    wordColors: words.map(word => ({ word, color: '#ffcc00' })),
  },
});

const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => body }) as unknown as Response;

/*
 * 一条**会被采信**的云端主题条目（issue C6）。客户端复算 `payloadDigest`，绑的是
 * `[verifyKey, kind, key, writer, payloadJson]`；这里照同一套规则算。
 */
const VERIFY_KEY = 'folia-cache-digest-v1';
const hit = async (key: string, payload: unknown, kind: 'theme' | 'stage' = 'theme') => {
  const writer = 'token:synthetic';
  const text = JSON.stringify([VERIFY_KEY, kind, key, writer, JSON.stringify(payload)]);
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const payloadDigest = Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return json({ hit: true, entry: { payload, writer, payloadDigest, verifyKey: VERIFY_KEY } });
};

/** 用户报的那一例：标了 `留住`，可这首的歌词里根本没有「留住」。 */
const LYRIC = '可那些与我无关\n麻烦总缠着我\n什么也不想说\n让我重新认识一个更好的你\n因为你陪着我';

beforeEach(() => {
  handlers.fetch = null;
});

describe('按已知键直取的那一条（AI 主题页点播放）', () => {
  it('高亮词在这首的歌词里凑不齐就不要', async () => {
    handlers.fetch = async (url) => (
      url.includes(KEY) ? await hit(KEY, themeWith(['留住', '我', '什么', '把', '你'])) : json({ hit: false }, false)
    );

    expect(await pullCachedThemeByKey(KEY, LYRIC)).toBeNull();
  });

  /* 对照：同一份 payload，歌词对得上就该照旧拿回来 —— 上面那条 null 才确实是被判住的。 */
  it('高亮词都在就照旧拿回来', async () => {
    handlers.fetch = async (url) => (
      url.includes(KEY) ? await hit(KEY, themeWith(['麻烦', '重新认识'])) : json({ hit: false }, false)
    );

    const theme = await pullCachedThemeByKey(KEY, LYRIC);
    expect(theme).not.toBeNull();
    expect(theme?.light.backgroundColor).toBe('#f5f0e8');
  });

  /* 没歌词 = 没得判：这时候判死等于把没 Key 的人唯一的来源掐了。 */
  it('拿不到歌词时照旧放行', async () => {
    handlers.fetch = async (url) => (
      url.includes(KEY) ? await hit(KEY, themeWith(['留住'])) : json({ hit: false }, false)
    );

    expect(await pullCachedThemeByKey(KEY)).not.toBeNull();
  });

  /* 一个高亮词都没标 = 没凭据，不是「判出来不对」。 */
  it('没标高亮词的老主题照样放行', async () => {
    handlers.fetch = async (url) => (
      url.includes(KEY) ? await hit(KEY, themeWith([])) : json({ hit: false }, false)
    );

    expect(await pullCachedThemeByKey(KEY, LYRIC)).not.toBeNull();
  });

  /* 主题也可能藏在 stage 那半里（payload.theme）：那条同样要判。 */
  it('落在 stage 那半里的主题一样要判', async () => {
    handlers.fetch = async (url) => {
      if (url.includes(KEY) && url.includes('/stage/')) {
        return await hit(KEY, { theme: themeWith(['留住']) }, 'stage');
      }
      return json({ hit: false }, false);
    };

    expect(await pullCachedThemeByKey(KEY, LYRIC)).toBeNull();
  });
});

describe('按歌名 + 歌手拉的那一条', () => {
  /* 这一档是 'forced'（没歌词可判时取服务端最靠前的那条）—— 没验证过，有歌词必须再过一遍。 */
  it('按歌名取回来的也要过高亮词', async () => {
    handlers.fetch = async (url) => {
      if (url.includes('/ai-cache/resolve')) {
        return json({ ok: true, candidates: [{ key: OTHER_KEY, words: ['留住', '我', '什么', '把', '你'] }] });
      }
      if (url.includes(OTHER_KEY)) return await hit(OTHER_KEY, themeWith(['留住', '我']));
      return json({ hit: false }, false);
    };

    expect(await pullAiThemeFromCloud({ title: '风清云净', artist: '郑海音' }, LYRIC)).toBeNull();
  });

  /*
   * 换一个歌手：键是「歌名 + 歌手」的 MD5，而**判不过会记 5 分钟 miss** —— 跟上一条用例
   * 用同一个键的话，这条会被那条记下的 miss 直接挡掉，看起来通过其实根本没走到判定。
   */
  it('对得上就照旧拿回来', async () => {
    handlers.fetch = async (url) => {
      if (url.includes('/ai-cache/resolve')) {
        return json({ ok: true, candidates: [{ key: OTHER_KEY, words: ['麻烦', '重新认识'] }] });
      }
      if (url.includes(OTHER_KEY)) return await hit(OTHER_KEY, themeWith(['麻烦', '重新认识']));
      return json({ hit: false }, false);
    };

    expect(await pullAiThemeFromCloud({ title: '风清云净', artist: '另一个版本' }, LYRIC)).not.toBeNull();
  });
});
