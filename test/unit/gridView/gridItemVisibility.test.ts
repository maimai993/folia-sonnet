import { describe, expect, it } from 'vitest';
import { isHideableGridItem } from '@/components/folia-grid/gridItemVisibility';

// test/unit/gridView/gridItemVisibility.test.ts

describe('grid item visibility', () => {
    it.each([
        'playlist',
        'cloud',
        'radio',
        'daily_recommendations',
    ])('allows hiding %s items', type => {
        expect(isHideableGridItem({ type })).toBe(true);
    });

    it.each([
        'album',
        'artist',
        'folder',
        undefined,
    ])('keeps %s items outside playlist hiding', type => {
        expect(isHideableGridItem({ type })).toBe(false);
    });
});
