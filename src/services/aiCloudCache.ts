import { createAiFetch, fetchAiCacheViaNative } from './aiNativeFetch';
import { describeAiTarget, type AiCompletionTarget } from './aiCompletion';
import { isFoliaCloudCacheEnabled, resolveCloudApiUrl } from './foliaCloud';
import { dropLocalCloudEntry, forgetLocalCloudMiss, readLocalCloudEntry, readLocalCloudMiss, rememberLocalCloudMiss, writeLocalCloudEntry } from './aiCloudCacheLocal';
import { md5 } from '../utils/md5';

// src/services/aiCloudCache.ts
// AI 云缓存：把「这段歌词已经有人生成过了」这件事存到服务器上。
//
// 缓存键是**歌词文件本身的 MD5**，不是歌名、不是播放源 —— 同一份歌词，
// 谁先生成谁上传，后面的人直接取答案，不再烧一次模型调用。
//
// 两条纪律：
//  1. **拉取不需要 Key。** 开关默认打开正是为了没填 Key 的人：他本来一个
//     主题都生成不出来，能命中别人的结果就是白赚。
//  2. **缓存永不阻塞功能。** 拉失败、推失败、返回的 JSON 不认识 —— 全部
//     静默退回「照常生成」，缓存只是加速器，不是依赖。
//
// 本地那一层（aiCloudCacheLocal.ts）在拉之前先看：本机存着就直接用，零请求；云端拿到的
// 一律回写本地。服务器扛不住的是「同一首歌反复问同一个键」，本地命中正好省掉的就是它。

/** 提示词一改，缓存就换一批：老答案的格式未必还能用。 */
const CACHE_SCHEMA = 'v1';
const REQUEST_TIMEOUT_MS = 12_000;
/** 同一个键刚问过「没有」就别再问，省一次往返。 */
const MISS_TTL_MS = 5 * 60 * 1000;
/**
 * 合规的候选最多同时拉几条。
 *
 * 服务端一次最多给 12 个候选，全并发既没必要也不礼貌；取前几条已经够覆盖「第一条
 * 拉不动」这种常见情况。
 */
const MAX_CONCURRENT_ENTRY_FETCHES = 4;

/*
 * 只有一种。
 *
 * 主题与动画决策合成一次请求之后，服务端也只留一种条目：一条 stage =
 * 「这段歌词对应的主题 + 动画」。以前 theme / director 各存一条，同一段歌词交两遍，
 * 两条链路各拉自己那条 —— 既浪费空间，也没法一次往返同时喂饱两条链路。
 */
/**
 * `theme` = AI 主题（按歌算键，见 services/aiThemeCloud.ts）；
 * `stage` = 舞台决策（按歌词 + policy 算键）。
 *
 * 两种键混在一个 kind 里会互相盖：主题那一路推上去的条目里没有决策，
 * 正好把别人推的完整条目抹成半截。
 */
export type AiCloudCacheKind = 'stage' | 'theme';

/** `/api/ai-cache/<kind>/<md5>`。 */
export const resolveAiCloudCacheUrl = (kind: AiCloudCacheKind, key: string): string => (
    resolveCloudApiUrl(`ai-cache/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`)
);

/** 精确键没命中时的兜底：按歌名要一批候选。 */
const resolveAiCloudResolveUrl = (): string => resolveCloudApiUrl('ai-cache/resolve');

/** 「云端现在有哪些歌」—— 首页「AI 主题」那一屏的歌名清单。 */
const resolveAiCloudSongsUrl = (): string => resolveCloudApiUrl('ai-cache/songs');

/**
 * 歌名清单里的一行（按歌名去重：同一首歌的几个歌词版本合起来算一首）。
 *
 * `platform` 是推上去那次记下的平台名，只当作「去哪儿搜」的**建议** —— 客户端
 * 用的是自己当前登着的那个平台，不是它（别人推的时候用的平台你未必登录了）。
 */
export type AiCloudCacheSongEntry = {
    songTitle: string;
    platform: string;
    key: string;
    updatedAt: string;
    hits: number;
    /** 这个歌名下存了几个歌词版本。 */
    versions: number;
};

