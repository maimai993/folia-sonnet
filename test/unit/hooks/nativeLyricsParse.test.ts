// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseLrcLines, toLyricData } from '../../../src/hooks/useNativeLyricsSubscription';
import { buildDisplayWordsFromLayoutUnits, buildPostLyricLayoutUnits } from '../../../src/utils/lyrics/cjkSemanticLayout';

// test/unit/hooks/nativeLyricsParse.test.ts
// 原生推来的歌词要变成界面能用的行。**纯解析**：这里不测「该不该换歌词」（那归原生），
// 只测把一份 LRC 翻成行的规则 —— 翻错了表现为「歌词能显示但时机不对」，
// 在真机上极难一眼看出是解析的问题。

describe('native lyric parsing', () => {
    it('把时间戳翻成秒', () => {
        const lines = parseLrcLines('[00:12.50]第一句\n[01:05.25]第二句', '');
        expect(lines).toHaveLength(2);
        expect(lines[0].startTime).toBeCloseTo(12.5, 3);
        expect(lines[1].startTime).toBeCloseTo(65.25, 3);
        expect(lines[0].fullText).toBe('第一句');
    });

    it('一行多个时间戳展开成多行', () => {
        // 各家平台常见形态：副歌复用同一句词，用多个时间戳标注。
        const lines = parseLrcLines('[00:10.00][00:30.00]副歌', '');
        expect(lines.map(l => l.startTime)).toEqual([10, 30]);
        expect(lines.every(l => l.fullText === '副歌')).toBe(true);
    });

    it('翻译按时间戳对齐到主行', () => {
        const lines = parseLrcLines('[00:10.00]hello\n[00:20.00]world', '[00:10.00]你好\n[00:20.00]世界');
        expect(lines[0].translation).toBe('你好');
        expect(lines[1].translation).toBe('世界');
    });

    it('翻译缺失时留空而不是错位到下一条', () => {
        const lines = parseLrcLines('[00:10.00]a\n[00:20.00]b', '[00:20.00]B');
        expect(lines[0].translation).toBe('');
        expect(lines[1].translation).toBe('B');
    });

    it('按时间排序，即使原文是乱序的', () => {
        const lines = parseLrcLines('[00:30.00]后\n[00:10.00]前', '');
        expect(lines.map(l => l.fullText)).toEqual(['前', '后']);
    });

    it('每行的结束时间接下一行的开始', () => {
        const lines = parseLrcLines('[00:10.00]a\n[00:14.00]b', '');
        expect(lines[0].endTime).toBeCloseTo(14, 3);
        // 最后一行没有下一行可接，给一段兜底长度，不能等于开始时间（否则零时长行不显示）。
        expect(lines[1].endTime).toBeGreaterThan(lines[1].startTime);
    });

    it('没有时间戳的行被丢掉', () => {
        // 平台偶尔在开头返回 `[by:xxx]` 这类元信息，它不是歌词。
        const lines = parseLrcLines('[by:someone]\n[00:10.00]真的词', '');
        expect(lines.map(l => l.fullText)).toEqual(['真的词']);
    });

    it('普通歌词有可供经典和云阶主画面绘制的词块，而不只是字幕文本（#165）', () => {
        const data = toLyricData('[00:12]真实歌词\n[00:15]第二行', '')!;
        expect(data.isWordByWord).toBe(false);
        for (const line of data.lines) {
            expect(line.words.length).toBeGreaterThan(0);
            expect(line.words.map(word => word.text).join('')).toBe(line.fullText);
            expect(line.renderHints).toBeDefined();
            const display = buildDisplayWordsFromLayoutUnits(buildPostLyricLayoutUnits(line, { semantic: true, sticky: true }));
            expect(display.length).toBeGreaterThan(0);
        }
    });

    it('原生网易 YRC 保留毫秒逐字时间、行时长与翻译（#165）', () => {
        const data = toLyricData('[12000,3000](12000,1500,0)第一(13500,1500,0)句\n[15000,2000](15000,2000,0)第二句', '[00:12.000]first')!;
        expect(data.isWordByWord).toBe(true);
        expect(data.lines).toHaveLength(2);
        expect(data.lines[0]).toMatchObject({ startTime: 12, endTime: 15, fullText: '第一句', translation: 'first' });
        expect(data.lines[0].words).toEqual([
            { text: '第一', startTime: 12, endTime: 13.5 },
            { text: '句', startTime: 13.5, endTime: 15 },
        ]);
    });

    it('空歌词返回 null，界面据此显示「暂无歌词」', () => {
        expect(toLyricData('', '')).toBeNull();
        expect(toLyricData('[by:x]', '')).toBeNull();
    });
});
