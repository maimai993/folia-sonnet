import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { appDatabase } from '@/services/appDatabase';
import { putCacheEntry, readCacheEntry, getBrowserCacheUsageByCategory, clearBrowserCacheByCategory } from '@/services/repositories/cacheRepository';

// test/unit/cache/stageCategory.test.ts — 完整视觉缓存可被用户统计与清理，不计作音频歌曲数。
describe('visual stage cache category', () => {
    beforeEach(async () => { await appDatabase.metadata_cache.clear(); await appDatabase.api_cache.clear(); });
    it('routes, counts and clears visual records without counting cached audio', async () => {
        const key = 'stage_song_v1_server_song';
        await putCacheEntry(key, { current: { revision: 'r1', payload: { theme: {}, decision: {} } } });
        expect(await appDatabase.metadata_cache.get(key)).toBeTruthy();
        const usage = await getBrowserCacheUsageByCategory();
        expect(usage.analysis).toBeGreaterThan(0);
        expect(usage.mediaCount).toBe(0);
        await clearBrowserCacheByCategory('analysis');
        expect(await readCacheEntry(key)).toBeNull();
    });
});