export type AiCloudCacheSongPage = {
    /** 云端一共有多少首（去重后）—— 客户端拿它先把屏幕铺满。 */
    total: number;
    limit: number;
    offset: number;
    songs: AiCloudCacheSongEntry[];
};

/**
 * 拉一段歌名。失败一律返回空页 —— 缓存的纪律是永不阻塞功能，
 * 这一屏只是「看看云端有什么」，拉不到就当没有。
 */
export const listAiCloudCacheSongs = async (
    { limit = 60, offset = 0, query = '' }: { limit?: number; offset?: number; query?: string } = {},
): Promise<AiCloudCacheSongPage> => {
    const empty: AiCloudCacheSongPage = { total: 0, limit, offset, songs: [] };
    if (!isFoliaCloudCacheEnabled()) return empty;
    const search = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
    });
    // 搜索框里那个「AI 主题」来源：按歌名在云端筛。转义交给 URLSearchParams。
    const trimmedQuery = String(query ?? '').trim();
    if (trimmedQuery) search.set('q', trimmedQuery);
    try {
        const response = await createAiFetch()(`${resolveAiCloudSongsUrl()}?${search.toString()}`, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: withTimeout(),
        });
        if (!response.ok) return empty;
        const data = await response.json().catch(() => null) as {
            ok?: unknown; total?: unknown; limit?: unknown; offset?: unknown; songs?: unknown;
        } | null;
        const list = Array.isArray(data?.songs) ? data?.songs : [];
        const songs: AiCloudCacheSongEntry[] = [];
        list.forEach((entry: unknown) => {
            if (!isPlainObject(entry)) return;
            const songTitle = String(entry.songTitle ?? '').trim().slice(0, 200);
            if (!songTitle) return;
            songs.push({
                songTitle,
                platform: String(entry.platform ?? '').trim().slice(0, 64),
                key: String(entry.key ?? '').trim().toLowerCase(),
                updatedAt: String(entry.updatedAt ?? ''),
                hits: Number(entry.hits ?? 0) || 0,
                versions: Number(entry.versions ?? 1) || 1,
            });
        });
        return {
            total: Number(data?.total ?? songs.length) || 0,
            limit: Number(data?.limit ?? limit) || limit,
            offset: Number(data?.offset ?? offset) || offset,
            songs,
        };
    } catch {
        return empty;
    }
};

/**
 * 歌词文件的指纹。
 *
 * `policy` 用来把「同一份词、不同设置」隔开：导演的判断受屏蔽模式、用户提示、
 * 最近用过的样式影响，这些变了就该重新问一次，否则会拿到前一个设置的答案。
 */
export const fingerprintLyricSource = (
    kind: AiCloudCacheKind,
    lyricSource: string,
    policy = '',
): string => md5(`${CACHE_SCHEMA}\n${kind}\n${policy}\n${String(lyricSource ?? '')}`);

const missCache = new Map<string, number>();

const missKey = (kind: AiCloudCacheKind, key: string) => `${kind}:${key}`;

const rememberMiss = (kind: AiCloudCacheKind, key: string): void => {
    missCache.set(missKey(kind, key), Date.now());
    if (missCache.size > 200) {
        // Cheap eviction: the oldest misses are the least likely to be asked.
        const oldest = [...missCache.entries()].sort((left, right) => left[1] - right[1])[0];
        if (oldest) missCache.delete(oldest[0]);
    }
};

const wasRecentMiss = (kind: AiCloudCacheKind, key: string): boolean => {
    const at = missCache.get(missKey(kind, key));
    if (!at) return false;
    if (Date.now() - at > MISS_TTL_MS) {
        missCache.delete(missKey(kind, key));
        return false;
    }
    return true;
};

/**
 * 刚推上去的那一键，本地别再当成「没有」。
 *
 * push 成功说明云端这个键**现在一定有了**，可 missCache 还记着「5 分钟前问过一次
 * 没有」。于是切走再切回来（或队列播完从头再来一轮）时 pull 会被这条 miss 直接挡掉：
 * 不发 GET、直接走去生成 —— 白烧一次模型，而「已从云端拉取缓存」这句提示也永远
 * 说不出来，明明缓存就是自己刚推上去的。
 */
