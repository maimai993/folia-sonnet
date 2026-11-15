import { describe, expect, it } from 'vitest';
import { nextTrackedSongKey, shouldRestoreSongTheme } from '../../../src/hooks/useSongThemeFollow';

// test/unit/hooks/songThemeFollow.test.ts
// 「当前曲目变了才恢复主题」的判据。
//
// 这条判据是「切歌单后主题不换」的解药：以前主题恢复挂在某几条切歌路径上，原生派发的
// 点歌绕过它们。现在只看 songKey —— 不管谁发起切歌，换了就跟着换。
//
// 判松了表现为「主题一直在闪」（每次重渲染都去拉一次），判紧了表现为「切歌不换主题」，
// 两种在真机上都很难看出是这里的问题，所以单独钉住。

describe('shouldRestoreSongTheme', () => {
    it('第一次有曲目时恢复', () => {
        expect(shouldRestoreSongTheme(null, 'netease:1')).toBe(true);
    });

    it('同一首不重复恢复', () => {
        // 商品页、播放页、壁纸每次重渲染都会给一个新的 SongResult 对象，
        // 但 songKey 不变 —— 这时不该再拉一次主题。
        expect(shouldRestoreSongTheme('netease:1', 'netease:1')).toBe(false);
    });

    it('换歌就恢复', () => {
        expect(shouldRestoreSongTheme('netease:1', 'netease:2')).toBe(true);
        expect(shouldRestoreSongTheme('netease:1', 'kugou:1')).toBe(true);
    });

    it('没有当前曲目时不恢复', () => {
        expect(shouldRestoreSongTheme('netease:1', null)).toBe(false);
        expect(shouldRestoreSongTheme(null, null)).toBe(false);
    });
});

describe('nextTrackedSongKey', () => {
    it('有曲目时记住它', () => {
        expect(nextTrackedSongKey('netease:1')).toBe('netease:1');
    });

    it('没有曲目时清空，好让同一首再播时重新恢复主题', () => {
        // 播放停了之后再放同一首，用户可能在这期间改过主题 —— 再用上次的缓存就不对了。
        expect(nextTrackedSongKey(null)).toBeNull();
    });
});
