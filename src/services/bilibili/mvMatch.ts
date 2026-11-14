import type { BilibiliSearchHit } from '../../types/bilibili';

// src/services/bilibili/mvMatch.ts
//
// 从一次搜索的结果里挑出「这首」歌该配哪条投稿。
//
// 搜索词是拼出来的，结果里混着翻唱、伴奏、教程、合集，直接取第一条基本必翻车。
// 这里做的是纯粹的打分 + 过滤，不碰网络，好测。

/** 标题里出现这些词的投稿通常不是「这首歌的官方 / 完好 MV」。 */
const PENALTY_WORDS = [
    '翻唱', '翻自', 'cover', '翻弹', '钢琴', '吉他', '指弹', '尤克里里',
    '伴奏', 'instrumental', 'off vocal', 'karaoke', '卡拉ok',
    '教程', '教学', '反应', 'reaction', '解说', 'reupload',
    '纯音乐', '8bit', 'remix', 'dj版', '慢摇',
];

/** 标题里出现这些词说明是合集 / 切片，往往不是完整 MV。 */
const MIX_WORDS = ['合集', '合辑', 'playlist', '歌单', '连播', '精选'];

const normalize = (text: string): string => text
    .toLowerCase()
    // 全角转半角括号常见于中日文标题，统一掉，免得「（Official）」匹配不上「(official)」
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    /*
     * 标点与符号一律换成空格再合并：歌名里带 `&`、`'`、`-`、`.`、`·` 的很多，
     * 标题那边写法又各不相同（「Don't Stop」/「Dont Stop」/「Don’t Stop」）。
     * 不去掉的话 `includes` 会因为一个弯引号就整条失配 —— 这就是以前「太严格」的主因。
     */
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/[\s\u3000]+/g, ' ')
    .trim();

/** 分词：按空格切开，丢掉单个字符（「a」「的」这种不承担识别作用）。 */
const tokenize = (text: string): string[] => text
    .split(' ')
    .map(token => token.trim())
    .filter(token => token.length >= 2);

/**
 * 歌名是否算「命中了」这条标题。
 *
 * 以前是整串 `includes`：歌名一字不差地连着出现才算。实际标题里有「《歌名》」
 * 「歌名 - 歌手」「【中字】歌名」这些写法，整串比对把很多明明就是同一首歌的结果挡在外面。
 *
 * 现在的规则：
 * - 整串出现在标题里 —— 直接算命中（最可信）；
 * - 否则按词比：歌名切成词后，**至少八成**的词在标题里出现。短歌名（一个词）
 *   仍然要求整串，不然「The」「Cure」这种会到处误中。
 */
const titleMatches = (title: string, songTitle: string): boolean => {
    if (!songTitle) return false;
    if (title.includes(songTitle)) return true;
    const songWords = tokenize(songTitle);
    // 只有一个词（或切不出词）时不做放宽：单词到处都能撞上，放宽了全是噪音。
    if (songWords.length < 2) return false;
    const hitCount = songWords.filter(word => title.includes(word)).length;
    return hitCount / songWords.length >= 0.8;
};

/** 命中一个词就给一次惩罚；同一类里只算一次，免得被同一个词反复扣。 */
const countWordHits = (haystack: string, words: readonly string[]): number => {
    let hits = 0;
    for (const word of words) {
        if (haystack.includes(word)) hits += 1;
    }
    return hits;
};

export interface MvMatchInput {
    title: string;
    artist: string;
    /** 歌曲时长（秒）。0 表示不知道。 */
    durationSec?: number;
}

export interface MvMatchScore {
    hit: BilibiliSearchHit;
    score: number;
    /** 标题里出现了歌名。 */
    titleHit: boolean;
    /** 标题或作者里出现了歌手名。 */
    artistHit: boolean;
}

/**
 * 给一条搜索结果打分。分越高越像「这首歌的 MV」。
 *
 * 打分维度：
 * - 标题里有没有歌名（最关键）
 * - 作者 / 标题里有没有歌手名（投稿者常常就是官方号）
 * - 时长是否接近（MV 一般和歌曲差不了太多，合集动辄一小时）
 * - 有没有被惩罚词命中
 */
export const scoreMvHit = (hit: BilibiliSearchHit, input: MvMatchInput): MvMatchScore => {
    const title = normalize(hit.title);
    const author = normalize(hit.author);
    const songTitle = normalize(input.title);
    const songArtist = normalize(input.artist);

    let score = 0;

    const titleHit = titleMatches(title, songTitle);
    if (titleHit) score += 60;

    // 歌手名同样按分词比（「Lady Gaga」写成「LadyGaga」「Lady Gaga」都要能中）。
    const artistHit = songArtist.length > 0
        && (titleMatches(title, songArtist) || title.includes(songArtist) || author.includes(songArtist));
    if (artistHit) score += 30;

    // 时长：越接近越高分，超过两倍或不到一半就基本排除。
    if (input.durationSec && input.durationSec > 0 && hit.durationSec > 0) {
        const ratio = hit.durationSec / input.durationSec;
        if (ratio >= 0.5 && ratio <= 2) {
            score += Math.round(20 * (1 - Math.min(1, Math.abs(ratio - 1))));
        } else {
            score -= 40;
        }
    }

    score -= countWordHits(title, PENALTY_WORDS) * 45;
    score -= countWordHits(title, MIX_WORDS) * 30;

    // 播放量给一点点加分：同样像的两条，更出名的那条更可能是正片。
    // 取对数免得高播放量的合集把正经 mv 压死。
    if (hit.playCount > 0) {
        score += Math.min(12, Math.round(Math.log10(hit.playCount) * 2));
    }

    return { hit, score, titleHit, artistHit };
};

/**
 * 从搜索结果里挑一条，挑不到就回 null。
 *
 * 门槛：标题必须命中歌名（否则「随便来一条」比没有更糟）。
 */
export const pickBestMvHit = (
    hits: readonly BilibiliSearchHit[],
    input: MvMatchInput,
): BilibiliSearchHit | null => {
    const scored = hits
        .map(hit => scoreMvHit(hit, input))
        .filter(item => item.titleHit)
        .sort((a, b) => b.score - a.score);
    if (scored.length === 0) return null;
    if (scored[0].score <= 0) return null;
    return scored[0].hit;
};

/** 拼搜索词：`歌名 歌手`，去掉会让结果跑偏的符号。 */
export const buildSearchKeyword = (title: string, artist: string, extra = ''): string => {
    const parts = [title, artist, extra]
        .map(part => part.trim())
        .filter(part => part.length > 0);
    return parts.join(' ').replace(/[\\"《》""]/g, ' ').replace(/\s+/g, ' ').trim();
};
