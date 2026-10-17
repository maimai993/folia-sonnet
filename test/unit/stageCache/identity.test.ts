import { describe, expect, it } from 'vitest';
import { normalizeStageIdentity } from '@/services/stageCache/identity';
import { md5 } from '@/utils/md5';
import { normalizeStageIdentity as serverIdentity } from '../../../sync-server/src/stageIdentity';

// test/unit/stageCache/identity.test.ts — 完整元数据的格式归一与保守身份边界。
describe('stage identity', () => {
    it('normalizes Unicode, case, whitespace, parentheses and artist order', () => {
        const value = normalizeStageIdentity({ title: ' ＳＯＮＧ （ Live ） ', artists: [' B ', 'Ａ', 'a'] });
        expect(value).toEqual({ title: 'song(live)', artists: ['a', 'b'],
            key: md5(JSON.stringify(['stage-song-v1', 'song(live)', ['a', 'b']])) });
    });
    it('preserves editions and group names without guessing separators', () => {
        const group = normalizeStageIdentity({ title: 'Song', artists: ['A & B'] });
        expect(group?.artists).toEqual(['a & b']);
        expect(group?.key).not.toBe(normalizeStageIdentity({ title: 'Song (live)', artists: ['A & B'] })?.key);
        expect(group?.key).not.toBe(normalizeStageIdentity({ title: 'Song', artists: ['A', 'B'] })?.key);
    });
    it('produces identical identities in the client and server', () => {
        for (const title of [' ＳＯＮＧ （ Live ） ', '伤心的人别听慢歌 (贯彻快乐)', 'ツバメ(feat. ミドリーズ)', 'Ａ  B', 'A\u00a0B']) {
            for (const artists of [[' B ', 'Ａ', 'a'], ['麟', '犀'], ['A & B'], []]) {
                expect(normalizeStageIdentity({ title, artists })).toEqual(serverIdentity({ title, artists }));
            }
        }
    });
    it('rejects missing or partially broken artist metadata', () => {
        for (const artists of [[], [''], ['a', null]]) expect(normalizeStageIdentity({ title: 'Song', artists })).toBeNull();
    });
});