const forgetMiss = (kind: AiCloudCacheKind, key: string): void => {
    missCache.delete(missKey(kind, key));
    /* 本地那条「问过、没有」同理：刚推上去的键不该再被本地挡住。 */
    void forgetLocalCloudMiss(kind, key);
};

export type AiCloudCachePull =
    | {
        status: 'hit';
        payload: unknown;
        /**
         * exact = 精确键命中（只有「没歌词可判」那一档才走这条路，见函数头）；
         * words = 靠高亮词认出来的：候选标的证据词在这段歌词里 **100%** 全在场；
         * forced = 没歌词可判，取服务端排序最靠前的一条 —— **未经证实**，不参与回填。
         */
        matched: 'exact' | 'words' | 'forced';
        /** words 命中时，答案原本存在哪个键上 —— 回填到自己这个键要用它。 */
        sourceKey?: string;
        /** 这一条是从本地那一层拿的，没有发出网络请求。 */
        local?: boolean;
    }
    | { status: 'miss' }
    | { status: 'unavailable' };

/** 按歌名搜到的候选：只有高亮词，没有 payload —— 判定的活在本机做。 */
interface ResolveCandidate {
    key: string;
    words: string[];
}

/**
 * 候选合不合规：**它标的高亮词，在你手上这段歌词里全都找得到**。
 *
 * 高亮词是模型照着歌词挑的 —— 一条照着别的歌做的答案，挑不出这首的词。所以这比
 * 「哈希必须一模一样」宽松得多（同一首歌换个版本的 LRC 就换一个哈希），又不会把
 * 另一首歌的答案错当成这首的。
 *
 * 比的时候压掉空白与大小写：LRC 里多一个空格不该判成「这不是同一个词」。
 */
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
 * 它们出现在歌词里说明不了任何事情。用户报的例子最典型：一个候选的高亮词是
 * `留住 / 我 / 什么 / 把 / 你`，而手上这首的歌词里「留住」和「把」根本不存在，
 * 光靠「我」「什么」「你」这三个就把另一首近亲的答案顶成了这首的主题
 * （覆盖率算出来 3/5，看着还挺像那么回事）。
 *
 * 只收到「显然没有区分度」这一层为止 —— 开始 / 结束 / 快乐 这类实词**不**进这张表：
 * 它到底是内容还是套话机器分不清，宁可放过也不误伤。表里全是压平后（去空白、转小写）
 * 的形式。
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
        .map(word => flattenForMatch(word))
        .filter(word => word.length >= MIN_EVIDENCE_WORD_LENGTH
            && !NON_EVIDENCE_WORDS.has(word))
);

/** 证据词的**总数与命中数**。判定与排序都只看这两个数，不再看整份词表。 */
const evidenceHits = (words: readonly string[], lyricText: string): { total: number; hits: number } => {
    const evidence = highlightEvidenceWords(words);
    const haystack = flattenForMatch(lyricText);
    if (evidence.length === 0 || !haystack) {
        return { total: evidence.length, hits: 0 };
    }
    let hits = 0;
    evidence.forEach((needle) => {
        if (haystack.includes(needle)) hits += 1;
    });
    return { total: evidence.length, hits };
};

/** 你手上这段歌词里**命中了几个**证据词。 */
export const countHighlightWordHits = (words: readonly string[], lyricText: string): number => (
    evidenceHits(words, lyricText).hits
);

/* 原来这里还有个「覆盖率」—— 命中数 / 证据词数 —— 用来在兜底里挑「最像的那条」。
 * 兜底删了它也跟着没用了：判合规只看**个数**（差一个就不算），比的时候比**命中数**
 * （都是 100% 时词多的那条更可信），没有哪个地方还需要一个 0~1 的比例。
 */

