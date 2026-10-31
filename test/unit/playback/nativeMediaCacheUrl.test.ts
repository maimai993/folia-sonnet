import { describe, expect, it } from 'vitest';
import { isNativeMediaCacheUrl } from '../../../src/services/playbackRecovery/mediaCacheGuard';

// test/unit/playback/nativeMediaCacheUrl.test.ts
// #157：安卓命中媒体缓存时播放的是回环地址，不是 blob:，失败处理要认得出来。

describe('isNativeMediaCacheUrl', () => {
    it('recognises the loopback media-cache url the native server hands out', () => {
        expect(isNativeMediaCacheUrl('http://127.0.0.1:5199/media-cache/abc123')).toBe(true);
        expect(isNativeMediaCacheUrl('http://127.0.0.1:5199/media-cache/abc123?seek=1')).toBe(true);
        expect(isNativeMediaCacheUrl('http://localhost:5199/media-cache/a-b_c')).toBe(true);
    });

    it('stays out of the other loopback routes the server also serves', () => {
        // 同端口上的另一个路由：远端地址代理，不是缓存副本，不能因此把缓存判成坏的。
        expect(isNativeMediaCacheUrl('http://127.0.0.1:5199/remote-audio/token')).toBe(false);
        expect(isNativeMediaCacheUrl('http://127.0.0.1:5199/')).toBe(false);
    });

    it('does not claim a real cdn url or a local file', () => {
        expect(isNativeMediaCacheUrl('https://cdn.example.com/media-cache/song.mp3')).toBe(false);
        expect(isNativeMediaCacheUrl('blob:http://localhost/uuid')).toBe(false);
        expect(isNativeMediaCacheUrl('file:///storage/emulated/0/Music/a.mp3')).toBe(false);
        expect(isNativeMediaCacheUrl('')).toBe(false);
        expect(isNativeMediaCacheUrl(null)).toBe(false);
        expect(isNativeMediaCacheUrl(undefined)).toBe(false);
    });
});
