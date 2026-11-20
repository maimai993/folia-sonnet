// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/services/aiCloudCache.test.ts
// 精确键没命中时，还能不能靠**歌名 + 内容合规**把库里那条答案捞出来。
//
// 键是「歌词 + policy」的 MD5，于是同一首歌换个版本的歌词就是另一个键 —— 翻唱、现场、
// 平台之间同一首歌的 LRC 本来就不一样。只赌精确键的话，「库里明明躺着答案却取不到」
// 是常态，这也是「缓存命中率还是有问题」的来处。
//
// 第二次机会**不看哈希，看内容**：候选条目标的高亮词都在你手上这段歌词里，那条答案
// 就是照着这首歌做的。判定留在本机（服务端只回高亮词），歌词正文因此不用上传。
//
// ⭐ 高亮词是**门槛**，不是「挑的依据」：必须 100% 全在场，少一个就当这条答案是照着
// 别首歌做的。以前按比例放过（≥80%）、再后来「最多缺一个」、再后来「兜底挑最像的那条」，
// 一轮比一轮宽松的后果是近亲之间互相顶替 —— 用户报「明明是另一首歌，居然匹配上了」，
// 而那份错答案还会回填到精确键上，错一次就一直错下去。
//
// 于是有歌词可判时**连精确键都不读**：键对了不代表内容对（早年的强制匹配把别首的答案
// 写过来了），高亮词才是准的。精确键只留给「没得判」那一档（主题按歌名+歌手存的那一路、
// 纯音乐）。

const { handlers } = vi.hoisted(() => ({
  handlers: {
    fetch: null as null | ((url: string, init?: RequestInit) => Promise<Response>),
  },
}));

/*
 * 写令牌给一个固定值：这一套用例验的是「拉回来能不能用」，不是「谁能写」。
 * 没有它 `pushAiCloudCache` 会认定本机只读而直接返回 false，那些「推上去」的用例就全黄了。
 * 谁能写的准入在服务端那一侧钉（test/unit/sync-server/aiCacheWriteAdmission.test.ts）。
 */