/**
 * 候选合不合规：**证据词必须在你手上这段歌词里 100% 全在场**，少一个都不行。
 *
 * 这条路收紧过三轮，一轮比一轮严，每一轮都是被真实例子推着走的：
 *  1. 最早是「覆盖率 ≥ 80%」—— 按比例放宽，词越多能缺越多（10 个词缺 2 个、
 *     20 个词缺 4 个都过），近亲之间互相撞上八成；
 *  2. 改成「按个数，最多缺一个」—— 还是出事：用户报的那例（风清云净）根本没走到
 *     这一步（覆盖率 3/5），是从兜底被捡走的；
 *  3. 现在 **100%**：差一个词就当「这条答案不是照着这份歌词做的」，重新生成。
 *
 * 代价是同一首歌的两份 LRC 差一个词（一句口白、翻译行不同）也可能判不上 ——
 * 用户拍板要的是准，不是全：宁可自己重生成一次，也不要拿一条照着别首歌做的高亮词。
 *
 * 空词表 / 全是虚词（total === 0）同样不合规：那不是「全都命中了」（0/0），
 * 是**没有凭据**。
 *
 * ⚠️ **别把「词少的答案」一刀切否掉**：模型常常只挑一两个词，只要它们都在歌词里，
 * 那样一条照样合规（试过反过来 —— 少于两个词一律判不合规 —— 上机是所有歌的高亮词
 * 显示都错）。
 */
export const highlightWordsPresent = (words: readonly string[], lyricText: string): boolean => {
    const { total, hits } = evidenceHits(words, lyricText);
    /* 没有证据词 ≠ 全都命中：那是没有凭据。 */
    return total > 0 && hits >= total;
};

/**
 * 一次 GET，把原始 payload 交回调用方（校验是调用方的事）。
 *
 * 只有「按已知键直接取一条」这种用法要它 —— 其余一律走 `pullAiCloudCache`，
 * 那条路还会按歌名兜底一层。
 */
export const fetchEntry = async (kind: AiCloudCacheKind, key: string): Promise<unknown> => {
    /* 本地先看：这条键取过一次就不用再打扰服务器。 */
    const local = await readLocalCloudEntry(kind, key);
    if (local) return local.payload;
    try {
        const response = await createAiFetch()(resolveAiCloudCacheUrl(kind, key), {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: withTimeout(),
        });
        if (!response.ok) return null;
        const data = await response.json().catch(() => null) as { hit?: unknown; entry?: unknown } | null;
        const entry = data?.entry;
        if (data?.hit !== true || !isPlainObject(entry) || !('payload' in entry)) return null;
        /* 取到就落本地。这条路取的是「按已知键」的一条，认它作 exact —— 内容有没有被
           早年的「强制匹配」污染，由调用方（按高亮词判定那一步）负责，不是这里。 */
        void writeLocalCloudEntry(kind, key, entry.payload, 'exact');
        return entry.payload;
    } catch {
        return null;
    }
};

const fetchResolveCandidates = async (
    kind: AiCloudCacheKind,
    songTitle: string,
): Promise<ResolveCandidate[]> => {
    try {
        const response = await createAiFetch()(resolveAiCloudResolveUrl(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ kind, songTitle }),
            signal: withTimeout(),
        });
        if (!response.ok) return [];
        const data = await response.json().catch(() => null) as { candidates?: unknown } | null;
        const list = Array.isArray(data?.candidates) ? data?.candidates : [];
        const out: ResolveCandidate[] = [];
        list.forEach((entry: unknown) => {
            if (!isPlainObject(entry)) return;
            const key = String(entry.key ?? '').trim().toLowerCase();
            if (!/^[a-f0-9]{32}$/.test(key)) return;
            const words = Array.isArray(entry.words)
                ? entry.words.filter((word): word is string => typeof word === 'string' && word.trim().length > 0)
                : [];
            out.push({ key, words });
        });
        return out;
    } catch {
        return [];
    }
};

/*
 * 这里原来有个「一条都不合规时挑最像的那条」的兜底，已经被删掉了。
 *
 * 它错在把**没有是非**当成了**谁更像**：一条候选的证据词在这首的歌词里只到一半，它不是
 * 「有点像这首的答案」，它就是**另一首歌的答案** —— 挑它当最像的，只会把别首歌的高亮
 * 词当成这首的，还会回填到精确键上，错一次就一直错下去（用户报的风清云净那例就是这样
 * 进来的：证据词 5 个只中 3 个，而且中的那 3 个是「我 / 什么 / 你」这种任何一首歌都有
 * 的词）。
 *
 * 现在的规矩是**只认 100%**：达标的一条都没有就回 miss，让本机照这首重新生成。
 * 「没歌词可判」那一档（纯音乐、按歌名+歌手存的主题）仍然取服务端排序最靠前的几条 ——
 * 那个不是「判出来不像」，是**没得判**。
 */

