// sync-server/src/stageVerifier.ts
import { md5 } from './md5.js';
import { lyricTextCandidates, searchLyricCandidates, LYRIC_SOURCE_LABELS } from './stageLyricSources.js';

// 一条上传到底收不收：空数据一律拒，形状不合规一律拒，验不了的也拒 —— 只有真的
// 拿平台上的歌词原文件把哈希（或高亮词）对上了才收（issue C6）。
//
// 这份核验是**唯一**说明「这条答案属于这首歌」的证据：写缓存那一侧虽然已经有准入
// （requireCacheWriter 与写入令牌），但它证明的是「谁在写」，不是「写进来的东西对不对」。
// 所以核验结果从「尽力而为」改成了准入条件：
//
//  1. **空数据一律拒绝**，没有例外。
//  2. **验不了就拒绝**。以前有三条放行：`AI_CACHE_VERIFY=off` 一键关闭、没带 lyricHash
//     放行、平台取不到歌词放行。三条都是为了让「上游抖动」不阻塞上传 —— 代价是任何人都能
//     拿一句手写的请求把全局共享的那条盖掉：只要不带 lyricHash，核验根本不发生。现在
//     上游不通的结果是「这次写不进去」，而不是「跳过核验写进去」；读缓存那条路照旧公开，
//     一次写不进去不影响任何人拉已有的答案。

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const hasUsableColors = (theme: unknown): boolean => {
  if (!isRecord(theme)) return false;
  return typeof theme.backgroundColor === 'string'
    || typeof theme.primaryColor === 'string'
    || typeof theme.accentColor === 'string';
};

/** 一份 payload 里到底有没有东西：主题和动画决策至少得有一半站得住。 */
export const isStagePayloadEmpty = (payload: unknown): boolean => {
  if (payload === null || payload === undefined) return true;
  if (Array.isArray(payload)) return payload.length === 0;
  if (!isRecord(payload)) return true;

  const theme = isRecord(payload.theme) ? payload.theme : null;
  const hasTheme = Boolean(theme && (hasUsableColors(theme.light) || hasUsableColors(theme.dark)));

  const decision = isRecord(payload.decision) ? payload.decision : payload;
  const mode = typeof decision.mode === 'string' ? decision.mode.trim() : '';

  return !hasTheme && !mode;
};

export type StageUploadVerification =
  | {
    ok: true;
    /**
     * - verified     = 与平台上这首歌的歌词哈希对上了；
     * - word_matched = 哈希对不上，但**内容合规**：AI 标记的高亮词在这首歌的歌词里都在。
     *
     * 以前还有第三档 `unverified`（放行但不算数）。那一档就是「谁都能写」的入口，
     * 已经删掉（issue C6）：无从验证的上传现在直接拒。
     */
    status: 'verified' | 'word_matched';
    platform: string;
    source: string | null;
    note: string;
  }
  | {
    ok: false;
    /**
     * `no_lyric_evidence` 与 `lyric_unavailable` 是 C6 新增的两条拒绝理由 ——
     * 它们以前都被放行了（记成 `unverified`）。
     */
    error: 'empty_payload' | 'invalid_payload' | 'lyric_mismatch' | 'no_lyric_evidence' | 'lyric_unavailable';
    note: string;
  };

const HASH_PATTERN = /^[a-f0-9]{32}$/;

const collectWords = (value: unknown, out: Set<string>): void => {
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const word = typeof entry.word === 'string' ? entry.word.trim() : '';
    if (word) out.add(word);
  }
};

/**
 * 这条答案里 AI 标记的**高亮词**。
 *
 * 形状是 `theme.light.wordColors` / `theme.dark.wordColors`（`{ word, color }[]`）。主题
 * 也可能只有一层（早先推的条目），那就连 theme 自身那层一起找 —— 找到几个算几个。
 */
