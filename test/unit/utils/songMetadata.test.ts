import { describe, expect, it } from 'vitest';
import { createProviderSongMetadata, getSongAlbumCoverUrl } from '../../../src/utils/songMetadata';

// Keeps provider-normalized album covers canonical while accepting persisted legacy songs.

describe('songMetadata', () => {
    it('prefers the unified album cover and falls back for legacy cached songs', () => {
        expect(getSongAlbumCoverUrl({ album: { id: 1, name: 'Album', coverUrl: 'canonical.jpg', picUrl: 'legacy.jpg' } }))
            .toBe('canonical.jpg');
        expect(getSongAlbumCoverUrl({ album: { id: 1, name: 'Album', picUrl: 'legacy.jpg' } }))
            .toBe('legacy.jpg');
        expect(getSongAlbumCoverUrl({
            album: { id: 1, name: 'Album' },
            al: { id: 1, name: 'Album', picUrl: 'legacy-al.jpg' },
        })).toBe('legacy-al.jpg');
    });

    it('promotes legacy cover fields into canonical provider metadata', () => {
        const metadata = createProviderSongMetadata({
            id: 1,
            name: 'Song',
            artists: [{ id: 2, name: 'Artist' }],
            album: { id: 3, name: 'Album', picUrl: 'qq.jpg' },
            duration: 1000,
            al: { id: 3, name: 'Album', picUrl: 'netease.jpg' },
        });

        expect(metadata.coverUrl).toBe('qq.jpg');
        expect(metadata.album.coverUrl).toBe('qq.jpg');
    });
});