export interface AiCloudCachePushMeta {
    songTitle?: string;
    target?: AiCompletionTarget | null;
    /**
     * 这首歌来自哪个音乐平台（netease / qq / kugou …）。
     *
     * 服务端拿它去对应平台把歌词原文件取回来重算哈希；**本地歌曲没有平台**，那就留空，
     * 服务端会按顺序逐个平台试。这个字段只跟着上传走 —— 拉取那条链路照样只看 MD5 键，
     * 于是加了它也不影响早先推上去的那些条目。
     */
    platform?: string;
    /**
     * 歌词正文的 MD5（不含 policy）。
     *
     * 缓存键是「歌词 + policy」的 MD5，policy 里的屏蔽样式与自定义提示词只有本机能算，
     * 服务端算不出来 —— 所以另外带一份纯歌词的哈希给它对。老版本没有这个字段，
     * 服务端就按「无从校验」放行。
     */
    lyricHash?: string;
    /** 纯音乐：喂给模型的（也参与指纹的）是歌名而不是歌词正文。 */
    isPureMusic?: boolean;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const withTimeout = (): AbortSignal => {
    const controller = new AbortController();
    if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
        window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    }
    return controller.signal;
};

/**
 * 拉一次。
 *
 * **有歌词可判时（舞台那条链路）不读精确键**：把服务端按歌名送回来的候选**一次全判**，
 * 只留证据词 100% 在场的那几条，第一个到手的就是答案。
 *
 * 为什么不认精确键：键是「歌词 + policy」的 MD5，看着天衣无缝，可它里面躺着的那一份
 * 未必是照着这份歌词做的 —— 早年的「强制匹配 + 回填」把别的歌的答案写过来了（键是这首
 * 的，内容是别首的），之后每次都是精确命中，错一次就一直错下去。用户拍板：**高亮词
 * 才是准的，多个结果一起看，100% 才认**；精确键只留给「没得判」的那一档（见下）。
 *
 * **没歌词可判时**（主题按「歌名 + 歌手」存的那一路、纯音乐）无从判 —— 老路照旧：
 * 先按精确键问，没中就按歌名捞一条最靠前的（服务端已按「歌名全等优先、更新时间
 * 倒序」排过）。这一档不记 miss，否则用户看到的就是「云端明明有，就是匹配不上」。
 *
 * 出错一律当「没命中」，调用方照常生成。
 */
