import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  highlightWordsPresent,
  isStagePayloadEmpty,
  readHighlightWords,
  verifyStageUpload,
} from '../../../sync-server/src/stageVerifier';
import { md5 } from '../../../sync-server/src/md5';
import { lyricTextCandidates } from '../../../sync-server/src/stageLyricSources';
import { resolveSongPlatform } from '../../../src/utils/songPlatform';
import type { SongResult } from '../../../src/types';

// test/unit/sync-server/stageUploadVerification.test.ts
// 一条上传收不收：空数据一律拒，能验的再拿平台上的歌词把哈希重算一遍。
//
// 上传接口是公开的，所以「有人拿空数据把别人做好的那条盖掉」是迟早会发生的事。
// 这里锁住的是那道门槛本身；平台取不到歌词时**必须放行**（缓存永不阻塞功能），
// 这条同样要钉住 —— 反过来实现会把一次上游抖动变成全站上传失败。

const goodPayload = {
  theme: {
    light: { backgroundColor: '#ffffff', primaryColor: '#111111', accentColor: '#ff0000', secondaryColor: '#00ff00' },
    dark: { backgroundColor: '#000000', primaryColor: '#eeeeee', accentColor: '#00ffff', secondaryColor: '#333333' },
  },
  decision: { mode: 'classic', reason: '均衡', params: {} },
};

/** 网易云那两个接口的假响应：搜索给一个 id，歌词给一段 LRC。 */
const stubNetease = (lyric: string) => {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    const body = url.includes('/api/search/get/web')
      ? JSON.stringify({ result: { songs: [{ id: 123, name: '晴天' }] } })
      : JSON.stringify({ lrc: { lyric } });
    return { ok: true, status: 200, text: async () => body } as unknown as Response;
  }));
};

const stubNoResult = () => {
  vi.stubGlobal('fetch', vi.fn(async () => (
    { ok: true, status: 200, text: async () => JSON.stringify({ result: { songs: [] } }) } as unknown as Response
  )));
};

/** 搜索给好几首，歌词按 id 分别给 —— 第一条对不上时要能往下试。 */
const stubNeteaseSongs = (songs: { id: number; name?: string; lyric: string }[]) => {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    const body = url.includes('/api/search/get/web')
      ? JSON.stringify({ result: { songs: songs.map((song) => ({ id: song.id, name: song.name ?? '晴天' })) } })
      : JSON.stringify({ lrc: { lyric: songs.find((song) => song.id === Number(new URL(url).searchParams.get('id')))?.lyric ?? '' } });
    return { ok: true, status: 200, text: async () => body } as unknown as Response;
  }));
};

