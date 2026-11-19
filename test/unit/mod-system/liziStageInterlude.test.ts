// LIZI 舞台桥接：间奏行（fullText 是 '......'）不能当成一句歌词演出来，要并回上一句。
import { describe, expect, it } from 'vitest';
import { linesToLizi } from '../../../public/mods/builtin/lizi-stages/host.mjs';

type TestLine = {
    fullText: string;
    startTime: number;
    endTime: number;
    words: Array<{ text: string; startTime: number; endTime: number }>;
};

const lyricLine = (fullText: string, startTime: number, endTime: number): TestLine => ({
    fullText,
    startTime,
    endTime,
    words: [{ text: fullText, startTime, endTime }],
});

// 与 parserCore 的 attachInterludes 同形：单独一行，fullText 是 INTERLUDE_FULL_TEXT。
const interludeLine = (startTime: number, endTime: number): TestLine => ({
    fullText: '......',
    startTime,
    endTime,
    words: Array.from({ length: 6 }, (_, index) => ({
        text: '.',
        startTime: startTime + (index * (endTime - startTime)) / 6,
        endTime: startTime + ((index + 1) * (endTime - startTime)) / 6,
    })),
});

describe('lizi linesToLizi', () => {
    it('间奏行不单独成行，上一句一直显示到间奏结束', () => {
        const rows = linesToLizi([
            lyricLine('第一句', 5, 8),
            interludeLine(8.05, 19.95),
            lyricLine('第二句', 20, 23),
        ], undefined);

        expect(rows.map((row: { text: string }) => row.text)).toEqual(['第一句', '第二句']);
        // 第一句的 dur 延到第二句开始（20），间奏期间舞台停在第一句上。
        expect(rows[0]).toMatchObject({ t: 5, dur: 15 });
        expect(rows[1]).toMatchObject({ t: 20, dur: 3 });
    });

    it('没有任何行是间奏行时，dur 仍是到下一句开始', () => {
        const rows = linesToLizi([lyricLine('A', 5, 8), lyricLine('B', 10, 14)], undefined);

        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ t: 5, dur: 3 });
        expect(rows[1]).toMatchObject({ t: 10, dur: 4 });
    });

    it('首句之前的 intro 间奏行直接丢掉，不留空行', () => {
        const rows = linesToLizi([interludeLine(0.5, 4.5), lyricLine('首句', 5, 8)], undefined);

        expect(rows.map((row: { text: string }) => row.text)).toEqual(['首句']);
        expect(rows[0]).toMatchObject({ t: 5, dur: 3 });
    });

    it('只由点组成但不是间奏的行（例如省略号歌词）保持原样', () => {
        const rows = linesToLizi([lyricLine('……', 5, 8), lyricLine('后面', 10, 12)], undefined);

        expect(rows.map((row: { text: string }) => row.text)).toEqual(['……', '后面']);
    });
});