export const pullAiCloudCache = async (
    kind: AiCloudCacheKind,
    key: string,
    meta: { songTitle?: string; lyricText?: string } = {},
): Promise<AiCloudCachePull> => {
    if (!isFoliaCloudCacheEnabled()) return { status: 'unavailable' };
    if (!/^[a-f0-9]{32}$/.test(key)) return { status: 'unavailable' };

    const songTitle = String(meta.songTitle ?? '').trim();
    const lyricText = String(meta.lyricText ?? '');
    /* 有歌名又有歌词才判得动：两样缺一样就只剩「信键」或「信歌名」这两条老路。 */
    const judgeByWords = Boolean(songTitle && lyricText);

    /*
     * 本地先看。
     *
     * 本机存着这条答案就直接用 —— 不发请求、不走原生那一趟。有歌词可判时不认 `exact` 那一档：
     * 跟下面「不读精确键」是同一条纪律（精确键里的内容未必是这份歌词的），本地这一层不能
     * 把它绕过去。`words` / `own` 是认过的，照用。
     */
    const local = await readLocalCloudEntry(kind, key);
    if (local && (local.how !== 'exact' || !judgeByWords)) {
        return { status: 'hit', payload: local.payload, matched: local.how === 'words' ? 'words' : 'exact', local: true };
    }

    /* 本地记着「问过、云端没有」且还没过期：直接当没有，别去打服务器。 */
    if (await readLocalCloudMiss(kind, key)) return { status: 'miss' };

    if (wasRecentMiss(kind, key)) return { status: 'miss' };

    const url = resolveAiCloudCacheUrl(kind, key);
    let data: { hit?: unknown; entry?: unknown } | null = null;

    /*
     * 安卓先问原生。
     *
     * 那一次请求由 OkHttp 发出、答案留在原生侧，于是「网页发起 → 后台被冻住」这一整段
     * 都不再参与：原生把活干完，网页哪一步回来问都能拿到。没有这个方法（老版本 App）
     * 就照旧走下面那条。
     */
    /*
     * 整段包住，不只是 reject：取那个导出本身也可能抛（模块没加载出来时是同步的），
     * 而缓存的纪律是**永不阻塞功能** —— 这里出任何岔子都只是「这次没命中」。
     */
    /*
     * 精确键那一份**只在没得判的时候才读** —— 见函数头的说明：有歌词可判时它可能是
     * 被早年「强制匹配 + 回填」写进来的，键对了内容却不是这首的。
     */
    let native: { ok: boolean; body: string } | null = null;
    if (!judgeByWords) {
        try {
            native = await fetchAiCacheViaNative(key, url);
        } catch {
            native = null;
        }
    }
    if (native) {
        /* 原生真发了请求、服务端说没有：那就是没命中，不必再用网页那条再问一遍。 */
        if (!native.ok) {
            void rememberLocalCloudMiss(kind, key);
            return { status: 'miss' };
        }
        /* 原生回的是响应体原文：解析不出来就跟没命中一样，别让一条脏响应炸了整条链路。 */
        try {
            data = JSON.parse(native.body) as { hit?: unknown; entry?: unknown };
        } catch {
            data = null;
        }
    }

    if (!judgeByWords && !data) {
        try {
            const response = await createAiFetch()(url, {
                method: 'GET',
                headers: { Accept: 'application/json' },
                signal: withTimeout(),
            });
            /* 没命中不再当场返回 —— 下面还有一次按歌名捞的机会。 */
            if (response.ok) {
                data = await response.json().catch(() => null) as { hit?: unknown; entry?: unknown } | null;
            }
        } catch {
            data = null;
        }
    }

    const entry = data?.entry;
    if (data?.hit === true && isPlainObject(entry) && 'payload' in entry) {
        /* 云端给了就落本地：下次同键是本地命中，零请求。 */
        void writeLocalCloudEntry(kind, key, entry.payload, 'exact');
        return { status: 'hit', payload: entry.payload, matched: 'exact' };
    }

    /*
     * 不看哈希，看内容。
     *
     * 服务端按歌名把同类条目的高亮词送回来（小得多的响应），本机拿自己这段歌词逐条判
     * —— 判定留在本机，歌词正文一次都不用上传。
     */
    if (!songTitle) {
        rememberMiss(kind, key);
        void rememberLocalCloudMiss(kind, key);
        return { status: 'miss' };
    }

    const candidates = await fetchResolveCandidates(kind, songTitle);
    if (candidates.length === 0) {
        rememberMiss(kind, key);
        void rememberLocalCloudMiss(kind, key);
        return { status: 'miss' };
    }

    /*
     * 判定**一次做齐**，再去发请求。
     *
     * 歌名一样、歌词不一样的歌本来就是一堆近亲（翻唱、现场、各平台的 LRC 差几个字
     * 就是一个新键），候选一次能来十来个。原来是「判一个高亮词 → 拉一次」挨着串行，
     * 前面只要有一个慢、或者卡到 12 秒超时，后面明明合规的那条就一直排不上 —— 用户
     * 等的就是这一段。判定是本机字符串比较，零成本，先全筛完再一起问。
     *
     * 合规 = 证据词 **100%** 在场（highlightWordsPresent）。
     *
     * 有歌词却一条都不达标 → **miss**，让本机照这首重新生成：拿一条照着别首歌做的高亮
     * 词当这首的主题，比承认「云端没有」糟得多。
     */
    const batch = lyricText
        ? candidates
            .map((candidate, index) => ({ candidate, index }))
            /* 不达标的连排序都不参加 —— 「最像的那条」照样是另一首歌的答案。 */
            .filter(({ candidate }) => highlightWordsPresent(candidate.words, lyricText))
            /*
             * 达标的那几条**一起比，取证据词最多的**。
             *
             * 全都 100% 在场时，词越多越不可能是巧合：只挑了「小黄花」一条，同名曲的
             * 翻唱也能撞上；挑了六条还一条不落，那基本就是照着同一份歌词做的。
             * 词数一样时留服务端给的顺序（歌名全等优先、更新时间倒序），排序是稳定的。
             */
            .sort((a, b) => (
                countHighlightWordHits(b.candidate.words, lyricText)
                - countHighlightWordHits(a.candidate.words, lyricText)
                || a.index - b.index
            ))
            .slice(0, MAX_CONCURRENT_ENTRY_FETCHES)
            .map(({ candidate }) => candidate)
        /* 没歌词可判：信服务端给的排序，取最靠前那几条（见函数头那一档）。 */
        : candidates.slice(0, MAX_CONCURRENT_ENTRY_FETCHES);

    const payloads = await Promise.all(
        batch.map((candidate) => fetchEntry(kind, candidate.key)),
    );
    const index = payloads.findIndex((payload) => payload !== null);
    if (index >= 0) {
        /*
         * 这一条已经认过了，就落到**自己这个键**上：下次同键问本地即可。
         *
         * `lyricText` 在场是 words（高亮词 100% 验过），否则是 forced（只是最靠前那条）。
         * forced 不进本地 —— 它没被验证过，存下来等于把别人的答案钉在自己身上。
         */
        if (lyricText) void writeLocalCloudEntry(kind, key, payloads[index], 'words');
        return {
            status: 'hit',
            payload: payloads[index],
            /*
             * 'words' = 证据词 100% 验证过的（调用方据此回填）；
             * 'forced' = 没歌词可判、拿最靠前那条（不回填 —— 它没被验证过）。
             */
            matched: lyricText ? 'words' : 'forced',
            sourceKey: batch[index].key,
        };
    }

    rememberMiss(kind, key);
    void rememberLocalCloudMiss(kind, key);
    return { status: 'miss' };
};

