import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { kineticLyricsSignature, resolveKineticProjectLyrics } from '@/components/visualizer/kinetic/kineticEditorIdentity';

// 直接与实际分发的纯 parseLyrics 函数对照，避免宿主签名自证另一份错误规则。
const engine = fs.readFileSync(new URL('../../../public/jizura/jizura.engine.js', import.meta.url), 'utf8');
const parserSource = engine.slice(engine.indexOf('J.parseLyrics = (raw) => {'), engine.indexOf('/* the order the lyric lines had before v0.10'));
const context = { J: {} as { parseLyrics: (lrc: string) => { lines: Array<{ text: string }> } } };
vm.runInNewContext(parserSource, context);

const fixtures = [
    '[00:01]你好！\n[00:12]再见！！',
    '[00:01]Alpha!!\n[00:12]!\n[00:15]！',
    '[00:01]*Alpha*/first! | note\n[00:12]你/好',
    '[ti:metadata]\n#comment\n[00:01]keep [brackets] inside',
    '[00:12]later\n[00:01]first\nuntagged\n[间奏 8]',
    '[00:01][00:12]repeated\n[00:20][interlude]',
];

describe('kinetic lyrics signature matches the shipped parser', () => {
    it('restores edits only against the exact host source they were made from', () => {
        const saved = { sourceLyrics: '[00:01]Alpha', lyrics: '[00:01]Alpha edited！' };
        expect(resolveKineticProjectLyrics(saved, '[00:01]Alpha')).toBe(saved.lyrics);
        expect(resolveKineticProjectLyrics(saved, '[00:01]Bravo')).toBe('[00:01]Bravo');
        expect(resolveKineticProjectLyrics({ lyrics: 'legacy stale' }, '[00:01]Alpha')).toBe('[00:01]Alpha');
    });
    it.each(fixtures)('preserves parser text identity: %s', lrc => {
        const actual = context.J.parseLyrics(lrc).lines.map(line => line.text).join('').replace(/\s+/g, '');
        expect(kineticLyricsSignature(lrc)).toBe(actual);
    });
});
