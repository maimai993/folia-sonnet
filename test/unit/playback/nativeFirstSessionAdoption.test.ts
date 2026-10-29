import { describe, expect, it } from 'vitest';

// test/unit/playback/nativeFirstSessionAdoption.test.ts
// native-first 会话恢复（issue #106）的判据：原生手上真有歌时，恢复认领原生、
// 不碰缓存；原生没歌时照旧走缓存恢复。判据抽成纯函数，hook 侧照它分支。

/**
 * 与 useAppLibraryControllers.adoptNativePlayback 的判定一致：
 *  · 原生快照缺 hasSong / songKey → 不认领（回 false，走缓存恢复）；
 *  · songKey 是原生的真源：队列里没有它（镜像旧了）就排到最前，不丢这首歌。
 *  · 播放状态以原生为准（暂停就是暂停）。
 */
export type NativeAdoptionSnapshot = {
    hasSong: boolean;
    songKey: string;
    index: number;
    playing: boolean;
    positionMs: number;
    durationMs: number;
    entries: Array<{ songKey: string; title: string; providerId: string; songId: string; mid: string; hash: string; albumAudioId: string; coverUrl: string; artist: string; album: string; durationSec: number }>;
};

export type AdoptionDecision = {
    adopted: boolean;
    /** 认领时的当前歌（队列顺序不动）；未认领时为 null。 */
    currentKey: string | null;
    /** 认领时写进 store 的队列 key 序列；未认领时为 null。 */
    queueKeys: string[] | null;
    playing: boolean;
};

export const decideNativeAdoption = (
    native: NativeAdoptionSnapshot | null | undefined,
): AdoptionDecision => {
    if (!native || !native.hasSong || !native.songKey) {
        return { adopted: false, currentKey: null, queueKeys: null, playing: false };
    }
    const keys = native.entries.map((item) => item.songKey);
    // songKey 是原生的真源：队列里没有它（镜像旧了）就排到最前，不丢这首歌。
    const queueKeys = keys.includes(native.songKey) ? keys : [native.songKey, ...keys];
    return { adopted: true, currentKey: native.songKey, queueKeys, playing: native.playing };
};

describe('decideNativeAdoption', () => {
    const snapshot: NativeAdoptionSnapshot = {
        hasSong: true,
        songKey: 'qq:2',
        index: 1,
        playing: false,
        positionMs: 42_000,
        durationMs: 200_000,
        entries: [
            { songKey: 'qq:1', title: 'A', providerId: 'qq', songId: '1', mid: 'm1', hash: '', albumAudioId: '', coverUrl: '', artist: '', album: '', durationSec: 200 },
            { songKey: 'qq:2', title: 'B', providerId: 'qq', songId: '2', mid: 'm2', hash: '', albumAudioId: '', coverUrl: '', artist: '', album: '', durationSec: 200 },
        ],
    };

    it('原生没歌：不认领，走缓存恢复', () => {
        expect(decideNativeAdoption({ ...snapshot, hasSong: false, songKey: '' }).adopted).toBe(false);
        expect(decideNativeAdoption(null).adopted).toBe(false);
    });

    it('原生有歌：认领原生的当前首与队列，播放状态以原生为准（暂停就是暂停）', () => {
        const decision = decideNativeAdoption(snapshot);
        expect(decision.adopted).toBe(true);
        expect(decision.currentKey).toBe('qq:2');
        expect(decision.queueKeys).toEqual(['qq:1', 'qq:2']);
        expect(decision.playing).toBe(false);
    });

    it('镜像与游标脱节（songKey 找不到条目）：songKey 仍是真源，认领它并排在队首', () => {
        const decision = decideNativeAdoption({
            ...snapshot,
            entries: [snapshot.entries[0]],
            index: 0,
        });
        expect(decision.adopted).toBe(true);
        expect(decision.currentKey).toBe('qq:2');
        expect(decision.queueKeys).toEqual(['qq:2', 'qq:1']);
    });

    it('队列里没有 songKey 那条（游标也指不到它）：songKey 是真源，当前首排最前', () => {
        const decision = decideNativeAdoption({
            ...snapshot,
            entries: [snapshot.entries[0]],
            index: -1,
        });
        expect(decision.adopted).toBe(true);
        expect(decision.currentKey).toBe('qq:2');
        expect(decision.queueKeys).toEqual(['qq:2', 'qq:1']);
    });
});