/** 推一次。失败就当没发生过，绝不打断已经生成好的结果。 */
export const pushAiCloudCache = async (
    kind: AiCloudCacheKind,
    key: string,
    payload: unknown,
    meta: AiCloudCachePushMeta = {},
): Promise<boolean> => {
    if (!isFoliaCloudCacheEnabled()) return false;
    if (!/^[a-f0-9]{32}$/.test(key)) return false;

    try {
        const response = await createAiFetch()(resolveAiCloudCacheUrl(kind, key), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                payload,
                songTitle: meta.songTitle ?? '',
                provider: meta.target?.provider ?? '',
                model: meta.target?.model ?? '',
                platform: meta.platform ?? '',
                lyricHash: meta.lyricHash ?? '',
                isPureMusic: meta.isPureMusic === true,
            }),
            signal: withTimeout(),
        });
        /* 成功就地留一份：这首自己刚生成的，下次同键本地命中，不用再问服务器。 */
        if (response.ok) {
            forgetMiss(kind, key);
            void writeLocalCloudEntry(kind, key, payload, 'own');
        }
        return response.ok;
    } catch {
        return false;
    }
};

/**
 * 结果是哪儿来的。
 *
 * `local` 是本机存着的那一份（云缓存的本地层，零请求）—— 跟 `cloud` 分开，是因为界面上的
 * 提示不该让本地命中冒充「已从云端拉取缓存」，而它确实也没发请求。
 */
export type AiCloudCacheSource = 'cloud' | 'local' | 'ai';

/**
 * 唯一该被功能代码调用的那个入口：先问缓存，没有再生成，生成完回传。
 *
 * `validate` 是调用方自己的闸门 —— 缓存里的东西**一律当不可信输入**处理，
 * 形状不对就跟没命中一样。少了这一步，服务端一条脏数据就能把播放页搞崩。
 */
