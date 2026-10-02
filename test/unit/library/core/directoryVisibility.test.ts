import { describe, expect, it } from 'vitest';
import { isHideableDirectoryItem } from '@/library/core/model/directoryVisibility';

// test/unit/library/core/directoryVisibility.test.ts

describe('grid item visibility', () => {
    it.each([
        'playlist',
        'cloud',
        'radio',
        'daily_recommendations',
    ])('allows hiding %s items', type => {
        expect(isHideableDirectoryItem({ type })).toBe(true);
    });

    it.each([
        'album',
        'artist',
        'folder',
        undefined,
    ])('keeps %s items outside playlist hiding', type => {
        expect(isHideableDirectoryItem({ type })).toBe(false);
    });
});

describe('explicit hideable flag', () => {
    it('wins over the type rule in both directions', () => {
        expect(isHideableDirectoryItem({ type: 'album', hideable: true })).toBe(true);
        expect(isHideableDirectoryItem({ type: 'playlist', hideable: false })).toBe(false);
    });
});
