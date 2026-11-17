// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/bilibili/mvMediaCacheBinding.test.ts
// MV 音视频缓存的**身份一致性**：绑定对得上才复用，任一项不符就整份作废重拉。
//
// 这是「音画不能各配各的」那条要求落到判据上的地方，所以单独测、测细。

const { shouldCacheAsMv, sameMvIdentity, isMvCacheBindingCurrent } = await import('@/services/bilibili/mvMediaCache');

const identity = (overrides: Partial<{ bvid: string; cid: number; quality: number }> = {}) => ({
    bvid: 'BV1xx',
    cid: 100,
    quality: 720,
    ...overrides,
});

const bindingOf = (overrides: Partial<{
    bvid: string;
    cid: number;
    quality: number;
    songKey: string;
    storedAt: number;
}> = {}) => ({
    bvid: 'BV1xx',
    cid: 100,
    quality: 720,
    songKey: 'song|||artist',
    storedAt: 1_000,
    ...overrides,
});

describe('MV media identity', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.resetModules();
    });

    it('同一条投稿同一档才算同一条 MV', () => {
        expect(sameMvIdentity(identity(), identity())).toBe(true);
    });

    it('换了投稿不算', () => {
        expect(sameMvIdentity(identity(), identity({ bvid: 'BV2yy' }))).toBe(false);
    });

    it('同一投稿的分P（cid 不同）不算', () => {
        expect(sameMvIdentity(identity(), identity({ cid: 101 }))).toBe(false);
    });

    it('换了清晰度不算 —— 那是另一条流', () => {
        expect(sameMvIdentity(identity(), identity({ quality: 1080 }))).toBe(false);
    });

    describe('binding current', () => {
        const now = 10_000;

        it('四样全对且没过期时复用', () => {
            expect(isMvCacheBindingCurrent(bindingOf(), identity(), 'song|||artist', now)).toBe(true);
        });

        it('没有绑定时不复用', () => {
            expect(isMvCacheBindingCurrent(null, identity(), 'song|||artist', now)).toBe(false);
        });

        it('投稿换了就整份作废', () => {
            expect(isMvCacheBindingCurrent(bindingOf(), identity({ bvid: 'BV2yy' }), 'song|||artist', now)).toBe(false);
        });

        it('清晰度换了就整份作废', () => {
            expect(isMvCacheBindingCurrent(bindingOf(), identity({ quality: 480 }), 'song|||artist', now)).toBe(false);
        });

        it('换了歌就整份作废 就算 bvid 撞了', () => {
            expect(isMvCacheBindingCurrent(bindingOf(), identity(), 'another|||artist', now)).toBe(false);
        });

        it('绑定没记歌名时只比身份 不因为缺 songKey 而作废', () => {
            // 老的一条绑定（记歌名之前写的）：身份对上就复用，退化不比歌名。
            expect(isMvCacheBindingCurrent(bindingOf({ songKey: '' }), identity(), 'whatever', now)).toBe(true);
        });

        it('放太久的不用 宁可重新拉一次', () => {
            // 用真实量级的时间戳：now 很小的时候 `now - 40 天` 会变成负数，
            // 而「没记时间戳」（storedAt <= 0）是另一条分支，别让这两个混在一起。
            const realNow = 1_700_000_000_000;
            const old = realNow - 40 * 24 * 60 * 60 * 1000;
            expect(isMvCacheBindingCurrent(bindingOf({ storedAt: old }), identity(), 'song|||artist', realNow)).toBe(false);
        });

        it('没记时间的绑定照旧复用（不因为缺时间戳而作废）', () => {
            expect(isMvCacheBindingCurrent(bindingOf({ storedAt: 0 }), identity(), 'song|||artist', now)).toBe(true);
        });
    });

    describe('admission', () => {
        it('别的平台的歌配 MV 时缓存', () => {
            expect(shouldCacheAsMv(false)).toBe(true);
        });

        it('B 站投稿当歌听时不缓存 —— 那是看一遍就不看的素材', () => {
            expect(shouldCacheAsMv(true)).toBe(false);
        });
    });
});