vi.mock('@/services/foliaCloud', () => ({
  isFoliaCloudCacheEnabled: () => true,
  resolveCloudApiUrl: (path: string) => `https://cloud.test/api/${path}`,
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

const { highlightWordsPresent, pullAiCloudCache, withAiCloudCache } = await import('@/services/aiCloudCache');

const KEY_A = 'a'.repeat(32);
const KEY_B = 'b'.repeat(32);
/*
 * 每个用例用自己的键：`missCache` 会把「刚问过没有」记 5 分钟，共用一把键的话后面
 * 的用例会被 `wasRecentMiss` 当场挡掉，看起来通过其实根本没走到兜底逻辑。
 */
const KEY_C = 'c'.repeat(32);
const KEY_D = 'd'.repeat(32);
const KEY_E = 'e'.repeat(32);
const KEY_F = 'f'.repeat(32);
const KEY_G = 'a1b2c3d4'.repeat(4);
const KEY_H = 'd4e5f6a7'.repeat(4);
/* 每个用例用自己的键：missCache 会把「刚问过没有」记 5 分钟，复用会当场被挡掉。 */
const KEY_I = 'e6f7a8b9'.repeat(4);
const KEY_PUSHED = 'a2b3c4d5'.repeat(4);
const KEY_J = 'a7b8c9d0'.repeat(4);
const KEY_K = 'b1c2d3e4'.repeat(4);
const KEY_L = 'c5d6e7f8'.repeat(4);
const KEY_J2 = '0f1e2d3c'.repeat(4);
const KEY_M = '1a2b3c4d'.repeat(4);
const KEY_N = '2b3c4d5e'.repeat(4);

const payload = {
  theme: {
    light: { backgroundColor: '#111111', primaryColor: '#222222', wordColors: [{ word: '小黄花', color: '#ffcc00' }] },
    dark: { backgroundColor: '#000000', primaryColor: '#eeeeee', wordColors: [{ word: '小黄花', color: '#ffcc00' }] },
  },
  decision: { mode: 'flow', reason: 'r', params: {} },
};

const secondPayload = {
  ...payload,
  decision: { mode: 'bloom', reason: 'r2', params: {} },
};

const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => body }) as unknown as Response;

/*
 * 一条**能被采信**的云端条目（issue C6）。
 *
 * 客户端现在会复算 `payloadDigest`：摘要对不上（或干脆没有）就当这条不存在。所以这里照着
 * `sync-server/src/aiCacheDigest.ts` 的规则算一份 —— `[verifyKey, kind, key, writer, payloadJson]`
 * 的 SHA-256。这是**故意**把算法在测试里重写一遍而不是去 import 服务端模块：两边真的对不上
 * 时，这里会红，正好提醒「客户端和服务端算的不是一回事」。
 *
 * 各用例仍然可以用第三参覆盖字段，例如验「摘要不对就当没有」时传一个假摘要。
 */
const WRITER = 'token:synthetic';
const verifyKey = 'folia-cache-digest-v1';

const sha256Hex = async (text: string): Promise<string> => {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const entryFor = async (
  kind: 'stage' | 'theme',
  key: string,
  body: unknown,
  overrides: Record<string, unknown> = {},
) => {
  const writer = typeof overrides.writer === 'string' ? overrides.writer : WRITER;
  const payloadJson = JSON.stringify(body);
  const payloadDigest = await sha256Hex(JSON.stringify([verifyKey, kind, key, writer, payloadJson]));
  return { payload: body, writer, payloadDigest, verifyKey, ...overrides };
};

/** `{ hit: true, entry }`，摘要按真实规则算好 —— 绝大多数「云端有答案」的用例用这个。 */
const hit = async (kind: 'stage' | 'theme', key: string, body: unknown, overrides: Record<string, unknown> = {}) => (
  json({ hit: true, entry: await entryFor(kind, key, body, overrides) })
);

beforeEach(() => {
  handlers.fetch = null;
});

describe('highlightWordsPresent', () => {
  const lyric = '故事的小黄花\n童年的荡秋千';

  it('is satisfied when every marked word is in the lyric', () => {
    expect(highlightWordsPresent(['小黄花', '荡秋千'], lyric)).toBe(true);
  });

  /* LRC 里多一个空格不该判成「这不是同一个词」。 */
  it('ignores whitespace and case', () => {
    expect(highlightWordsPresent(['小 黄 花', '故事'], '故事的小黄花')).toBe(true);
    expect(highlightWordsPresent(['Rainbow', 'here'], 'some RAINBOW here')).toBe(true);
  });

  /*
   * 词少照样能合规（全中即可）—— 但**不按比例放宽**。
   *
   * ⚠️ 反过来（「少于 N 个词一律判不合规」）试过，上机是**所有歌**的高亮词显示都错：
   * 模型常常只挑一两个词，一刀切之后十几条近亲全部不合规，只好走「强制拿一条」，
   * 拿回来的高亮词完全不对。词少的答案不许一刀切，只能要求它全中。
   */
  it('still takes a short list when every one of its words is there', () => {
    expect(highlightWordsPresent(['小黄花'], lyric)).toBe(true);
    expect(highlightWordsPresent(['故事'], '故事的小黄花')).toBe(true);
  });

  /*
   * 差一个就不行，**不管一共挑了几个**。
   *
   * 中间那版是「到了五个词才给缺一个的宽容」，照样出事：用户报的那例证据词只有 5 个、
   * 命中 3 个，看着离「缺一个」不远，其实另外两个（留住 / 把）根本不在这首的歌词里 ——
   * 它就是另一首歌的答案。现在一律 100%。
   */
  it('lets no word go missing, however many there are', () => {
    expect(highlightWordsPresent(['故事', '小黄花', '童年', '不在'], lyric)).toBe(false);
    expect(highlightWordsPresent(['故事', '小黄花', '童年', '荡秋千', '不在歌词里'], lyric)).toBe(false);
    expect(highlightWordsPresent(['故事', '小黄花', '童年', '不在', '也不在'], lyric)).toBe(false);
    /* 全在的那一份照旧合规。 */
    expect(highlightWordsPresent(['故事', '小黄花', '童年', '荡秋千'], lyric)).toBe(true);
  });

  it('is not satisfied when a word is missing', () => {
    expect(highlightWordsPresent(['小黄花', '根本不在这首歌里'], lyric)).toBe(false);
  });

  /*
   * 词多**不再**等于可以多缺几个。
   *
   * 最早按覆盖率放行（≥80%）：10 个词缺 2 个、20 个词缺 4 个照样过。而同一首歌的翻唱 /
   * 现场 / 各平台 LRC 本来就共享大半的高亮词，于是拿一首近亲的歌词去撞另一首的答案也
   * 能撞上八成 —— 用户报的正是「明明是另一首歌，居然匹配上了」。
   *
   * 代价是同一首歌的两份 LRC 差一个词（一句口白、翻译行不同）也判不上 —— 用户拍板要的
   * 是准，不是全：宁可自己重生成一次。
   */
  it('counts the words instead of taking a percentage', () => {
    const many = '甲乙丙丁戊己庚辛壬癸';
    /* 用双字：单字在任何歌里都能撞上，不当证据（见下面那条用例）。 */
    const words = ['甲乙', '丙丁', '戊己', '庚辛', '壬癸'];

    expect(highlightWordsPresent(words, many)).toBe(true);
    /* 缺 1 个：以前「到了五个词可以缺一个」放它过，现在不行。 */
    expect(highlightWordsPresent([...words.slice(0, 4), '不在'], many)).toBe(false);
    expect(highlightWordsPresent([...words.slice(0, 3), '不在', '也不在'], many)).toBe(false);
  });

  /*
   * 单字不算证据：「我 / 你 / 把」在几乎每一首中文歌里都有，它们出现在歌词里说明不了
   * 这条答案是照着哪首歌词做的。
   */
  it('does not count single characters as evidence', () => {
    const lyric2 = '我你他把什么都在这里面';
    expect(highlightWordsPresent(['我', '你', '把'], lyric2)).toBe(false);
    /* 换成从歌词里挑出来的实词，同样三个词就合规了。 */
    expect(highlightWordsPresent(['绚烂', '闪躲', '告别'], '世界变得更绚烂\n所有告别\n无论我怎么闪躲')).toBe(true);
  });

  /*
   * 用户报的那个真例子：候选的高亮词是 留住 / 我 / 什么 / 把 / 你，
   * 而这首的歌词里「留住」和「把」根本不存在 —— 覆盖率 3/5 全靠三个虚词撑着。
   * 去掉虚词与单字之后证据只剩「留住」，一个都没命中，不该算匹配。
   */
  it('does not take an answer whose only evidence is missing from the lyric', () => {
    const lyric2 = [
      '可那些与我无关',
      '麻烦总缠着我',
      '什么也不想说',
      '让我重新认识一个更好的你',
      '因为你陪着我',
    ].join('\n');

    expect(highlightWordsPresent(['留住', '我', '什么', '把', '你'], lyric2)).toBe(false);
    /* 光是「我 / 什么 / 你」这三个虚词命中，一点都不算证据。 */
    expect(highlightWordsPresent(['我', '什么', '你'], lyric2)).toBe(false);
    /* 同一段歌词，换成真的从里面挑出来的词就合规。 */
    expect(highlightWordsPresent(['麻烦', '重新认识', '好天气'], lyric2 + '\n就像大雨过后的好天气')).toBe(true);
  });

  /*
   * 一个高亮词都没有时不算合规 —— 反过来实现等于「随便一条答案都能算命中」，
   * 会把别人给别的歌做的主题套到你这首上。
   */
  it('needs at least one word to go on', () => {
    expect(highlightWordsPresent([], lyric)).toBe(false);
    expect(highlightWordsPresent(['小黄花'], '')).toBe(false);
  });
});

describe('pullAiCloudCache 的第二次机会', () => {
  it('takes a title match whose highlight words are all in the lyric', async () => {
    const seen: string[] = [];
    handlers.fetch = async (url) => {
      seen.push(url);
      if (url.includes('/ai-cache/resolve')) {
        return json({ ok: true, candidates: [{ key: KEY_A, words: ['小黄花'] }] });
      }
      if (url.includes(KEY_A)) return await hit('stage', KEY_A, payload);
      return json({ hit: false }, false);
    };

    const result = await pullAiCloudCache('stage', KEY_B, {
      songTitle: '晴天',
      lyricText: '故事的小黄花\n从出生那年就飘着',
    });

    expect(result.status).toBe('hit');
    if (result.status === 'hit') {
      expect(result.matched).toBe('words');
      expect(result!.sourceKey).toBe(KEY_A);
      expect(result.payload).toEqual(payload);
    }
    /*
     * 顺带钉住顺序：**根本不问精确键**，一上来就是 resolve，然后按候选的键取回。
     * 有歌词可判时精确键里躺着什么不作数 —— 它可能就是别首歌的答案（见文件头）。
     */
    expect(seen[0]).toContain('/ai-cache/resolve');
    expect(seen[1]).toContain(KEY_A);
    expect(seen.some((url) => url.includes(KEY_B))).toBe(false);
  });

  /*
   * 一条证据都对不上时**不再**强制匹配：那是「判出来不像」，不是「没得判」。
   *
   * 以前是「反正挑最像的那条」,于是另一首近亲的答案会被顶上来，还回填到这首的精确键上
   * —— 用户报的就是这个（高亮词 留住/我/什么/把/你 里前两个根本不在歌词里）。
   * 现在该老实说「云端没有」，让本机照这首重新生成。
   */
  it('gives up instead of forcing a match when no candidate has any evidence', async () => {
    /*
     * 候选那一键**是给了内容的** —— 这一条要验的是判定本身，不是「接口没给」。
     * 少了 `url.includes(KEY_A)` 这一支，测试会因为别的原因通过，把实现改坏也不红。
     */
    handlers.fetch = async (url) => {
      if (url.includes('/ai-cache/resolve')) {
        return json({ ok: true, candidates: [{ key: KEY_A, words: ['小黄花'] }] });
      }
      if (url.includes(KEY_A)) return await hit('stage', KEY_A, payload);
      return json({ hit: false }, false);
    };

    const result = await pullAiCloudCache('stage', KEY_C, {
      songTitle: '晴天',
      lyricText: '完全不同的一首歌',
    });

    expect(result.status).toBe('miss');
  });

  /* 虚词凑出来的「命中」同样不算证据：整个候选里没有一个实词对得上。 */
  it('gives up when the only words that match are filler', async () => {
    handlers.fetch = async (url) => {
      if (url.includes('/ai-cache/resolve')) {
        return json({ ok: true, candidates: [{ key: KEY_A, words: ['留住', '我', '什么', '把', '你'] }] });
      }
      if (url.includes(KEY_A)) return await hit('stage', KEY_A, payload);
      return json({ hit: false }, false);
    };

    const result = await pullAiCloudCache('stage', KEY_K, {
      songTitle: '风清云净',
      lyricText: '可那些与我无关\n麻烦总缠着我\n什么也不想说\n让我重新认识一个更好的你',
    });

    expect(result.status).toBe('miss');
  });

  /*
   * 一条都不达标时**放弃**，不再「挑最像的那条」。
   *
   * 中间那版先随机挑、后来改成挑覆盖率最高的 —— 两版都错在把「没有是非」当成了「谁更像」：
   * 覆盖率 2/3 那条不是「有点像这首的答案」，它就是**另一首歌的答案**。挑它，歌词上该亮的
   * 一个都亮不起来，而它还会被回填到这首的精确键上，错一次就一直错下去。
   */
  it('gives up when no candidate is a full match', async () => {
    /* 三条候选**都给得出内容** —— 这一条要验的是判定，不是「接口没给」。 */
    const seen: string[] = [];
    handlers.fetch = async (url) => {
      seen.push(url);
      if (url.includes('/ai-cache/resolve')) {
        return json({
          ok: true,
          candidates: [
            { key: KEY_A, words: ['完全不在', '也不在'] },                  // 0/2
            { key: KEY_H, words: ['小黄花', '不在歌词里'] },                 // 1/2
            { key: KEY_B, words: ['小黄花', '荡秋千', '不在这段里'] },       // 2/3 —— 最像的那条
          ],
        });
      }
      if (url.includes(KEY_A) || url.includes(KEY_H) || url.includes(KEY_B)) {
        return await hit('stage', KEY_A, payload);
      }
      return json({ hit: false }, false);
    };

    const result = await pullAiCloudCache('stage', KEY_G, {
      songTitle: '晴天',
      lyricText: '故事的小黄花\n童年的荡秋千',
    });

    expect(result.status).toBe('miss');
    /* 连一条内容都不该去取 —— 判不过就是判不过。 */
    expect(seen.some((url) => url.includes(KEY_A) || url.includes(KEY_H) || url.includes(KEY_B))).toBe(false);
  });

  /*
   * 达标的那几条**一起比，取证据词最多的**。
   *
   * 全都 100% 在场时，词越多越不可能是巧合：只挑了「小黄花」一条，同名曲的翻唱也能撞上；
   * 挑了四条还一条不落，那基本就是照着同一份歌词做的。所以最靠前那条（服务端按更新时间
   * 排的）要让位给词最多的那条。
   */
  it('takes the candidate with the most evidence, not the first one', async () => {
    handlers.fetch = async (url) => {
      if (url.includes('/ai-cache/resolve')) {
        return json({
          ok: true,
          candidates: [
            { key: KEY_A, words: ['小黄花'] },                                  // 1 条证据
            { key: KEY_H, words: ['故事', '小黄花', '童年', '荡秋千'] },        // 4 条 —— 最可信那条
            { key: KEY_B, words: ['故事', '童年'] },                            // 2 条
          ],
        });
      }
      if (url.includes(KEY_A)) return await hit('stage', KEY_A, payload);
      if (url.includes(KEY_H)) return await hit('stage', KEY_H, secondPayload);
      if (url.includes(KEY_B)) return await hit('stage', KEY_A, payload);
      return json({ hit: false }, false);
    };

    const result = await pullAiCloudCache('stage', KEY_J2, {
      songTitle: '晴天',
      lyricText: '故事的小黄花\n童年的荡秋千',
    });

    expect(result.status).toBe('hit');
    if (result.status === 'hit') {
      expect(result.matched).toBe('words');
      expect(result!.sourceKey).toBe(KEY_H);
      expect(result.payload).toEqual(secondPayload);
    }
  });

  /*
   * 没验证过的不回填：写成精确键等于把一次猜测钉成永久事实 —— 下次、下下次，这首永远
   * 拿这份可能是别首歌的答案。
   *
   * 这一档现在只剩「没歌词可判」（主题按歌名+歌手存的那一路）：有歌词时判不过就是
   * miss，根本走不到这里。
   */
  it('does not write an unverified pick back under the exact key', async () => {
    const puts: string[] = [];
    handlers.fetch = async (url, init) => {
      if (url.includes('/ai-cache/resolve')) {
        return json({ ok: true, candidates: [{ key: KEY_A, words: ['小黄花'] }] });
      }
      if (init?.method === 'PUT') {
        puts.push(String(init.body ?? ''));
        return json({ ok: true, stored: true });
      }
      if (url.includes(KEY_A)) return await hit('theme', KEY_A, payload);
      return json({ hit: false }, false);
    };

    const result = await withAiCloudCache({
      kind: 'theme',
      fingerprint: KEY_L,
      /* 命中就不该轮到模型，也不该有 PUT。 */
      generate: async () => { throw new Error('不该轮到模型'); },
      validate: (value) => (value && typeof value === 'object' ? value as Record<string, unknown> : null),
      songTitle: '晴天',
    });

    expect(result!.source).toBe('cloud');
    expect(puts).toHaveLength(0);
  });

  /*
   * 一条高亮词都没标的候选：**无从判**，那不是「全都命中」（0/0）。
   *
   * 以前它走强制匹配 —— 于是服务端早年的老条目（那时还不存 words）能把任何一首歌的答案
   * 顶给任何人。现在老实回 miss。
   */
  it('gives up when a candidate marked no word at all', async () => {
    handlers.fetch = async (url) => {
      if (url.includes('/ai-cache/resolve')) {
        return json({ ok: true, candidates: [{ key: KEY_A, words: [] }] });
      }
      /* 内容照样给：只有「真取不到内容」才该轮到 miss，这一条验的是「没凭据」。 */
      if (url.includes(KEY_A)) return await hit('stage', KEY_A, payload);
      return json({ hit: false }, false);
    };

    const result = await pullAiCloudCache('stage', KEY_D, { songTitle: '晴天', lyricText: '故事的小黄花' });
    expect(result.status).toBe('miss');
  });

  /* 没歌名就无从下手，老老实实按没命中走。 */
  it('gives up quietly when there is nothing to judge against', async () => {
    handlers.fetch = async () => json({ hit: false }, false);

    expect(await pullAiCloudCache('stage', KEY_E, { songTitle: '', lyricText: '故事的小黄花' })).toEqual({ status: 'miss' });
  });

  /*
   * 没有歌词可判（主题只按「歌名 + 歌手」存的那一路、纯音乐）**没得判**，那就照旧：
   * 先问精确键，没中就按歌名取最靠前那条（'forced' —— 不回填）。
   *
   * 以前这一支在「没有歌词」时就当场记一次 miss 返回 —— 于是那一路本次会话再也不会问
   * 第二次，从「AI 主题」那一屏点播放看到的正是「云端明明有，就是匹配不上」。
   */
  it('takes the closest title match when there is no lyric to judge against', async () => {
    handlers.fetch = async (url) => {
      if (url.includes('/ai-cache/resolve')) {
        return json({ ok: true, candidates: [{ key: KEY_A, words: ['小黄花'] }] });
      }
      if (url.includes(KEY_A)) return await hit('theme', KEY_A, payload);
      return json({ hit: false }, false);
    };

    const result = await pullAiCloudCache('theme', KEY_J, { songTitle: '晴天' });
    expect(result.status).toBe('hit');
    if (result.status === 'hit') {
      expect(result.matched).toBe('forced');
      expect(result!.sourceKey).toBe(KEY_A);
      expect(result.payload).toEqual(payload);
    }
  });

  /*
   * 歌名一样、歌词不一样的一堆近亲，候选一次能来十来个 —— 挨着串行的话，前面有一个
   * 慢（或卡到超时）就把后面明明合规的那条拖住。判定是本机字符串比较，先全筛完再
   * 一起问。
   */
  it('asks every eligible candidate at once instead of one after another', async () => {
    const seen: string[] = [];
    handlers.fetch = async (url) => {
      seen.push(url);
      if (url.includes('/ai-cache/resolve')) {
        return json({
          ok: true,
          candidates: [
            // 每条至少两个词：一个词定不了「这是照着这首歌做的答案」，见 highlightWordsPresent。
            { key: KEY_A, words: ['小黄花', '故事'] },
            { key: KEY_H, words: ['荡秋千', '童年'] },
          ],
        });
      }
      if (url.includes(KEY_A)) return await hit('stage', KEY_A, payload);
      if (url.includes(KEY_H)) return await hit('stage', KEY_H, secondPayload);
      return json({ hit: false }, false);
    };

    const result = await pullAiCloudCache('stage', KEY_I, {
      songTitle: '晴天',
      lyricText: '故事的小黄花\n童年的荡秋千',
    });

    expect(result.status).toBe('hit');
    if (result.status === 'hit') {
      expect(result.matched).toBe('words');
      /* 两条都是 2 条证据（一样多）→ 留服务端给的顺序（歌名全等优先、更新时间倒序）。 */
      expect(result!.sourceKey).toBe(KEY_A);
      expect(result.payload).toEqual(payload);
    }
    /* 串行那条路问到第一个就返回了 —— 第二个也被问过才说明是一起发的。 */
    expect(seen.some((url) => url.includes(KEY_A))).toBe(true);
    expect(seen.some((url) => url.includes(KEY_H))).toBe(true);
  });

  /*
   * ⭐ **有歌词可判时不认精确键**，哪怕服务端照这个键答得出来。
   *
   * 键是「歌词 + policy」的 MD5，看着天衣无缝，可里面躺着的那一份未必是照着这份歌词做的
   * —— 早年的「强制匹配 + 回填」把别首歌的答案写到这个键上了。读它，等于每次都拿回那份
   * 错答案，而且永远没机会纠正。所以这里一定要按高亮词重新认一次。
   */
  it('never trusts the exact key once there is a lyric to judge by', async () => {
    const seen: string[] = [];
    handlers.fetch = async (url) => {
      seen.push(url);
      /*
       * 精确键这一问**答得出来**：专门造这个场景，才能验出「答得出来也不读」。
       * 摘要按 KEY_F 算 —— 它是「照这个键答回来的」，摘要本来就该绑定它。
       */
      if (url.includes(KEY_F)) return await hit('stage', KEY_F, payload);
      if (url.includes('/ai-cache/resolve')) {
        return json({ ok: true, candidates: [{ key: KEY_A, words: ['小黄花'] }] });
      }
      /* 候选那条是从 KEY_A 取回来的，摘要就绑定 KEY_A。 */
      if (url.includes(KEY_A)) return await hit('stage', KEY_A, secondPayload);
      return json({ hit: false }, false);
    };

    const result = await pullAiCloudCache('stage', KEY_F, { songTitle: '晴天', lyricText: '故事的小黄花' });

    expect(result.status).toBe('hit');
    if (result.status === 'hit') {
      expect(result.matched).toBe('words');
      /* 拿回来的是**验证过**的那条，不是精确键里躺着的 payload。 */
      expect(result.payload).toEqual(secondPayload);
    }
    expect(seen.some((url) => url.includes(KEY_F))).toBe(false);
  });

  /* 没歌词可判那一档（主题 / 纯音乐）反过来：无从判，只能信键。 */
  it('does take the exact key when there is nothing to judge by', async () => {
    const seen: string[] = [];
    handlers.fetch = async (url) => {
      seen.push(url);
      /* kind 与键都要对上：摘要绑定它们，绑错了会被当成「内容被挪过」而丢弃。 */
      return await hit('theme', KEY_N, payload);
    };

    const result = await pullAiCloudCache('theme', KEY_N, { songTitle: '晴天' });

    expect(result.status).toBe('hit');
    if (result.status === 'hit') expect(result.matched).toBe('exact');
    expect(seen.some((url) => url.includes('/ai-cache/resolve'))).toBe(false);
  });
});

describe('推上去之后自己要还能拉到', () => {
  /*
   * 推上去的那一键，本地必须立刻忘掉「刚才问过没有」。
   *
   * 队列播完从头再来一轮时最容易撞上：第一遍生成完把答案推上云端，本地 missCache
   * 却还记着「5 分钟前这个键没有」—— 切回来时 pull 被这条 miss 直接挡掉，**连 GET
   * 都不发**，于是又烧一次模型，而「已从云端拉取缓存」这句提示永远说不出来。
   */
  it('asks again after the answer was pushed, instead of calling it missing forever', async () => {
    let stored = false;
    const seen: string[] = [];
    handlers.fetch = async (url, init) => {
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      if (init?.method === 'PUT') {
        stored = true;
        return json({ ok: true, stored: true });
      }
      /* 推上去之后，这首歌在云端就是一条**有高亮词**的候选了 —— 有歌词时只能这样被认出来。 */
      if (url.includes('/ai-cache/resolve')) {
        return json({ ok: true, candidates: stored ? [{ key: KEY_PUSHED, words: ['小黄花'] }] : [] });
      }
      if (url.includes(KEY_PUSHED) && stored) return await hit('stage', KEY_PUSHED, payload);
      return json({ hit: false }, false);
    };

    /* 第一遍：云端没有 → 生成 → 推上去。 */
    const first = await withAiCloudCache({
      kind: 'stage',
      fingerprint: KEY_PUSHED,
      generate: async () => payload,
      validate: (value) => (value && typeof value === 'object' ? value as Record<string, unknown> : null),
      songTitle: '晴天',
      lyricText: '故事的小黄花',
    });
    expect(first!.source).toBe('ai');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stored).toBe(true);

    /* 第二遍（切走再切回来 / 队列循环回来）：必须真的去问一次，并且命中。 */
    const before = seen.length;
    const second = await pullAiCloudCache('stage', KEY_PUSHED, {
      songTitle: '晴天',
      lyricText: '故事的小黄花',
    });

    expect(second.status).toBe('hit');
    /* 被 missCache 挡掉的话这里一个请求都不会有。 */
    expect(seen.length).toBeGreaterThan(before);
  });
});

describe('withAiCloudCache 把按内容捞到的那条回填', () => {
  /*
   * 同一份歌词下次还是同一个键 —— 不回填就得再走一遍「搜歌名 + 逐条判」，白花两次
   * 往返。回填之后下一次是精确命中，命中率才会真的涨上去。
   */
  it('writes the borrowed answer back under the exact key', async () => {
    const puts: string[] = [];
    handlers.fetch = async (url, init) => {
      if (url.includes('/ai-cache/resolve')) {
        return json({ ok: true, candidates: [{ key: KEY_A, words: ['小黄花'] }] });
      }
      if (init?.method === 'PUT') {
        puts.push(String(init.body ?? ''));
        return json({ ok: true, stored: true });
      }
      if (url.includes(KEY_A)) return await hit('stage', KEY_A, payload);
      return json({ hit: false }, false);
    };

    const result = await withAiCloudCache({
      kind: 'stage',
      fingerprint: KEY_M,
      generate: async () => { throw new Error('不该轮到模型'); },
      validate: (value) => (value && typeof value === 'object' ? value as Record<string, unknown> : null),
      songTitle: '晴天',
      lyricText: '故事的小黄花',
    });

    expect(result!.source).toBe('cloud');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0]).payload).toEqual(payload);
  });
});
