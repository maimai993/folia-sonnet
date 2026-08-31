import { describe, expect, it } from 'vitest';
import { applyLyricStaffPolicy, buildLyricStaffPreview } from '@/utils/lyrics/staffCreditsPolicy';
import { parseLyricsByFormat } from '@/utils/lyrics/parserCore';
import type { Line, LyricData } from '@/types';

// test/unit/lyrics/staffCreditsPolicy.test.ts

const parse = (lrc: string) => parseLyricsByFormat('lrc', lrc);
const texts = (lyrics: { lines: { fullText: string }[] } | null) =>
    (lyrics?.lines ?? []).map(line => line.fullText).filter(text => text !== '......');

const DENSE_HEAD = [
    '[00:00.00]作词 : A',
    '[00:00.20]作曲 : B',
    '[00:00.40]编曲 : C',
    '[00:00.60]制作人 : D',
].join('\n');

describe('lyric staff credit policy', () => {
    it('keeps a dense staff block but spreads it across a long intro', () => {
        const lyrics = parse(`${DENSE_HEAD}\n[00:40.00]第一句歌词`);
        const preview = buildLyricStaffPreview(lyrics);

        expect(preview.decision.verdict).toBe('retime');
        expect(preview.decision.blockLineCount).toBe(4);

        const result = applyLyricStaffPolicy(lyrics);
        expect(texts(result)).toEqual(['作词 : A', '作曲 : B', '编曲 : C', '制作人 : D', '第一句歌词']);

        const staffLines = result!.lines.filter(line => line.fullText.includes(' : '));
        const gaps = staffLines.slice(1).map((line, index) => line.startTime - staffLines[index].startTime);
        gaps.forEach(gap => expect(gap).toBeGreaterThanOrEqual(1.5));
    });

    it('leaves an already readable staff block untouched', () => {
        const lyrics = parse('[00:00.00]作词 : A\n[00:05.00]作曲 : B\n[00:10.00]编曲 : C\n[00:40.00]第一句歌词');
        const preview = buildLyricStaffPreview(lyrics);

        expect(preview.decision.verdict).toBe('keep');
        expect(applyLyricStaffPolicy(lyrics)).toEqual(lyrics);
    });

    it('hides the whole block when the intro is only long enough for part of it', () => {
        const lyrics = parse('[00:00.50]作词 : A\n[00:00.70]作曲 : B\n[00:00.90]编曲 : C\n[00:01.10]混音 : D\n[00:05.00]第一句歌词');
        const preview = buildLyricStaffPreview(lyrics);

        expect(preview.decision.verdict).toBe('hide');
        expect(texts(applyLyricStaffPolicy(lyrics))).toEqual(['第一句歌词']);
    });

    it('extends the block past the dictionary through neighbouring credit-shaped lines', () => {
        const lyrics = parse([
            '[00:00.00]作词 Lyricist：A',
            '[00:00.20]作曲 Composer：B',
            '[00:00.40]指挥 Conductor：C',
            '[00:00.60]绞弦琴 Hurdy-Gurdy：D',
            '[00:02.00]第一句歌词',
        ].join('\n'));

        expect(buildLyricStaffPreview(lyrics).decision.blockLineCount).toBe(4);
        expect(texts(applyLyricStaffPolicy(lyrics))).toEqual(['第一句歌词']);
    });

    it('does not stop at long bilingual credit labels', () => {
        const lyrics = parse([
            '[00:00.00]作词 Lyricist：哈尼 Hani / 项柳 Hsiang Liu',
            '[00:00.20]作曲 Composer：菀迪萌 Dimeng Yuan (HOYO-MiX)',
            '[00:00.40]编曲 Arranger：菀迪萌 Dimeng Yuan (HOYO-MiX)',
            '[00:00.60]斯瓦希里语顾问 Swahili Language Consultant：Sarah Mirza',
            '[00:00.80]指挥 Conductor：Robert Ziegler',
            '[00:01.00]乐队 Orchestra：伦敦交响乐团 London Symphony Orchestra',
            '[00:01.20]印第安笛 Native American Flute / 排箫 Pan Flute / 盖那笛 Quena：Genshin Folk Ensemble',
            '[00:03.00]第一句歌词',
        ].join('\n'));

        expect(buildLyricStaffPreview(lyrics).decision.blockLineCount).toBe(7);
        expect(texts(applyLyricStaffPolicy(lyrics))).toEqual(['第一句歌词']);
    });

    it('takes the separator lines between credits with the block', () => {
        const lyrics = parse([
            '[00:00.00]作词 Lyricist：A',
            '[00:00.10]#',
            '[00:00.20]作曲 Composer：B',
            '[00:00.30]#',
            '[00:00.40]指挥 Conductor：C',
            '[00:00.50]#',
            '[00:00.60]乐队 Orchestra：D',
            '[00:00.70]//',
            '[00:02.00]第一句歌词',
        ].join('\n'));

        const preview = buildLyricStaffPreview(lyrics);
        expect(preview.decision.blockLineCount).toBe(4);
        expect(preview.decision.memberIndexes).toHaveLength(8);
        expect(texts(applyLyricStaffPolicy(lyrics))).toEqual(['第一句歌词']);
    });

    it('does not let structural extension swallow a lone colon-shaped lyric line', () => {
        const lyrics = parse('[00:00.00]作词 : A\n[00:00.20]作曲 : B\n[00:01.00]他说：我爱你\n[00:03.00]第一句歌词');

        const preview = buildLyricStaffPreview(lyrics);
        expect(preview.decision.blockLineCount).toBe(2);
        expect(texts(applyLyricStaffPolicy(lyrics))).toEqual(['他说：我爱你', '第一句歌词']);
    });

    it('hides the block when the intro cannot hold even one card', () => {
        const lyrics = parse(`${DENSE_HEAD}\n[00:02.00]第一句歌词`);
        const preview = buildLyricStaffPreview(lyrics);

        expect(preview.decision.verdict).toBe('hide');
        expect(texts(applyLyricStaffPolicy(lyrics))).toEqual(['第一句歌词']);
    });

    it('tolerates a leading title line before the staff block', () => {
        const lyrics = parse(
            '[00:00.00]某首歌 - 某歌手\n[00:01.00]作词 : A\n[00:01.20]作曲 : B\n[00:01.40]编曲 : C\n[00:03.00]第一句歌词'
        );

        expect(buildLyricStaffPreview(lyrics).decision.verdict).toBe('hide');
        expect(texts(applyLyricStaffPolicy(lyrics))).toEqual(['某首歌 - 某歌手', '第一句歌词']);
    });

    it('does not treat a colon-shaped lyric line as a credit block', () => {
        const lyrics = parse('[00:00.00]鼓起勇气：向前走\n[00:00.20]他说：我爱你\n[00:02.00]第一句歌词');

        expect(buildLyricStaffPreview(lyrics).decision.verdict).toBe('none');
        expect(applyLyricStaffPolicy(lyrics)).toEqual(lyrics);
    });

    it('needs at least two credit lines before it touches anything', () => {
        const lyrics = parse('[00:00.00]作词 : A\n[00:02.00]第一句歌词\n[00:06.00]第二句歌词');

        expect(buildLyricStaffPreview(lyrics).decision.verdict).toBe('none');
    });

    it('still matches the common combined and aliased credit formats', () => {
        const lyrics = parse([
            '[00:00.00]词曲：某某',
            '[00:00.20]混音/母带：X',
            '[00:00.40]鼓 Drums：Y',
            '[00:02.00]第一句歌词',
        ].join('\n'));

        expect(buildLyricStaffPreview(lyrics).decision.blockLineCount).toBe(3);
    });

    it('ignores credit-shaped lines that are not at the head', () => {
        const lyrics = parse('[00:01.00]第一句歌词\n[00:02.00]第二句歌词\n[00:03.00]演唱 : A\n[00:04.00]第三句歌词');

        expect(buildLyricStaffPreview(lyrics).decision.verdict).toBe('none');
        expect(applyLyricStaffPolicy(lyrics)).toEqual(lyrics);
    });

    it('retimes every nested timeline, not just the main words', () => {
        const richStaffLine = (text: string, startTime: number, endTime: number): Line => ({
            fullText: text,
            startTime,
            endTime,
            words: [{
                text,
                startTime,
                endTime,
                syllables: [{ text, startTime, endTime, ruby: [{ text: 'ruby', startTime, endTime }] }],
            }],
            alternateTexts: [{ role: 'translation', text: 'translated', syllables: [{ text: 'translated', startTime, endTime }] }],
            backgroundVocals: [{
                text: 'background',
                startTime,
                endTime,
                words: [{ text: 'background', startTime, endTime }],
            }],
        });

        const lyrics: LyricData = {
            lines: [
                richStaffLine('作词 : A', 0, 0.2),
                richStaffLine('作曲 : B', 0.2, 0.4),
                { fullText: '第一句歌词', startTime: 40, endTime: 44, words: [] },
            ],
        };

        expect(buildLyricStaffPreview(lyrics).decision.verdict).toBe('retime');

        const retimed = applyLyricStaffPolicy(lyrics)!.lines.find(line => line.fullText === '作词 : A')!;
        const word = retimed.words[0];
        const syllable = word.syllables![0];

        expect(retimed.startTime).toBe(0);
        expect(retimed.endTime).toBeGreaterThan(1.5);
        expect([word.startTime, syllable.startTime, syllable.ruby![0].startTime]).toEqual([
            retimed.startTime, retimed.startTime, retimed.startTime,
        ]);
        expect([word.endTime, syllable.endTime, syllable.ruby![0].endTime]).toEqual([
            retimed.endTime, retimed.endTime, retimed.endTime,
        ]);
        expect(retimed.alternateTexts![0].syllables![0]).toMatchObject({
            startTime: retimed.startTime,
            endTime: retimed.endTime,
        });
        expect(retimed.backgroundVocals![0]).toMatchObject({
            startTime: retimed.startTime,
            endTime: retimed.endTime,
        });
        expect(retimed.backgroundVocals![0].words[0]).toMatchObject({
            startTime: retimed.startTime,
            endTime: retimed.endTime,
        });
    });

    it('never touches lyrics under the keep policy and always hides under the hide policy', () => {
        const lyrics = parse(`${DENSE_HEAD}\n[00:40.00]第一句歌词`);

        expect(applyLyricStaffPolicy(lyrics, { policy: 'keep' })).toEqual(lyrics);
        expect(texts(applyLyricStaffPolicy(lyrics, { policy: 'hide' }))).toEqual(['第一句歌词']);
    });

    it('honours a custom staff pattern instead of the built-in dictionary', () => {
        const lyrics = parse('[00:00.00]Special Thanks : A\n[00:00.20]Special Thanks : B\n[00:02.00]第一句歌词');

        expect(buildLyricStaffPreview(lyrics).decision.verdict).toBe('none');
        expect(texts(applyLyricStaffPolicy(lyrics, { pattern: '^Special Thanks' }))).toEqual(['第一句歌词']);
    });

    it('respects the minimum dwell setting when sizing the intro budget', () => {
        const lyrics = parse('[00:00.00]作词 : A\n[00:00.20]作曲 : B\n[00:06.00]第一句歌词');

        expect(buildLyricStaffPreview(lyrics, { minDwellSeconds: 1.5 }).decision.verdict).toBe('retime');
        expect(buildLyricStaffPreview(lyrics, { minDwellSeconds: 4 }).decision.verdict).toBe('hide');
    });
});
