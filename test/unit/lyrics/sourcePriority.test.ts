import { describe, expect, it } from 'vitest';
import {
    buildLyricSourceOrder,
    DEFAULT_PREFERRED_LYRIC_SOURCE,
    LYRIC_SOURCE_PREFERENCE_ORDER,
    migratePreferredLyricSource,
} from '@/utils/lyrics/sourcePriority';

// test/unit/lyrics/sourcePriority.test.ts

describe('lyric source priority', () => {
    it('defaults to QQ and retains every fallback exactly once', () => {
        expect(buildLyricSourceOrder()).toEqual(['qq', 'netease', 'amll', 'kugou', 'qishui', 'spotify', 'appleMusic']);
        expect(buildLyricSourceOrder('kugou')).toEqual(['kugou', 'netease', 'amll', 'qq', 'qishui', 'spotify', 'appleMusic']);
        expect(buildLyricSourceOrder('netease')).toEqual(['netease', 'amll', 'qq', 'kugou', 'qishui', 'spotify', 'appleMusic']);
        expect(buildLyricSourceOrder('amll')).toEqual(['amll', 'netease', 'qq', 'kugou', 'qishui', 'spotify', 'appleMusic']);
        expect(buildLyricSourceOrder('spotify')).toEqual(['spotify', 'netease', 'amll', 'qq', 'kugou', 'qishui', 'appleMusic']);
        expect(buildLyricSourceOrder('qishui')).toEqual(['qishui', 'netease', 'amll', 'qq', 'kugou', 'spotify', 'appleMusic']);
    });

    // 没改过这项的人（含升级上来的）现在是「跟随播放平台来源」：在线歌按自己所在平台取。
    it('migrates missing, invalid, and legacy NetEase preferences to following the playback source', () => {
        expect(DEFAULT_PREFERRED_LYRIC_SOURCE).toBe('follow-source');
        expect(migratePreferredLyricSource(null, null)).toBe('follow-source');
        expect(migratePreferredLyricSource(null, 'netease')).toBe('follow-source');
        expect(migratePreferredLyricSource(null, 'invalid')).toBe('follow-source');
        expect(migratePreferredLyricSource('invalid', 'kugou')).toBe('follow-source');
    });

    it('preserves other legacy values and trusts the versioned preference thereafter', () => {
        expect(migratePreferredLyricSource(null, 'amll')).toBe('amll');
        expect(migratePreferredLyricSource(null, 'qq')).toBe('qq');
        expect(migratePreferredLyricSource(null, 'kugou')).toBe('kugou');
        expect(migratePreferredLyricSource('netease', 'qq')).toBe('netease');
        expect(migratePreferredLyricSource('follow-source', null)).toBe('follow-source');
    });

    it('offers follow-playback first and every real source exactly once', () => {
        expect(LYRIC_SOURCE_PREFERENCE_ORDER[0]).toBe('follow-source');
        // 具体平台就是 lyricSources 那张表（v0.7.26 起多了 Apple Music）：别再抄一份清单。
        expect([...LYRIC_SOURCE_PREFERENCE_ORDER].sort()).toEqual(
            ['amll', 'appleMusic', 'follow-source', 'kugou', 'netease', 'qq', 'qishui', 'spotify'].sort(),
        );
    });
});
