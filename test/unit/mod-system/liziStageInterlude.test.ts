// LIZI 舞台桥接：间奏行（parserCore 的 attachInterludes 插进来的占位行）不能当成一句歌词演出来，
// 要并回上一句；字面就是 '......' 的真歌词不能被一起吞掉；首句之前的 intro 期间不能没有当前行。
import { describe, expect, it } from 'vitest';
import { linesToLizi } from '../../../public/mods/builtin/lizi-stages/host.mjs';
import { attachInterludes, INTERLUDE_FULL_TEXT } from '../../../src/utils/lyrics/parserCore';
import type { Line } from '../../../src/types';

type Row = { t: number; dur: number; text: string; chars: Array<{ c: string }> | null };

const lyricLine = (fullText: string, startTime: number, endTime: number): Line => ({
    fullText,
    startTime,
    endTime,
    words: [{ text: fullText, startTime, endTime }],
});

// 行级歌词：只有行时间、没有词级时间的那种行。
const plainLine = (fullText: string, startTime: number, endTime: number): Line => ({
    fullText,
    startTime,
    endTime,
    words: [],
});

// 用真 parser 的 attachInterludes 生成占位行，而不是手抄一份形状：isInterlude 标记和六个 '.' 的词
// 都跟着 parser 走。注意它会给传进去的每一行补 renderHints / words，所以输入一律用完整行。
const withInterludes = (lines: Line[]): Line[] => attachInterludes(lines);

// 舞台页取当前行的口径（001 的 while 循环 / 505 的 idxAt 都是「最后一个 t <= time」），照抄一份。
const idxAt = (rows: Row[], time: number): number => {
    let best = -1;
    for (let i = 0; i < rows.length; i++) if (rows[i].t <= time + 0.02) best = i;
    return best;
};

const texts = (rows: Row[]) => rows.map((row) => row.text);

describe('lizi linesToLizi: 间奏行', () => {
    it('句中间奏不单独成句，上一句一直显示到间奏结束', () => {
        const rows: Row[] = linesToLizi(withInterludes([
            lyricLine('第一句', 5, 8),
            lyricLine('第二句', 20, 23),
        ]), undefined);

        expect(texts(rows)).toEqual(['第一句', '第二句']);
        // 第一行按首行约定从 0 起算（见下面 intro 那组），dur 覆盖中间那段间奏。
        expect(rows[0]).toMatchObject({ t: 0, dur: 15 });
        expect(rows[1]).toMatchObject({ t: 20, dur: 3 });
    });

    it('连续两个间奏行只并进上一句一次', () => {
        // parser 不会连着插两行，但删行规则之后这种表能出现：真歌词 + 两条占位行 + 真歌词。
        const [intro, first, gap, second] = withInterludes([
            plainLine('第一句', 5, 8),
            plainLine('第二句', 20, 23),
        ]);
        expect(intro.isInterlude).toBe(true);
        expect(gap.isInterlude).toBe(true);
        const rows: Row[] = linesToLizi([first, gap, gap, second], undefined);

        expect(texts(rows)).toEqual(['第一句', '第二句']);
        expect(rows[0]).toMatchObject({ t: 0, dur: 15 });
        expect(rows[1]).toMatchObject({ t: 20, dur: 3 });
    });

    it('尾部间奏：最后一句止于自己的 endTime，不往后拖', () => {
        const rows: Row[] = linesToLizi(withInterludes([lyricLine('唯一一句', 1, 4)]), undefined);

        expect(texts(rows)).toEqual(['唯一一句']);
        expect(rows[0]).toMatchObject({ t: 0, dur: 3 });
    });

    it('只剩 intro 间奏、没有任何真歌词：输出空数组（舞台显示「这首没有歌词」）', () => {
        const onlyIntro = withInterludes([lyricLine('一句', 8, 11)]).filter((line) => line.isInterlude === true);

        expect(onlyIntro).toHaveLength(1);
        expect(linesToLizi(onlyIntro, undefined)).toEqual([]);
        expect(linesToLizi([], undefined)).toEqual([]);
    });

    it('行级（无 words）歌词夹间奏：保留两行，dur 覆盖间奏', () => {
        const rows: Row[] = linesToLizi(withInterludes([
            plainLine('行级一句', 1, 4),
            plainLine('行级二句', 10, 13),
        ]), undefined);

        expect(texts(rows)).toEqual(['行级一句', '行级二句']);
        expect(rows[0]).toMatchObject({ t: 0, dur: 9 });
        expect(rows[1]).toMatchObject({ t: 10, dur: 3 });
        expect(rows[0].chars).toBeNull();
    });

    it('真歌词的字面 ......（行级，无词级时间）不被吞掉', () => {
        // applyLyricLineRules 删行后带 includeInterludes:true 重新生成间奏，这里造的就是那种表。
        // 句间隔都不到 3 秒，parser 不会插占位行；整表就是三条「字面都是点」的真歌词。
        const rows: Row[] = linesToLizi(withInterludes([
            plainLine(INTERLUDE_FULL_TEXT, 1, 3),
            plainLine(INTERLUDE_FULL_TEXT, 5, 7),
            plainLine(INTERLUDE_FULL_TEXT, 9, 11),
        ]), undefined);

        expect(texts(rows)).toEqual([INTERLUDE_FULL_TEXT, INTERLUDE_FULL_TEXT, INTERLUDE_FULL_TEXT]);
        expect(rows[0]).toMatchObject({ t: 0, dur: 2 });
        expect(rows[1]).toMatchObject({ t: 5, dur: 2 });
        expect(rows[2]).toMatchObject({ t: 9, dur: 2 });
    });

    it('字面 ...... 的真歌词夹着真实间奏时，只并间奏、不吞真歌词', () => {
        const rows: Row[] = linesToLizi(withInterludes([
            plainLine(INTERLUDE_FULL_TEXT, 1, 3),
            plainLine(INTERLUDE_FULL_TEXT, 8, 10),
            plainLine('后面', 15, 18),
        ]), undefined);

        expect(texts(rows)).toEqual([INTERLUDE_FULL_TEXT, INTERLUDE_FULL_TEXT, '后面']);
        // 第二条真歌词后面跟着 5 秒空白，被 parser 插了占位行，所以撑到「后面」开始。
        expect(rows[1]).toMatchObject({ t: 8, dur: 7 });
    });

    it('真歌词的字面 ......（有词级时间）不被吞掉', () => {
        const rows: Row[] = linesToLizi(withInterludes([
            lyricLine(INTERLUDE_FULL_TEXT, 1, 4),
            lyricLine('后面', 6, 9),
        ]), undefined);

        expect(texts(rows)).toEqual([INTERLUDE_FULL_TEXT, '后面']);
        expect(rows[0]).toMatchObject({ t: 0, dur: 3 });
        expect(rows[0].chars).toHaveLength(6);
    });

    it('整句是省略号的行照旧保留', () => {
        const rows: Row[] = linesToLizi([lyricLine('……', 5, 8), lyricLine('后面', 10, 12)], undefined);

        expect(texts(rows)).toEqual(['……', '后面']);
    });

    it('没有任何间奏行时，dur 仍是到下一句开始', () => {
        const rows: Row[] = linesToLizi([lyricLine('A', 5, 8), lyricLine('B', 10, 14)], undefined);

        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ t: 0, dur: 3 });
        expect(rows[1]).toMatchObject({ t: 10, dur: 4 });
    });
});

