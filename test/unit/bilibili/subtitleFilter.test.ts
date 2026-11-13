import { describe, expect, it } from 'vitest';
import { hasRealLyrics, stripPlaceholderLines } from '../../../src/services/bilibili/subtitleFilter';
import type { LyricData } from '../../../src/types';

// src/services/bilibili/subtitleFilter.ts 的护栏。
//
// 样本是实测抓回来的：这一家的字幕经常不是歌词，`♪音乐♪`、`纯 音 乐 欣 赏`
// 这类占位行很常见。把它们当歌词摆上去，屏幕上会一直挂着同一句，看着像卡住了。
// 所以「有没有真歌词」这个判断值得钉死。

const line = (text: string, startTime = 0): LyricData['lines'][number] => ({
    fullText: text,
    startTime,
    endTime: startTime + 1000,
    words: [],
});

const lyricsOf = (...texts: string[]): LyricData => ({
    lines: texts.map((text, index) => line(text, index * 1000)),
});

describe('B 站字幕里哪些算歌词', () => {
    it('把占位行当成没有歌词', () => {
        expect(hasRealLyrics(lyricsOf('♪音乐♪'))).toBe(false);
        expect(hasRealLyrics(lyricsOf('[音乐]'))).toBe(false);
        expect(hasRealLyrics(lyricsOf('（前奏）'))).toBe(false);
    });

    it('认出字之间被空格隔开的「纯 音 乐 欣 赏」', () => {
        // 实测确实有投稿把这一行当字幕上传。
        expect(hasRealLyrics(lyricsOf('纯 音 乐 欣 赏'))).toBe(false);
        expect(hasRealLyrics(lyricsOf('纯音乐欣赏'))).toBe(false);
    });

    it('一句真歌词也不够：只有一行时当成没有', () => {
        expect(hasRealLyrics(lyricsOf('♪音乐♪', '这一句是真歌词'))).toBe(false);
    });

    it('两行以上真歌词才算数', () => {
        expect(hasRealLyrics(lyricsOf('第一句', '第二句'))).toBe(true);
    });

    it('只有符号和空白的行不算歌词', () => {
        expect(hasRealLyrics(lyricsOf('...', '~~~', '♪♪♪'))).toBe(false);
    });

    it('没有歌词对象就是没有', () => {
        expect(hasRealLyrics(null)).toBe(false);
        expect(hasRealLyrics(undefined)).toBe(false);
    });
});

describe('剔除占位行', () => {
    it('留下真歌词，去掉占位的那几行', () => {
        const cleaned = stripPlaceholderLines(lyricsOf('♪音乐♪', '第一句', '[音乐]', '第二句'));
        expect(cleaned.lines.map(item => item.fullText)).toEqual(['第一句', '第二句']);
    });

    it('本来就干净的时候原样返回同一个对象', () => {
        const original = lyricsOf('第一句', '第二句');
        expect(stripPlaceholderLines(original)).toBe(original);
    });
});