export const withAiCloudCache = async <T>(options: {
    kind: AiCloudCacheKind;
    fingerprint: string;
    generate: () => Promise<T>;
    validate: (value: unknown) => T | null;
    /**
     * 只生成出一半时，把云端已有的另一半并进去再回传。
     *
     * 部署端点与 Electron 这两条路只能出主题，出不了动画决策。不合并就整条覆盖，
     * 等于把别人推上来的完整条目抹成半截 —— 之后不管谁拉这条，动画那半永远是空的，
     * 导演于是再也没法切换样式，而缓存里明明有别人做好的决策。
     *
     * 传进来的 `previous` 是**没通过 validate** 的 payload（缺的正是这次要的那半），
     * 所以它照样要过一遍校验，脏数据不能跟着一起回传。
     */
    combine?: (previous: unknown, fresh: T) => T;
    songTitle?: string;
    /** 见 `AiCloudCachePushMeta`：平台名与歌词哈希只跟着上传走，不参与键。 */
    platform?: string;
    /** 歌词正文的 MD5。算得出来就带上，服务端好拿平台上的歌词对一遍。 */
    lyricHash?: string;
    /**
     * 歌词正文。**不会上传** —— 只在本机跟候选的高亮词对。
     *
     * 有它的时候拉缓存**不看精确键**（见 `pullAiCloudCache` 的函数头）：判得动就该以
     * 高亮词为准。没有它（主题那一路、纯音乐）才退回信键。
     */
    lyricText?: string;
    isPureMusic?: boolean;
    /**
     * 别去问云端，直接生成 —— 「重新判断」就是要一个跟缓存里不一样的答案。
     *
     * 少了这一条，force 只是跳过了进程内缓存，云端那份照样命中，用户点
     * 「重新判断」永远是同一个结果。
     */
    skipPull?: boolean;
}): Promise<{ value: T; source: AiCloudCacheSource }> => {
    const { kind, fingerprint, generate, validate, combine, songTitle, platform, lyricHash, lyricText, isPureMusic, skipPull } = options;

    let previous: unknown = null;
    if (!skipPull && isFoliaCloudCacheEnabled()) {
        const pulled = await pullAiCloudCache(kind, fingerprint, {
            songTitle,
            /* 纯音乐那半的「歌词」其实是歌名，别拿它去判高亮词。 */
            lyricText: isPureMusic ? '' : lyricText,
        });
        const validated = pulled.status === 'hit' ? validate(pulled.payload) : null;
        if (validated !== null) {
            /*
             * 按内容捞到的那条**回填**到自己这个键上。
             *
             * 同一份歌词下次还是同一个键 —— 不回填就得再走一遍「搜歌名 + 逐条判」，
             * 白花两次往返。回填的是库里已有的答案（不是新生成的），落哪个键都不影响
             * 别人，而命中率会实打实地涨。回填失败无所谓：反正这一次已经命中了。
             *
             * 本地命中的不再回推：本机早就有这一份，推上去纯属白给服务器加负载 ——
             * 而且要的就是「本地命中零请求」这件事。
             */
            if (pulled.status === 'hit' && pulled.matched === 'words' && !pulled.local) {
                void pushAiCloudCache(kind, fingerprint, validated, {
                    songTitle,
                    platform,
                    lyricHash,
                    isPureMusic,
                    target: describeAiTarget(),
                }).catch(() => false);
            }
            return { value: validated, source: pulled.status === 'hit' && pulled.local ? 'local' : 'cloud' };
        }
        /*
         * 本地存着的那一份没通过校验：它是脏的（老版本存的形状、或者上游改了格式），
         * 扔掉，让下一次老老实实回云端问。
         */
        if (pulled.status === 'hit' && pulled.local) void dropLocalCloudEntry(kind, fingerprint);
        /*
         * 没通过校验的那份也要留着 —— 它缺的正是这次要问的那一半，但它**有**这次
         * 生成不出来的那一半。丢掉就等于把已有的成果擦掉。
         */
        if (pulled.status === 'hit') previous = pulled.payload;
    }

    const value = await generate();
    void pushAiCloudCache(
        kind,
        fingerprint,
        combine ? combine(previous, value) : value,
        { songTitle, platform, lyricHash, isPureMusic, target: describeAiTarget() },
    );
    return { value, source: 'ai' };
};