describe('lizi linesToLizi: 首句之前的 intro', () => {
    // 这一条不是本 PR 引入的（改之前输入一样），但它是「暂无歌词」的另一半成因：
    // 歌词表 [...... 0.5→7.5][一句 8→11]，intro 占位行丢掉后第一行从 8 秒才开始，0~8 秒里
    // 舞台按 t 找当前行拿到 -1 —— 001 显示「等待第一句…」，505 把 decodeTarget 置空（清屏）。
    // 修法：第一行的 t 钳到 0，内容和 dur 一律不动。
    it('第一行从 0 开始，dur / 内容 / chars 都不动，整条时间轴都有当前行', () => {
        const rows: Row[] = linesToLizi(withInterludes([lyricLine('一句', 8, 11)]), undefined);

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ t: 0, dur: 3, text: '一句' });
        expect(rows[0].chars).not.toBeNull();
        // 修之前 0~8 秒取到的是 -1。
        expect(idxAt(rows, 0)).toBe(0);
        expect(idxAt(rows, 2.5)).toBe(0);
        assertEveryMomentHasLine(rows);
    });

    it('首句本来就在 1 秒：同样提前到 0，dur 不变', () => {
        const rows: Row[] = linesToLizi(withInterludes([lyricLine('一句', 1, 4)]), undefined);

        expect(rows[0]).toMatchObject({ t: 0, dur: 3 });
    });

    it('首句就在 0 秒时不动', () => {
        const rows: Row[] = linesToLizi([lyricLine('一句', 0, 3)], undefined);

        expect(rows[0]).toMatchObject({ t: 0, dur: 3 });
    });
});

// 全曲的时间轴：从 0 到「最后一句 + 它的 dur」。
const assertEveryMomentHasLine = (rows: Row[]) => {
    const last = rows[rows.length - 1];
    const horizon = last ? last.t + Math.max(0, last.dur) : 0;
    for (let time = 0; time <= horizon; time += 0.25) {
        expect(idxAt(rows, time), `t=${time}`).toBeGreaterThanOrEqual(0);
    }
};

describe('lizi linesToLizi: 全曲每个时刻都有当前行', () => {
    const tables: Array<[string, Line[]]> = [
        ['首句前有 intro', withInterludes([lyricLine('一句', 8, 11)])],
        ['句中间奏', withInterludes([lyricLine('第一句', 5, 8), lyricLine('第二句', 20, 23)])],
        ['行级歌词 + 间奏', withInterludes([plainLine('A', 1, 4), plainLine('B', 10, 13)])],
        ['字面 ...... 真歌词', withInterludes([plainLine('......', 1, 3), plainLine('......', 5, 7)])],
        ['尾部间奏', withInterludes([lyricLine('唯一一句', 1, 4)])],
    ];

    for (const [name, lines] of tables) {
        it(name, () => {
            assertEveryMomentHasLine(linesToLizi(lines, undefined));
        });
    }
});