export const readHighlightWords = (payload: unknown): string[] => {
  const buckets: unknown[] = [];
  if (isRecord(payload)) {
    const theme = isRecord(payload.theme) ? payload.theme : payload;
    buckets.push(theme.wordColors);
    if (isRecord(theme.light)) buckets.push(theme.light.wordColors);
    if (isRecord(theme.dark)) buckets.push(theme.dark.wordColors);
  }
  const words = new Set<string>();
  buckets.forEach((bucket) => collectWords(bucket, words));
  return [...words];
};

/** 比的时候不看空白与大小写：LRC 里多一个空格不该判成「这不是同一个词」。 */
const flattenForMatch = (value: string): string => (
  String(value ?? '').replace(/\s+/g, '').toLowerCase()
);

/**
 * 一个词要能当证据，至少得这么长。
 *
 * **单字不算证据**：「留」在几乎每一首中文歌里都能撞上，它说明不了这条答案是照着哪首
 * 歌词做的；「留住」才算一句有点内容的凭据。英文同理（单字母、单字都不算）。
 */
const MIN_EVIDENCE_WORD_LENGTH = 2;

/**
 * 不构成证据的词：代词、助词、连词、介词、疑问词、程度副词 —— **任何一首歌里都有**的那些。
 *
 * 它们出现在歌词里说明不了任何事情。用户报的例子最典型：一条候选的高亮词是
 * `留住 / 我 / 什么 / 把 / 你`，而手上这首的歌词里「留住」和「把」根本不存在，光靠
 * 「我」「什么」「你」这三个就把另一首近亲的答案顶成了这首的主题。
 *
 * 只收到「显然没有区分度」这一层为止 —— 开始 / 结束 / 快乐 这类实词**不**进这张表：
 * 它到底是内容还是套话机器分不清，宁可放过也不误伤。表里全是压平后（去空白、转小写）
 * 的形式。
 *
 * ⚠️ **这张表与客户端 `src/services/aiCloudCache.ts` 里的 `NON_EVIDENCE_WORDS` 是同一
 * 张表**（两份代码，一个规矩）：改一边必须改另一边，否则客户端判得过的条目在服务端
 * 被拒（或反过来），`test/unit/sync-server/highlightEvidenceParity.test.ts` 钉着这一点。
 */
const NON_EVIDENCE_WORDS = new Set([
  // 代词与指称
  '我', '我们', '咱', '咱们', '你', '你们', '他', '他们', '她', '她们', '它', '它们',
  '自己', '大家', '这', '这个', '这些', '那', '那个', '那些', '谁', '什么', '怎么',
  '怎样', '怎么样', '这么', '那么', '多少', '哪里', '哪儿', '这里', '那里',
  // 助词 / 语气
  '的', '地', '得', '了', '着', '过', '吗', '呢', '吧', '啊', '呀', '哦', '啦',
  // 系词 / 助动词 / 否定
  '是', '在', '有', '没', '没有', '不', '别', '无', '要', '会', '能', '可以', '应该',
  '需要', '就是', '还是', '也是', '都是',
  // 连词 / 介词
  '和', '与', '跟', '或', '而', '且', '但', '但是', '却', '因为', '所以', '然后',
  '而且', '如果', '虽然', '于是', '把', '被', '给', '让', '使', '对', '从', '向',
  '往', '到', '于', '为', '用',
  // 程度 / 频率 / 范围
  '也', '都', '就', '又', '再', '还', '很', '太', '更', '最', '才', '只', '一直',
  '总是', '一个', '一样', '一些', '所有', '一切', '时候', '现在', '已经', '知道',
  '觉得', '感觉', '一起',
  // 英文里同样没有区分度的那些
  'the', 'and', 'of', 'to', 'in', 'on', 'at', 'as', 'an', 'be', 'by', 'if', 'or',
  'is', 'it', 'we', 'me', 'my', 'up', 'so', 'no', 'do', 'am', 'are', 'was', 'you',
  'your', 'this', 'that', 'what', 'when', 'not',
]);

