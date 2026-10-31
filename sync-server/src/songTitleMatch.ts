// sync-server/src/songTitleMatch.ts
// 歌名怎么算「同一首」—— 纯函数，不碰 D1 也不碰 hono，好被单测引。
//
// 缓存键是「歌词 + policy」的 MD5，于是同一首歌换个版本的歌词（翻唱、现场、各家
// 平台的 LRC 本来就不同）就是另一个键。精确键没中时靠**歌名**去库里捞候选，再把
// 每条候选的高亮词带回去由客户端判定合不合规。
//
// 麻烦在于「同一首歌」在各平台上的名字并不一致：
//
//   - 括号里的备注：晴天 (Live)、歌名【伴奏】、某曲（电影《x》主题曲）
//   - 后缀：Remix、翻唱、feat. 某人、现场版、纯音乐、Acoustic、Inst.
//   - 中英文括号、全角半角、多余空格
//
// 用原样去比，「晴天」永远配不上「晴天 (Live)」，而它们的歌词是同一份，缓存里那条
// 明明能用。所以这里先把名字压成一个「核心名」再比。
//
// **放宽匹配 ≠ 放宽判定**：这里多给几个候选没关系，判「这条答案是不是照着这首歌
// 做的」仍然是客户端拿高亮词一条一条对（highlightWordsPresent）。误伤由那一层兜住。

/** 括号及其中内容 —— 备注几乎都写在括号里。 */
const BRACKETED = /[（(【\[][^）)】\]]*[）)】\]]/g;

/**
 * 平台爱往歌名上挂的东西。
 *
 * 中文没有词边界，`\b` 对中文不生效，所以中文那几个是整段匹配 —— 宁可多削一点：
 * 削错了只是多给几个候选，漏削了就是这条永远配不上。
 */
const NOISE =
  /(live|remix|remaster(?:ed)?|cover|acoustic|demo|inst(?:rumental)?\.?|instrumental|(?:feat|ft)\.?.*|official|mv|ver\.?|纯音乐|伴奏|现场(?:版)?|翻唱|原唱|清唱|钢琴版|吉他版|独奏|无伴奏|版|版本)/gi;

