import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENABLE_MEDIA_CACHE_V2_KEY, LEGACY_ENABLE_MEDIA_CACHE_KEY, readStoredEnableMediaCache } from '@/stores/useAudioSettingsStore';

// test/unit/stores/enableMediaCache.test.ts
// 缓存开关这一版（安卓）换了 key、也换了默认：没写过就是**开**。
//
// 为什么换 key 而不是在同一把 key 上翻转默认值：老版本的包还认着旧 key，两版对
// 「用户到底有没有选过」会读出相反的结论（旧版升级上来语义错、回退旧版直接起不来）。
// 所以 `folia_enable_media_cache` / `enable_media_cache` 两把旧 key 都不再读：
// 谁升级到这一版，缓存就是开的，直到他亲手关掉。

describe('stored media cache preference', () => {
    let values: Map<string, string>;

    beforeEach(() => {
        values = new Map();
        const storage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
        };
        vi.stubGlobal('localStorage', storage);
        vi.stubGlobal('window', { localStorage: storage });
    });

    afterEach(() => vi.unstubAllGlobals());

    it('defaults to on when nothing has been stored', () => {
        expect(readStoredEnableMediaCache()).toBe(true);
    });

    it('reads the v2 key', () => {
        localStorage.setItem(ENABLE_MEDIA_CACHE_V2_KEY, 'false');
        expect(readStoredEnableMediaCache()).toBe(false);
        localStorage.setItem(ENABLE_MEDIA_CACHE_V2_KEY, 'true');
        expect(readStoredEnableMediaCache()).toBe(true);
    });

    // 上一代的两把 key 都不再读：它们那版默认关，语义与这一版相反。
    it('leaves both old keys alone', () => {
        localStorage.setItem(LEGACY_ENABLE_MEDIA_CACHE_KEY, 'false');
        localStorage.setItem('folia_enable_media_cache', 'false');

        expect(readStoredEnableMediaCache()).toBe(true);
    });

    it('lets the v2 key win over anything older', () => {
        localStorage.setItem(LEGACY_ENABLE_MEDIA_CACHE_KEY, 'true');
        localStorage.setItem('folia_enable_media_cache', 'true');
        localStorage.setItem(ENABLE_MEDIA_CACHE_V2_KEY, 'false');

        expect(readStoredEnableMediaCache()).toBe(false);
    });

    // 原生外壳（没有 window）也一样：缓存是开的，按需再关。
    it('answers the same with no window at all', () => {
        vi.unstubAllGlobals();
        vi.stubGlobal('window', undefined);

        expect(readStoredEnableMediaCache()).toBe(true);
    });
});
