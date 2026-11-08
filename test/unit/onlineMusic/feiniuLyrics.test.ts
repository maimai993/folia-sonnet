import { describe, expect, it } from 'vitest';
import { dedupeRepeatedLrc, parseFeiniuLyrics, pickFeiniuLyricText } from '../../../src/services/onlineMusic/feiniuLyrics';

/*
 * #252：飞牛音乐「第一首正常，切歌后歌词一句重复很多遍」。
 *
 * 这里盯两件事：
 *   1. `preferred` 的两种语义（guid / 下标）都得选对 —— 只认一种会静默退回 list[0]；
 *   2. 整段被重复拼接时要收敛，但**副歌里同一句出现两次不能被删掉**。
 */

describe('pickFeiniuLyricText', () => {
    it('按 guid 选中 preferred 那条', () => {
        const payload = {
            list: [
                { guid: 'g1', content: '[00:01.00]原文' },
                { guid: 'g2', content: '[00:01.00]译文' },
            ],
            preferred: 'g2',
        };
        expect(pickFeiniuLyricText(payload)).toBe('[00:01.00]译文');
    });

    it('preferred 是下标时同样选得对', () => {
        const payload = {
            list: [
                { guid: 'g1', content: '[00:01.00]原文' },
                { guid: 'g2', content: '[00:01.00]译文' },
            ],
            preferred: 1,
        };
        expect(pickFeiniuLyricText(payload)).toBe('[00:01.00]译文');
    });

    it('preferred 是数字字符串也认', () => {
        const payload = {
            list: [
                { guid: 'g1', content: '[00:01.00]原文' },
                { guid: 'g2', content: '[00:01.00]译文' },
            ],
            preferred: '1',
        };
        expect(pickFeiniuLyricText(payload)).toBe('[00:01.00]译文');
    });

    it('preferred 指不到时退回第一条有内容的', () => {
        const payload = {
            list: [
                { guid: 'g1', content: '' },
                { guid: 'g2', content: '[00:01.00]有内容' },
            ],
            preferred: 'missing',
        };
        expect(pickFeiniuLyricText(payload)).toBe('[00:01.00]有内容');
    });

    it('preferred 指到一个空条目时，不要交出空歌词', () => {
        const payload = {
            list: [],
            preferred: 0,
        };
        expect(pickFeiniuLyricText(payload)).toBe('');

        const withEmpty = {
            list: [{ guid: 'g1', content: '' }, { guid: 'g2', content: '[00:01.00]第二条' }],
            preferred: 0,
        };
        expect(pickFeiniuLyricText(withEmpty)).toBe('[00:01.00]第二条');
    });
});

describe('dedupeRepeatedLrc', () => {
    const block = '[00:01.00]同一句\n[00:05.00]另一句';

    it('整段拼三份时收敛成一份', () => {
        const text = [block, block, block].join('\n');
        expect(dedupeRepeatedLrc(text)).toBe(block);
    });

    it('整段拼两份时也收敛', () => {
        const text = [block, block].join('\n');
        expect(dedupeRepeatedLrc(text)).toBe(block);
    });

    it('正常歌词原样返回', () => {
        const text = '[00:01.00]第一句\n[00:05.00]第二句\n[00:09.00]第三句';
        expect(dedupeRepeatedLrc(text)).toBe(text);
    });

    it('副歌里同一句出现两次不能被删', () => {
        const text = '[00:01.00]副歌\n[00:05.00]主歌\n[00:09.00]副歌';
        expect(dedupeRepeatedLrc(text)).toBe(text);
    });

    it('纯文本（无时间戳）原样返回', () => {
        const text = '第一句\n第二句';
        expect(dedupeRepeatedLrc(text)).toBe(text);
    });
});

describe('parseFeiniuLyrics', () => {
    it('正常 LRC 解析出句子', () => {
        const result = parseFeiniuLyrics('[00:01.00]第一句\n[00:05.00]第二句');
        expect(result.lyrics?.lines.map(line => line.fullText)).toEqual(['第一句', '第二句']);
        expect(result.isPureMusic).toBe(false);
    });

    it('整段重复的歌词解析后不出现相邻同时间戳', () => {
        const block = '[00:01.00]同一句\n[00:05.00]另一句';
        const result = parseFeiniuLyrics([block, block, block].join('\n'));
        const lines = result.lyrics?.lines ?? [];
        expect(lines.map(line => line.fullText)).toEqual(['同一句', '另一句']);
        const times = lines.map(line => line.startTime);
        const adjacentDup = times.filter((t, i) => i > 0 && t === times[i - 1]).length;
        expect(adjacentDup).toBe(0);
    });

    it('空文本不给歌词', () => {
        const result = parseFeiniuLyrics('');
        expect(result.lyrics).toBeNull();
        expect(result.mainText).toBeNull();
    });
});
