import type { LyricData } from '../../types';

// src/services/bilibili/subtitleFilter.ts
// 这条投稿的「字幕」到底能不能当歌词用。
//
// 为什么要有这一步：这一家的字幕是投稿者自己上传或机器生成的，内容五花八门。实测过
// 几首 MV，常见的是 `♪音乐♪`、`[音乐]`、`（前奏）` 这类占位行，整份字幕就一句；
// 也有整份都是「请关注 UP 主」这种无关文字。把它们当成歌词摆上去，比没有歌词更糟 ——
// 屏幕上会一直挂着同一句，看起来像歌词卡住了。

/** 音乐占位行的样子：`♪音乐♪`、`[音乐]`、（Music）、`◆音乐◆` 之类。 */
const MUSIC_PLACEHOLDER = /^[\s♪♫★☆◆◇■□●○◆\-—=~～[\]（）()【】·、,，.。!！?？]*\s*(?:音乐|music|музыка|instrumental|前奏|间奏|尾奏|纯音乐|伴奏)\s*[\s♪♫★☆◆◇■□●○◆\-—=~～[\]（）()【】·、,，.。!！?？]*$/iu;

/**
 * 「纯 音 乐 欣 赏」这类：字之间被空格或符号隔开，光看整句对不上。
 *
 * 实测确实有投稿把这一行当字幕上传（就是那句「纯 音 乐 欣 赏」）。判法是先把
 * 非文字的东西全去掉，再看剩下的是不是那几个词之一。
 */
const PLACEHOLDER_WORDS = new Set([
    '音乐', '纯音乐', '音乐欣赏', '纯音乐欣赏', '欣赏', 'music', 'instrumental',
    '前奏', '间奏', '尾奏', '伴奏', '无歌词', '没有歌词',
]);

/**
 * 一行算不算「歌词」。
 *
 * 占位行、空行、纯符号行都不算。只判这一行，整份的判断见 `hasRealLyrics`。
 */
const isLyricLine = (text: string): boolean => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (MUSIC_PLACEHOLDER.test(trimmed)) return false;
    // 只剩标点或符号的行（`...`、`~~~`、`♪♪♪`）。
    if (!/[\p{L}\p{N}]/u.test(trimmed)) return false;
    // 「纯 音 乐 欣 赏」：把符号和空格去掉之后看是不是整句都是那几个词。
    const squashed = trimmed.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
    if (PLACEHOLDER_WORDS.has(squashed)) return false;
    return true;
};

/**
 * 这份字幕里有没有真歌词。
 *
 * 判据：至少两行，且**真正的歌词行**不少于两行。一行都没有、或者只有一句
 * `♪音乐♪` 的，一律当成「没有字幕」，让调用方退回原来的歌词来源。
 */
export const hasRealLyrics = (lyrics: LyricData | null | undefined): boolean => {
    if (!lyrics) return false;
    const real = lyrics.lines.filter(line => isLyricLine(line.fullText ?? '')).length;
    return real >= 2;
};

/**
 * 把没有实际内容的行去掉，留下能当歌词的那些。
 *
 * 顺手合并掉留下的空档：占位行原本占着几秒，删掉后不该让歌词凭空停在那里。
 * `LyricData` 的行用毫秒，所以时间也是毫秒。
 */
export const stripPlaceholderLines = (lyrics: LyricData): LyricData => {
    const kept = lyrics.lines.filter(line => isLyricLine(line.fullText ?? ''));
    if (kept.length === lyrics.lines.length) return lyrics;
    return { ...lyrics, lines: kept };
};