/** 带 AI 高亮词的主题：内容合规判的就是这些词。 */
const withWords = (words: string[]) => ({
  theme: {
    light: {
      ...goodPayload.theme.light,
      wordColors: words.map((word) => ({ word, color: '#ff00aa' })),
    },
    dark: {
      ...goodPayload.theme.dark,
      wordColors: words.map((word) => ({ word, color: '#00aaff' })),
    },
  },
  decision: goodPayload.decision,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('md5', () => {
  it('matches the published test vectors', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0');
  });

  /* 歌名与歌词都是中文：按 UTF-16 算出来的哈希和客户端对不上，校验就永远是「不一致」。 */
  it('encodes the input as UTF-8', () => {
    expect(md5('晴天')).toBe(md5('晴天'));
    expect(md5('晴天')).not.toBe(md5('晴'));
    expect(md5('晴天')).toHaveLength(32);
  });
});

describe('isStagePayloadEmpty', () => {
  it('rejects the shapes that carry nothing', () => {
    expect(isStagePayloadEmpty(null)).toBe(true);
    expect(isStagePayloadEmpty(undefined)).toBe(true);
    expect(isStagePayloadEmpty({})).toBe(true);
    expect(isStagePayloadEmpty([])).toBe(true);
    expect(isStagePayloadEmpty({ theme: {} })).toBe(true);
    /* 只有 decision 却没有 mode —— 等于什么都没说。 */
    expect(isStagePayloadEmpty({ decision: { reason: 'x' } })).toBe(true);
    expect(isStagePayloadEmpty({ decision: { mode: '   ' } })).toBe(true);
  });

  it('accepts a half entry, which is what old uploads look like', () => {
    expect(isStagePayloadEmpty({ theme: goodPayload.theme })).toBe(false);
    expect(isStagePayloadEmpty({ decision: { mode: 'classic' } })).toBe(false);
    expect(isStagePayloadEmpty(goodPayload)).toBe(false);
  });
});

describe('verifyStageUpload', () => {
  it('rejects empty payloads no matter what else is offered', async () => {
    const result = await verifyStageUpload({
      payload: { theme: {} },
      songTitle: '晴天',
      platform: 'netease',
      lyricHash: md5('la la la'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('empty_payload');
  });

  /* 空数据在任何情况下都拒：核验的宽严跟「有没有内容」是两件事（issue C6）。 */
  it('rejects an empty payload before it even asks for lyric evidence', async () => {
    const result = await verifyStageUpload({
      payload: null,
      songTitle: '晴天',
      platform: '',
      lyricHash: '',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('empty_payload');
  });

  /*
   * 纯音乐的指纹取自**歌名**（客户端 resolveStageLyricSource），服务端自己就能重算，
   * 不必去平台问 —— 所以这种情况是唯一能严格判「不一致」的。
   */
  it('checks a pure-music entry against its title', async () => {
    const ok = await verifyStageUpload({
      payload: goodPayload,
      songTitle: '晴天',
      platform: '',
      lyricHash: md5('晴天'),
      isPureMusic: true,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.status).toBe('verified');

    const bad = await verifyStageUpload({
      payload: goodPayload,
      songTitle: '晴天',
      platform: '',
      lyricHash: md5('别的歌'),
      isPureMusic: true,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe('lyric_mismatch');
  });

  /*
   * 旧客户端没有 lyricHash：**以前放行**（记成 unverified）。现在一律拒（issue C6）。
   *
   * 理由：没有 lyricHash 就等于没有任何来源证据，而这张表是全局共享的 —— 一句手写的
   * PUT 就能把任意内容塞进别人的主题里。「老客户端还能不能推」远不如「谁都能推」严重，
   * 而且新版客户端本来就会带 lyricHash（纯音乐用歌名哈希）。
   */
  it('refuses an upload that brings no lyric evidence at all', async () => {
    const result = await verifyStageUpload({
      payload: goodPayload,
      songTitle: '晴天',
      platform: '',
      lyricHash: '',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('no_lyric_evidence');
  });

  /* 纯音乐缺 lyricHash 也是「没有证据」：不能因为标了纯音乐就跳过来源校验。 */
  it('refuses a pure-music upload that brings no title hash', async () => {
    const result = await verifyStageUpload({
      payload: goodPayload,
      songTitle: '晴天',
      platform: '',
      lyricHash: '',
      isPureMusic: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('no_lyric_evidence');
  });

  it('matches the lyric hash against the platform copy', async () => {
    stubNetease('[00:01.00]故事的小黄花\n[00:04.00]从出生那年就飘着');
    const lyricText = '故事的小黄花\n从出生那年就飘着';

    const result = await verifyStageUpload({
      payload: goodPayload,
      songTitle: '晴天',
      platform: 'netease',
      lyricHash: md5(lyricText),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('verified');
      expect(result.source).toBe('netease');
    }
  });

  it('refuses when the platform copy hashes to something else', async () => {
    stubNetease('[00:01.00]完全不一样的一句词');

    const result = await verifyStageUpload({
      payload: goodPayload,
      songTitle: '晴天',
      platform: 'netease',
      lyricHash: md5('故事的小黄花'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('lyric_mismatch');
  });

  /*
   * 同一首歌在平台上有好几个版本：只比搜索结果第一条的哈希，会把大量正常上传误判成
   * 「不一致」—— 上传者手里那份未必是第一条。
   */
  it('keeps looking through the search hits when the first one hashes elsewhere', async () => {
    stubNeteaseSongs([
      { id: 1, name: '晴天（现场版）', lyric: '[00:01.00]完全不一样的一句词' },
      { id: 2, name: '晴天', lyric: '[00:01.00]故事的小黄花\n[00:04.00]从出生那年就飘着' },
    ]);

    const result = await verifyStageUpload({
      payload: goodPayload,
      songTitle: '晴天',
      platform: 'netease',
      lyricHash: md5('故事的小黄花\n从出生那年就飘着'),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('verified');
      expect(result.note).toContain('晴天');
    }
  });

  /* 命中就停：后面几首的歌词一次都不该去拉，那是白给公开接口加压力。 */
  it('stops asking for lyrics once one of them matches', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      asked.push(url);
      const body = url.includes('/api/search/get/web')
        ? JSON.stringify({ result: { songs: [{ id: 1, name: '晴天' }, { id: 2, name: '晴天 现场' }, { id: 3, name: '晴天 翻唱' }] } })
        : JSON.stringify({ lrc: { lyric: url.includes('id=1') ? '[00:01.00]故事的小黄花' : '[00:01.00]别的词' } });
      return { ok: true, status: 200, text: async () => body } as unknown as Response;
    }));

    const result = await verifyStageUpload({
      payload: goodPayload,
      songTitle: '晴天',
      platform: 'netease',
      lyricHash: md5('故事的小黄花'),
    });

    expect(result.ok).toBe(true);
    expect(asked.filter((url) => url.includes('/api/song/lyric'))).toHaveLength(1);
  });

  /*
   * 哈希对不上 ≠ 这条是假的：换了个版本的 LRC 哈希就变了，可它照样是照着这首歌做的。
   * 用户定的合规标准就是这条：AI 标记的高亮词在这首歌的歌词里全都找得到。
   */
  it('accepts another lyric edition when every AI highlight word is in it', async () => {
    stubNeteaseSongs([
      { id: 1, lyric: '[00:01.00]故事的小黄花\n[00:04.00]童年的 荡秋千 一直飘着' },
    ]);

    const result = await verifyStageUpload({
      payload: withWords(['小黄花', '荡秋千']),
      songTitle: '晴天',
      platform: 'netease',
      lyricHash: md5('另一个版本的歌词'),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('word_matched');
      expect(result.note).toContain('高亮词');
    }
  });

  it('refuses when a highlight word is nowhere in the song', async () => {
    stubNeteaseSongs([{ id: 1, lyric: '[00:01.00]故事的小黄花' }]);

    const result = await verifyStageUpload({
      payload: withWords(['小黄花', '这句词根本不在这首歌里']),
      songTitle: '晴天',
      platform: 'netease',
      lyricHash: md5('另一个版本的歌词'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('lyric_mismatch');
  });

  /*
   * 平台上没有这首歌、或者接口这会儿不通 —— **以前放行**（记成 unverified）。现在拒（issue C6）。
   *
   * 这条改动最需要解释：原来的纪律是「第三方接口抖一次不该变成全站上传失败」。
   * 问题是「接口抖了」和「这首歌不存在 / 上传者在编」在服务端看起来完全一样，而放行的
   * 后果是**一条无法核验的内容进了所有人共用的表**。写入这条路（client → 我们）的成功
   * 不是用户的刚需 —— 客户端在 4xx 之后会退回本地生成，主题照样出得来；而错误内容一旦
   * 进表，所有拉到它的人都会被喂一次。「宁可不写，不可写错」在这里划算。
   */
  it('refuses when no platform has the song, instead of writing an unverifiable entry', async () => {
    stubNoResult();

    const result = await verifyStageUpload({
      payload: goodPayload,
      songTitle: '一首谁都没有的歌',
      platform: '',
      lyricHash: md5('la la la'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      /* 平台一个都问不到：这是「歌词不可得」，不是「歌词不匹配」。 */
      expect(result.error).toBe('lyric_unavailable');
    }
  });
});

describe('lyricTextCandidates', () => {
  it('offers both the blank-keeping and the blank-stripped shape', () => {
    const candidates = lyricTextCandidates('第一行\n\n第二行');
    expect(candidates).toContain('第一行\n\n第二行');
    expect(candidates).toContain('第一行\n第二行');
  });

  it('has nothing to offer for blank lyrics', () => {
    expect(lyricTextCandidates('')).toEqual([]);
    expect(lyricTextCandidates('   \n  \n')).toEqual([]);
  });
});

describe('readHighlightWords', () => {
  it('reads what the AI marked in both the light and the dark theme', () => {
    const words = readHighlightWords({
      theme: {
        light: { wordColors: [{ word: '小黄花', color: '#fff' }, { word: '  ', color: '#fff' }] },
        dark: { wordColors: [{ word: '荡秋千', color: '#000' }, { word: '小黄花', color: '#000' }] },
      },
    });
    /* 去重要去重：明暗两套主题标的是同一批词。 */
    expect(words.sort()).toEqual(['小黄花', '荡秋千'].sort());
  });

  /* 早先推的条目可能把高亮词直接放在 theme 上，那层也要认。 */
  it('also reads a single-level theme', () => {
    expect(readHighlightWords({ theme: { wordColors: [{ word: '晴天' }] } })).toEqual(['晴天']);
  });

  it('has nothing to say about a payload without a theme', () => {
    expect(readHighlightWords({ decision: { mode: 'classic' } })).toEqual([]);
    expect(readHighlightWords(null)).toEqual([]);
  });
});

describe('highlightWordsPresent', () => {
  const lyric = '故事的小黄花\n童年的荡秋千';

  it('is satisfied when every word appears', () => {
    expect(highlightWordsPresent(['小黄花', '荡秋千'], lyric)).toBe(true);
  });

  /* 空白与大小写不算差异 —— LRC 里多一个空格不该判成「这不是同一个词」。 */
  it('ignores whitespace and case', () => {
    expect(highlightWordsPresent(['小 黄 花'], '故事的小黄花')).toBe(true);
    expect(highlightWordsPresent(['Rainbow'], 'some RAINBOW here')).toBe(true);
  });

  it('is not satisfied when one word is missing', () => {
    expect(highlightWordsPresent(['小黄花', '不存在的词'], lyric)).toBe(false);
  });

  /*
   * 一个高亮词都没有时不算合规：哈希已经对不上了，再没有任何证据说明它属于这首歌。
   * 反过来实现等于给「随便推一条」开了后门。
   */
  it('needs at least one word to go on', () => {
    expect(highlightWordsPresent([], lyric)).toBe(false);
    expect(highlightWordsPresent(['小黄花'], '')).toBe(false);
  });
});

describe('resolveSongPlatform', () => {
  it('reads the online provider id', () => {
    const song = { sourceRef: { kind: 'online', providerId: 'netease', mediaId: '1' } } as unknown as SongResult;
    expect(resolveSongPlatform(song)).toBe('netease');
  });

  /* 本地 / Navidrome / 舞台：没有平台可言，留空由服务端逐个平台试。 */
  it('has nothing to say about a local file', () => {
    expect(resolveSongPlatform({ sourceRef: { kind: 'local', mediaId: 'x' } } as unknown as SongResult)).toBe('');
    expect(resolveSongPlatform(null)).toBe('');
    expect(resolveSongPlatform(undefined)).toBe('');
    expect(resolveSongPlatform({} as SongResult)).toBe('');
  });
});
