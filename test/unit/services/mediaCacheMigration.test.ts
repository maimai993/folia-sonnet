import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/services/mediaCacheMigration.test.ts
// 启动迁移的钉子：旧版本 IndexedDB 缓存**一律删除** —— 搬进私有目录的删（旧 blob 不再回来），
// 写原生失败的也删（它们正是换歌来回切时两路音频重叠的祸根）；非 Blob 的元数据条目不动。

const store = new Map<string, unknown>();
// node 环境没有 localStorage：桩一个内存版，标记的读写都落在它上面。
const flagData = new Map<string, string>();
let nativeWriteOk = true;
let nativeAvailable = true;

vi.stubGlobal('localStorage', {
    getItem: (key: string) => flagData.get(key) ?? null,
    setItem: (key: string, value: string) => {
        flagData.set(key, value);
    },
    removeItem: (key: string) => {
        flagData.delete(key);
    },
    clear: () => flagData.clear(),
});

vi.mock('../../../src/services/db', () => ({
    getCacheKeysByPrefix: vi.fn(async (prefixes: readonly string[]) =>
        [...store.keys()].filter(key => prefixes.some(prefix => key.startsWith(prefix)))),
    getFromCache: vi.fn(async (key: string) => store.get(key)),
    removeFromCache: vi.fn(async (key: string) => {
        store.delete(key);
    }),
}));

vi.mock('../../../src/services/audioCache', () => ({
    cacheLimitBytes: () => 64 * 1024 * 1024,
}));

vi.mock('../../../src/services/mediaCacheStore', () => ({
    hasNativeMediaCache: vi.fn(async () => nativeAvailable),
    writeNativeMediaCache: vi.fn(async () => nativeWriteOk),
}));

import { migrateLegacyMediaCache } from '../../../src/services/mediaCacheMigration';

const blobOf = (bytes: number) => new Blob([new Uint8Array(bytes)]);

describe('启动迁移清掉旧版本媒体缓存', () => {
    beforeEach(() => {
        store.clear();
        nativeWriteOk = true;
        nativeAvailable = true;
        flagData.clear();
    });

    it('搬进私有目录的条目连同 IndexedDB 里的旧 blob 一起删', async () => {
        store.set('audio_song_a', blobOf(10));
        const result = await migrateLegacyMediaCache();
        expect(result.migrated).toBe(1);
        expect(result.dropped).toBe(0);
        expect(store.has('audio_song_a')).toBe(false);
    });

    it('写原生失败的条目也删掉，不留在 IndexedDB 里', async () => {
        nativeWriteOk = false;
        store.set('audio_song_b', blobOf(10));
        const result = await migrateLegacyMediaCache();
        expect(result.migrated).toBe(0);
        expect(result.dropped).toBe(1);
        expect(store.has('audio_song_b')).toBe(false);
    });

    it('非 Blob 的元数据条目（audioLevel 等）不动', async () => {
        store.set('audioLevel_song_c', 'standard');
        const result = await migrateLegacyMediaCache();
        expect(result.total).toBe(0);
        expect(store.has('audioLevel_song_c')).toBe(true);
    });

    it('标记写过之后不再跑；标记升版后旧安装会再清一遍', async () => {
        store.set('audio_song_d', blobOf(10));
        expect((await migrateLegacyMediaCache()).skipped).toBe(false);
        store.set('audio_song_e', blobOf(10));
        // 同一次安装里第二次启动：标记在，直接跳过。
        expect((await migrateLegacyMediaCache()).skipped).toBe(true);
        expect(store.has('audio_song_e')).toBe(true);
        // 老版本写的 v1 标记不算数：新代码用的是 v2，会接着清。
        flagData.set('folia_media_cache_migrated_v1', '1');
        flagData.delete('folia_media_cache_migrated_v2');
        store.set('audio_song_f', blobOf(10));
        expect((await migrateLegacyMediaCache()).skipped).toBe(false);
        expect(store.has('audio_song_f')).toBe(false);
    });

    it('没有原生媒体缓存（非安卓）时整趟跳过，旧缓存不动', async () => {
        nativeAvailable = false;
        store.set('audio_song_g', blobOf(10));
        const result = await migrateLegacyMediaCache();
        expect(result.skipped).toBe(true);
        expect(store.has('audio_song_g')).toBe(true);
    });
});