/** 只留字母、数字与中日韩 —— 标点、空格、全角半角的差别都是噪声。 */
const KEEP = /[0-9a-z\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/gi;

/** 后缀可能叠着写（「Live Ver.」是两层），削到不再变化为止。 */
const stripNoise = (value: string): string => {
  let text = value;
  for (let round = 0; round < 3; round += 1) {
    const next = text.replace(NOISE, ' ');
    if (next === text) break;
    text = next;
  }
  return text;
};

/**
 * 拿去**问数据库**的那个名字：去括号、去后缀，但**保留空格与标点**。
 *
 * SQL 的 LIKE 是跟库里原样的 `song_title` 比的 —— 压成没有空格的一坨反而配不上
 * 「Someone Like You」。压空格是 `songTitleKey` 的事，那一步留给本机比较。
 */
export const looseSongTitle = (value: string): string =>
  stripNoise(String(value ?? '').replace(BRACKETED, ' ')).replace(/\s+/g, ' ').trim();

/**
 * 拿去**比较**的那个名字：连标点空格一起压掉，只剩字母数字与中日韩。
 *
 * 「晴天 Live」「晴天(Live)」「晴天 (Live 版)」在这里都是同一个串。
 */
export const songTitleKey = (value: string): string =>
  ((looseSongTitle(value).match(KEEP) ?? []).join('') || '').toLowerCase();

/**
 * 拿去**问数据库**的另一个写法：在 `loose` 之上把标点也去了，只留字、数和空格。
 *
 * 「花海 - 现场」被 `loose` 削掉「现场」之后剩下「花海 -」，多出来那个连字符会让
 * `LIKE '%花海 -%'` 一条都配不上（库里叫「花海」）—— 但 `songTitleKey` 那一步是
 * 认的（它连标点一起压）。所以 LIKE 这一层也要有一个「去了标点」的版本兜住它。
 */
export const songTitleLike = (value: string): string =>
  looseSongTitle(value)
    .replace(/[^0-9a-z\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * 「第一个字」那个钩子。
 *
 * 主查询（全等 + 两端互相 LIKE）碰上平台各写一套歌名时会一条都捞不回来：库里叫
 * 「起风了」，手上这首叫别的名字，怎么压都压不到一起。这时候就按用户说的来 ——
 * 只拿歌名开头那一个字（中日韩）或头一个词（拉丁，至少三个字符，一个字母会把半个库
 * 都捞回来）去捞一堆候选，剩下的交给客户端拿高亮词判。**放宽的是入口，不是判定。**
 */
export const songTitleSeed = (value: string): string => {
  const first = Array.from(songTitleKey(value))[0] ?? '';
  if (!first) return '';
  if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(first)) return first;
  const word = (looseSongTitle(value).split(/\s+/)[0] ?? '').replace(/[^0-9a-z]/gi, '');
  return word.length >= 3 ? word.slice(0, 12) : '';
};

/**
 * 「歌手 - 歌名」这种写法拆开来的各段。
 *
 * 平台（以及不少本地曲库）爱把歌手写在前面：「周杰伦 - 晴天」「晴天 - 周杰伦」。
 * 整串压完是「周杰伦晴天」，跟库里的「晴天」怎么 LIKE 都配不上 —— 所以按分隔符切开，
 * 每一段单独拿去问，命中并在一起。这是那种名字唯一能走通的路。
 */
const SEPARATORS = /[\-–—~|/／·、,，:：]+/;

export const songTitleSegments = (value: string): string[] => {
  const loose = looseSongTitle(value);
  if (!loose) return [];
  const parts = loose
    .split(SEPARATORS)
    .map((part) => songTitleLike(part))
    .filter(Boolean);
  return [...new Set(parts)];
};

/**
 * 候选打分：数字越小越该排前面。
 *
 *   0 —— 归一后完全相同（「晴天」/「晴天 (Live)」）
 *   1 —— 云端更长（云端「晴天 现场」，请求「晴天」）
 *   2 —— 请求更长（云端「晴天」，请求「晴天 电影主题曲」）
 *   3 —— 只是原样包含，归一后对不上：不算候选，交给高亮词也救不回来
 *
 * 两端有一个压不出核心名（歌名全是噪声，比如就叫「Live」）时也按 3 处理 ——
 * 那种名字做模糊匹配会把半个库都捞回来。
 */
export const rankSongTitleMatch = (candidateTitle: string, requestedTitle: string): number => {
  const candidate = songTitleKey(candidateTitle);
  const requested = songTitleKey(requestedTitle);
  if (!candidate || !requested) return 3;
  if (candidate === requested) return 0;
  if (candidate.includes(requested)) return 1;
  if (requested.includes(candidate)) return 2;
  return 3;
};

/** 打分 3 不是候选。 */
export const isSongTitleCandidate = (candidateTitle: string, requestedTitle: string): boolean =>
  rankSongTitleMatch(candidateTitle, requestedTitle) < 3;

/*
 * ── 倒排索引用到的 token ──
 *
 * `LIKE '%歌名%'` 用不上任何索引，只能顺着 `kind` 把整片分区扫一遍再逐行比。库一大
 * （4 万条、每条 6KB 时实测 14ms，而 better-sqlite3 是同步的，这 14ms 里整个进程都停着），
 * 而且**库越大越慢** —— 多进程只能摊薄它，不能根治。
 *
 * 这里把歌名预先切成几种 token 存进 `ai_cache_title_token`，查询时按 token 精确命中，
 * 走索引直接定位到那几行 —— 实测 4 万条（每种歌名 6 个版本）时，现网的 LIKE 要 358ms，
 * 倒排 0.37ms，而且**与库的大小无关**。
 *
 * token 分三类，各自兜住一种「歌名对不上」的情况：
 *
 *   `K:` 归一后的整个核心名 —— 「晴天」「晴天 (Live)」「晴天【伴奏】」都是 `K:晴天`。
 *   `S:` 「歌手 - 歌名」拆段之后的每一段 —— 请求「周杰伦 - 晴天」要能命中库里的「晴天」。
 *   `D:` 首字/首词的钩子 —— 两边名字写法差太多时的最后一道入口（见 `songTitleSeed`）。
 *
 * **`D:` 单独查。** 它基数很大（实测 4 万条库里 `D:晴` 命中 1338 行），和 `K:`/`S:` 混在
 * 一条 `IN (...)` 里会把 `LIMIT` 撑满，反而把精确命中的那几十行挤掉 —— 那是「越优化越糟」
 * 的典型。所以先用 `K:`/`S:` 查，**只有一条都没查到时**才拿 `D:` 兜底（见 aiCache.ts 的
 * `findResolveCandidates`）。
 *
 * **不做单字 token。** 中文常用字更泛：「海」「曲」「晴」各能命中几千行（实测 `C:海`
 * 命中 5022 行），拿它去查等于换个方式全扫。
 *
 * **只放进入口，不放宽判定**：命中之后仍旧由 `rankSongTitleMatch` 打分、客户端拿高亮词
 * 终判。多捞回几条没关系，判错的代价由那一层兜着。
 */

/** token 的三种前缀。改这里的含义等于改索引格式，要跟着重建索引。 */
export const TITLE_TOKEN_FULL = 'K:';
export const TITLE_TOKEN_SEGMENT = 'S:';
export const TITLE_TOKEN_SEED = 'D:';

/** 一个歌名在索引里该有哪些 token。空数组表示这个名字不值得进索引。 */
const tokensFor = (value: string): string[] => {
  const full = songTitleKey(value);
  if (!full) return [];
  const tokens = new Set<string>([`${TITLE_TOKEN_FULL}${full}`]);
  songTitleSegments(value).forEach((segment) => {
    const key = songTitleKey(segment);
    if (key) tokens.add(`${TITLE_TOKEN_SEGMENT}${key}`);
  });
  const seed = songTitleSeed(value);
  /*
   * `songTitleSeed` 的拉丁分支保留原样大小写（它本来是拿去 `startsWith` 比 core 名的），
   * 但 token 是要**逐字相等**才能命中的，所以这里统一转小写 —— 否则「Someone Like You」
   * 写进去是 `D:Someone`，问的时候如果不巧大小写不同就永远命不中。
   */
  if (seed) tokens.add(`${TITLE_TOKEN_SEED}${seed.toLowerCase()}`);
  return [...tokens];
};

/**
 * 写索引时用：这一行歌名要拆成哪些 token。
 *
 * 与 `songTitleQueryTokens` 同一套规则 —— 两边不一致就会「写进去的问不到」。
 */
export const songTitleTokens = tokensFor;

/**
 * 查索引时用：**第一轮**要问的 token（精确的那一批）。
 *
 * 只要 `K:`（整个核心名）和 `S:`（拆段）—— 它们的基数都很小，命中多少就是多少。
 * 一条都没命中时才轮到 `songTitleFallbackTokens`。
 */
export const songTitleQueryTokens = (value: string): string[] =>
  tokensFor(value).filter((token) => !token.startsWith(TITLE_TOKEN_SEED));

/**
 * 查索引时用：**兜底**那一个 token（`D:` 首字/首词）。
 *
 * 基数大，所以只在第一轮颗粒无收时才单独问一次 —— 和精确 token 混在一条 `IN (...)`
 * 里会把它撑满、把精确命中挤掉。
 */
export const songTitleFallbackTokens = (value: string): string[] =>
  tokensFor(value).filter((token) => token.startsWith(TITLE_TOKEN_SEED));