/** 能当证据用的那部分高亮词：去掉单字，再去掉上面那张表里的虚词。 */
export const highlightEvidenceWords = (words: readonly string[]): string[] => (
  words
    .map((word) => flattenForMatch(word))
    .filter((word) => word.length >= MIN_EVIDENCE_WORD_LENGTH && !NON_EVIDENCE_WORDS.has(word))
);

/**
 * 「合规」：**证据词**在这首歌的歌词里**全部找得到**，少一个都不行。
 *
 * 高亮词是模型照着歌词挑出来的 —— 一条照着别的歌做的答案，不可能把这首的词挑出来。
 * 所以这比哈希宽松（容忍同一首歌的不同版本），又比「一律放行」严格得多。
 *
 * 判定只看**证据词**（去掉单字与虚词）：「我 / 什么 / 你」这种任何一首歌里都有的词出现
 * 在歌词里说明不了任何事情，拿它们凑出来的「命中」会把另一首近亲的答案顶成这首的
 * —— 用户报的就是这个。规矩与客户端拉缓存那一侧**完全一致**：100%，差一个就不算。
 *
 * 一个证据词都没有时不算合规：那不是「全都命中了」（0/0），是**没有凭据**。
 */
export const highlightWordsPresent = (words: readonly string[], lyricText: string): boolean => {
  const evidence = highlightEvidenceWords(words);
  if (evidence.length === 0) return false;
  const haystack = flattenForMatch(lyricText);
  if (!haystack) return false;
  return evidence.every((needle) => haystack.includes(needle));
};

/**
 * 证据词的**总数、命中数与缺的那几个**。
 *
 * 判定本身用 `highlightWordsPresent`；扫描脚本要拿 `missing` 说清「这一条差在哪」，
 * 不然管理员看着一条「脏」不知道它脏在哪、是不是误判。
 */
export const countEvidenceHits = (
  words: readonly string[],
  lyricText: string,
): { total: number; hits: number; missing: string[] } => {
  const evidence = highlightEvidenceWords(words);
  const haystack = flattenForMatch(lyricText);
  if (evidence.length === 0 || !haystack) {
    return { total: evidence.length, hits: 0, missing: [...evidence] };
  }
  const missing: string[] = [];
  for (const needle of evidence) {
    if (!haystack.includes(needle)) missing.push(needle);
  }
  return { total: evidence.length, hits: evidence.length - missing.length, missing };
};

