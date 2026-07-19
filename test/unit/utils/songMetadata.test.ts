import { describe, expect, it } from 'vitest';
import { getSongAlbumCoverUrl } from '../../../src/utils/songMetadata';

// Keeps provider-normalized album covers canonical while accepting persisted legacy songs.

describe('songMetadata', () => {
    it('prefers the unified album cover and falls back for legacy cached songs', () => {
        expect(getSongAlbumCoverUrl({ album: { id: 1, name: 'Album', coverUrl: 'canonical.jpg', picUrl: 'legacy.jpg' } }))
            .toBe('canonical.jpg');
        expect(getSongAlbumCoverUrl({ album: { id: 1, name: 'Album', picUrl: 'legacy.jpg' } }))
            .toBe('legacy.jpg');
    });
});
