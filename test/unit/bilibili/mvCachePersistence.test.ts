// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/bilibili/mvCachePersistence.test.ts
// 匹配结果落盘：只存「哪条投稿」，直链不落盘；过期的不复活；手动钉的不过期。

const STORAGE_KEY = 'bilibili_mv_resolutions_v1';

const readStore = async () => {
    const mod = await import('@/stores/useBilibiliMvStore');
    return mod;
};

describe('Bilibili MV match cache', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.resetModules();
    });

    it('does not resurrect an expired resolution', async () => {
        const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            'a:1': {
                songKey: 'a:1', state: 'ready', bvid: 'BV1', cid: 7,
                title: 'Old', author: 'UP', durationSec: 200,
                keyword: 'k', manual: false, resolvedAt: old,
            },
        }));
        const { useBilibiliMvStore } = await readStore();
        expect(useBilibiliMvStore.getState().bySongKey['a:1']).toBeUndefined();
    });

    it('keeps a manually pinned resolution past the TTL', async () => {
        const old = Date.now() - 400 * 24 * 60 * 60 * 1000;
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            'b:1': {
                songKey: 'b:1', state: 'ready', bvid: 'BV2', cid: 9,
                title: 'Pinned', author: 'UP', durationSec: 180,
                keyword: 'BV2', manual: true, resolvedAt: old,
            },
        }));
        const { useBilibiliMvStore } = await readStore();
        const hit = useBilibiliMvStore.getState().bySongKey['b:1'];
        expect(hit?.state).toBe('ready');
        expect(hit?.manual).toBe(true);
        // 直链不落盘：重新取地址是调用方的事，恢复出来的这一份只有身份。
        expect(hit?.stream?.bvid).toBe('BV2');
        expect(hit?.stream?.videoUrl).toBe('');
    });

    it('clears both memory and storage', async () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            'c:1': {
                songKey: 'c:1', state: 'ready', bvid: 'BV3', cid: 1,
                title: 'T', author: 'U', durationSec: 1,
                keyword: 'k', manual: true, resolvedAt: Date.now(),
            },
        }));
        const { useBilibiliMvStore } = await readStore();
        expect(useBilibiliMvStore.getState().bySongKey['c:1']).toBeDefined();
        useBilibiliMvStore.getState().clear();
        expect(useBilibiliMvStore.getState().bySongKey['c:1']).toBeUndefined();
        expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({});
    });
});