export const verifyStageUpload = async (input: {
  payload: unknown;
  songTitle: string;
  platform: string;
  /** 客户端带来的「歌词正文 MD5」；没有它就没有任何说明来源的证据，直接拒。 */
  lyricHash: string;
  isPureMusic?: boolean;
}): Promise<StageUploadVerification> => {
  const { payload, songTitle, platform, lyricHash, isPureMusic } = input;

  if (isStagePayloadEmpty(payload)) {
    return { ok: false, error: 'empty_payload', note: '空数据：既没有主题也没有动画决策。' };
  }

  if (!isRecord(payload)) {
    return { ok: false, error: 'invalid_payload', note: 'payload 不是对象。' };
  }

  const hash = String(lyricHash ?? '').trim().toLowerCase();
  const platformName = String(platform ?? '').trim();
  const label = LYRIC_SOURCE_LABELS[platformName.toLowerCase()] ?? '';

  /*
   * 没有哈希（老客户端推的、或者手写的一条请求）就没有任何证据说明这条答案属于这首歌。
   *
   * 以前这里放行 —— 那等于给「随便推一条」留了后门：攻击者只要不带 lyricHash，整段核验
   * 都不发生。现在拒。老客户端因此推不上去：它们照样能**读**（读那条链路从来没变），
   * 只是自己生成的那份不再回传，这正是 issue C6 要的结果。
   */
  if (!HASH_PATTERN.test(hash)) {
    return {
      ok: false,
      error: 'no_lyric_evidence',
      note: '这一条没带歌词哈希，无从校验来源。',
    };
  }

  /*
   * 纯音乐：指纹用的是**歌名**而不是歌词正文（客户端 resolveStageLyricSource），
   * 服务端自己就能重算，不必去平台问。
   */
  if (isPureMusic === true) {
    if (md5(String(songTitle ?? '').trim()) === hash) {
      return {
        ok: true,
        status: 'verified',
        platform: platformName,
        source: null,
        note: '纯音乐：指纹取自歌名，已核对。',
      };
    }
    return {
      ok: false,
      error: 'lyric_mismatch',
      note: '歌名与上传的哈希对不上。',
    };
  }

  /* 按歌名去平台上搜。 */
  const { candidates, source } = await searchLyricCandidates(platformName, songTitle);

  /*
   * 平台上没有这首歌、或者接口这会儿不通：**拒写**。
   *
   * 以前这一档放行（「缓存永不阻塞功能」）。放行在公开写接口上是致命的：上游不通的时候
   * 恰好是核验最容易被绕过去的时候。现在的取舍是「上游不通 = 这次写不进去」—— 读那一侧
   * 照旧公开、照旧不受影响，用户最多是这次生成的答案没贡献上去。
   */
  if (candidates.length === 0) {
    return {
      ok: false,
      error: 'lyric_unavailable',
      note: platformName
        ? `${label || platformName} 上没搜到这首歌，无从校验来源。`
        : '各个平台都没搜到这首歌，无从校验来源。',
    };
  }

  /*
   * 先比哈希，一首一首来。
   *
   * 同一首歌在平台上有好几个版本（翻唱、现场、别人重新传的 LRC），上传者手里那份未必
   * 是搜索结果里的第一条 —— 只比第一条会把大量正常上传误判成「不一致」。命中就停，
   * 后面几首的歌词一次都不拉。
   */
  for (const candidate of candidates) {
    const text = await candidate.readLyric();
    if (!text) continue;
    if (!lyricTextCandidates(text).some((variant) => md5(variant) === hash)) continue;
    return {
      ok: true,
      status: 'verified',
      platform: platformName,
      source,
      note: `已与${LYRIC_SOURCE_LABELS[candidate.source] ?? candidate.source}上《${candidate.title}》的歌词核对一致。`,
    };
  }

  /*
   * 哈希还是对不上 —— 再按**内容**判一次。
   *
   * 歌词版本不同不代表这条答案是假的：换了个版本的 LRC，哈希就变了，可它照样是照着
   * 这首歌做的。合规的标准就是用户定的那条：**答案里 AI 标记的高亮词，在这首歌的歌词
   * 里全都找得到**。挑得出这些词，就说明生成它时看的确实是这首歌。
   */
  const words = readHighlightWords(payload);
  if (words.length > 0) {
    for (const candidate of candidates) {
      const text = await candidate.readLyric();
      if (!text || !highlightWordsPresent(words, text)) continue;
      return {
        ok: true,
        status: 'word_matched',
        platform: platformName,
        source,
        note: `歌词版本与${LYRIC_SOURCE_LABELS[candidate.source] ?? candidate.source}上《${candidate.title}》不完全一致，但 AI 标记的 ${words.length} 个高亮词都在这首歌的歌词里。`,
      };
    }
  }

  return {
    ok: false,
    error: 'lyric_mismatch',
    note: words.length === 0
      ? `${source ? (LYRIC_SOURCE_LABELS[source] ?? source) : '平台'}上的歌词与上传的哈希对不上，而且这一条没有 AI 高亮词可以核对内容。`
      : `${source ? (LYRIC_SOURCE_LABELS[source] ?? source) : '平台'}上的歌词与上传的哈希对不上，AI 标记的 ${words.length} 个高亮词也没能在这首歌的歌词里找齐。`,
  };
};
