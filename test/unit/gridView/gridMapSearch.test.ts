import { describe, expect, it } from 'vitest';
import { matchesGridMapSearch } from '@/components/folia-grid/gridMapSearch';

// test/unit/gridView/gridMapSearch.test.ts

describe('GridMap basic search', () => {
    const item = {
        name: 'Live',
        path: 'Library/Rock/Live',
        description: 'Concerts',
    };

    it('matches names, metadata, and full folder paths', () => {
        expect(matchesGridMapSearch(item, 'live')).toBe(true);
        expect(matchesGridMapSearch(item, 'concert')).toBe(true);
        expect(matchesGridMapSearch(item, 'library rock')).toBe(true);
        expect(matchesGridMapSearch(item, 'other')).toBe(false);
    });

    it('treats slash text as ordinary basic search', () => {
        expect(matchesGridMapSearch(item, '/path')).toBe(false);
        expect(matchesGridMapSearch({ ...item, path: 'Library/path' }, '/path')).toBe(true);
    });
});
