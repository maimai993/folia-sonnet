import { describe, expect, it } from 'vitest';
import { getOriginalCoverUrl, getSizedCoverUrl } from '@/utils/coverUrl';

// test/unit/utils/coverUrl.test.ts

describe('coverUrl utilities', () => {
    it('keeps blob cover URLs unchanged', () => {
        const blobUrl = 'blob:http://localhost:3000/1a56d3d0-2d9d-4f99-be5b-93f3dede5938';

        expect(getSizedCoverUrl(blobUrl, 50)).toBe(blobUrl);
    });

    it('adds Netease CDN size parameters', () => {
        expect(getSizedCoverUrl('https://p1.music.126.net/abc/109951.jpg?param=300y300', 50))
            .toBe('https://p1.music.126.net/abc/109951.jpg?param=50y50');
    });

    it('uses exact KuGou CDN sizes for official album cover hosts', () => {
        const imgeCover = 'https://imge.kugou.com/stdmusic/400/20251014/cover.jpg';
        const kgimgCover = 'https://c1.kgimg.com/stdmusic/1024/20251014/cover.jpg';

        expect(getSizedCoverUrl(imgeCover, 120))
            .toBe('https://imge.kugou.com/stdmusic/120/20251014/cover.jpg');
        expect(getSizedCoverUrl(imgeCover, 512))
            .toBe('https://imge.kugou.com/stdmusic/512/20251014/cover.jpg');
        expect(getSizedCoverUrl(kgimgCover, 1024))
            .toBe('https://c1.kgimg.com/stdmusic/1024/20251014/cover.jpg');
    });

    it('does not rewrite KuGou-shaped paths from unrelated hosts', () => {
        const coverUrl = 'https://example.test/stdmusic/400/20251014/cover.jpg';

        expect(getSizedCoverUrl(coverUrl, 1024)).toBe(coverUrl);
    });

    it('uses QQ Music CDN size buckets for album covers', () => {
        const coverUrl = 'https://y.gtimg.cn/music/photo_new/T002R300x300M000album-mid.jpg?max_age=2592000';

        expect(getSizedCoverUrl(coverUrl, 120))
            .toBe('https://y.gtimg.cn/music/photo_new/T002R300x300M000album-mid.jpg?max_age=2592000');
        expect(getSizedCoverUrl(coverUrl, 512))
            .toBe('https://y.gtimg.cn/music/photo_new/T002R800x800M000album-mid.jpg?max_age=2592000');
        expect(getSizedCoverUrl(coverUrl, 1024))
            .toBe('https://y.gtimg.cn/music/photo_new/T002M000album-mid.jpg?max_age=2592000');
    });

    it('restores the canonical QQ Music original without a display-size sentinel', () => {
        expect(getOriginalCoverUrl('https://y.gtimg.cn/music/photo_new/T002R800x800M000album-mid.jpg?max_age=2592000'))
            .toBe('https://y.gtimg.cn/music/photo_new/T002M000album-mid.jpg?max_age=2592000');
    });

    it('uses the original QQ Music singer image for large y.qq.com cover requests', () => {
        expect(getSizedCoverUrl('https://y.qq.com/music/photo_new/T001R150x150M000singer-mid.jpg', 1024))
            .toBe('https://y.qq.com/music/photo_new/T001M000singer-mid.jpg');
    });

    it('derives QQ Music thumbnails from an original cover URL', () => {
        expect(getSizedCoverUrl('https://y.gtimg.cn/music/photo_new/T002M000album-mid.jpg', 512))
            .toBe('https://y.gtimg.cn/music/photo_new/T002R800x800M000album-mid.jpg');
    });

    it('does not rewrite QQ-shaped paths from unrelated hosts', () => {
        const coverUrl = 'https://example.test/music/photo_new/T002R300x300M000album-mid.jpg';

        expect(getSizedCoverUrl(coverUrl, 512)).toBe(coverUrl);
    });

    it('sets Navidrome cover art size parameters', () => {
        expect(getSizedCoverUrl('https://music.test/rest/getCoverArt.view?id=cover-1&v=1', 150))
            .toBe('https://music.test/rest/getCoverArt.view?id=cover-1&v=1&size=150');
    });

    it('uses bounded thumbnail buckets for Electron local covers', () => {
        expect(getSizedCoverUrl(`folia-cover://asset/sha256%3A${'a'.repeat(64)}`, 300))
            .toBe(`folia-cover://asset/sha256%3A${'a'.repeat(64)}?size=512`);
    });

    it('keeps Web local cover thumbnails at least 512px', () => {
        expect(getSizedCoverUrl(`/__folia_cover/sha256%3A${'b'.repeat(64)}`, 50))
            .toBe(`/__folia_cover/sha256%3A${'b'.repeat(64)}?size=512`);
    });
});
