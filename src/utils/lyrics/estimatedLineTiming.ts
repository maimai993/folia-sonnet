import type { Word } from '../../types';
import { splitLyricGraphemes } from './graphemeTiming';

// Estimates word timing for line-synced lyrics, shared by the parsers and visualizers without the full parser.

/**
 * 标点的权重：它不发声，但演唱者确实在这里换气。
 *
 * 原来是 0（只推进 0.05 秒），一行「你好，世界」里逗号几乎不占时间，于是前一个字刚亮完
 * 就跳到下一个字 —— 听感上就是「歌词比人声赶」；而句尾的「。」又白白吃掉半个字的时间。
 * 三分之一字是实测下来最接近听感的值：中文一句话里的逗号停顿约 100~200 ms，
 * 慢歌一个字本来就 0.4~0.6 秒。
 */
const PUNCT_WEIGHT = 0.32;
/** 中日韩标点与全角符号。 */
const CJK_PUNCT = /[\u3000-\u303f\uff00-\uffef]/;
/** 拉丁标点里真正会让人停一下的那些（连字符、撇号不算）。 */
const LATIN_PUNCT = /[,.!?;:…—–]/;

/** Spreads a line-synced lyric over evenly weighted tokens: one per CJK character, one per spaced word otherwise. */
export const buildTimedWords = (text: string, startTime: number, endTime: number): Word[] => {
    const duration = Math.max(endTime - startTime, 0.1);
    const rawTokens = text.split(/\s+/).filter(token => token);
    const words: Word[] = [];
    const tokens: Array<{ text: string; weight: number }> = [];
    let totalWeight = 0;

    for (const token of rawTokens) {
        if (/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/.test(token)) {
            // By grapheme, not UTF-16 unit: an emoji or a CJK Extension B character stays one token.
            splitLyricGraphemes(token).forEach(char => {
                if (CJK_PUNCT.test(char) || LATIN_PUNCT.test(char)) {
                    /*
                     * 标点并进前一个词，而不是自己成一个词。
                     *
                     * 单独成词的话，逐字高亮会在「，」上闪一下 —— 那个字根本不发音。
                     * 并进去之后，前一个字的亮色多撑一个换气的时间，节奏正好对上。
                     * 行首就是标点（罕见的歌词排版）时没有前一个词可并，按 0 权重留着。
                     */
                    const previous = tokens[tokens.length - 1];
                    if (previous) {
                        previous.text += char;
                        previous.weight += PUNCT_WEIGHT;
                        totalWeight += PUNCT_WEIGHT;
                    } else {
                        tokens.push({ text: char, weight: 0 });
                    }
                    return;
                }
                tokens.push({ text: char, weight: 1 });
                totalWeight += 1;
            });
        } else {
            // 拉丁词按字母数给权重，但别让它比中文短：原来是 1 + 0.15×字母数，
            // 十来个字母的单词会被摊到一秒多，而它唱出来只要半秒。
            const weight = 0.85 + token.length * 0.09;
            tokens.push({ text: token, weight });
            totalWeight += weight;
        }
    }

    if (totalWeight === 0) {
        totalWeight = 1;
    }

    /*
     * 行尾留一点白，但别按比例留：一行十秒的歌词按 10% 要留一秒，听起来像整句都慢了半拍。
     * 0.4 秒封顶，短行按 10% 走。
     */
    const tail = Math.min(0.4, duration * 0.1);
    const activeDuration = Math.max(duration - tail, duration * 0.5);
    const timePerWeight = activeDuration / totalWeight;
    let currentWordStart = startTime;

    tokens.forEach(token => {
        const wordDuration = token.weight * timePerWeight;
        const finalDuration = Math.max(wordDuration, 0.05);

        words.push({
            text: token.text,
            startTime: currentWordStart,
            endTime: currentWordStart + finalDuration
        });

        currentWordStart += Math.max(wordDuration, 0.05);
    });

    if (words.length > 0) {
        const lastWord = words[words.length - 1];
        if (lastWord.endTime > endTime) {
            const scale = (endTime - startTime) / (lastWord.endTime - startTime);
            words.forEach(word => {
                word.startTime = startTime + ((word.startTime - startTime) * scale);
                word.endTime = startTime + ((word.endTime - startTime) * scale);
            });
        }
    }

    return words;
};

/**
 * End time of a line-synced LRC line: the next line's start, but a line followed by a long gap ends after
 * a reading-time estimate so its sweep keeps a natural pace and the gap becomes an interlude.
 */
export const estimateLrcLineEndTime = (text: string, startTime: number, nextStartTime: number | undefined): number => {
    let duration = nextStartTime !== undefined ? nextStartTime - startTime : 5;
    const estimatedReadingTime = text.length * 0.5;
    if (duration > estimatedReadingTime + 2 && duration > 5) {
        duration = Math.min(duration, estimatedReadingTime + 2);
    }

    return startTime + duration;
};
