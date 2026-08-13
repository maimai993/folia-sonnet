import { describe, expect, it } from 'vitest';
import {
    getGridMapQuerySuggestions,
    isGridMapSyntaxQuery,
    matchesGridMapQuery,
    parseGridMapQuery,
} from '../../../src/components/folia-grid/gridMapQuery';

// test/unit/gridView/gridMapQuery.test.ts
// Covers explicit query mode, path semantics, and deterministic GridMap completions.

const items = [
    { id: 'one', name: 'Rock', path: 'Library/Rock', description: 'Folder' },
    { id: 'two', name: 'Live', path: 'Library/Rock/Live', description: 'Concerts' },
    { id: 'three', name: 'Pop', path: 'Other/Pop', description: 'Folder' },
];

describe('gridMapQuery', () => {
    it('uses only a leading colon to enter syntax mode', () => {
        expect(isGridMapSyntaxQuery('/path "Library/Rock"')).toBe(true);
        expect(isGridMapSyntaxQuery('  /under "Library"')).toBe(true);
        expect(isGridMapSyntaxQuery('path')).toBe(false);
        expect(isGridMapSyntaxQuery('rock:path')).toBe(false);
        expect(isGridMapSyntaxQuery('：path "Library/Rock"')).toBe(false);
    });

    it('keeps basic search as a text match', () => {
        const query = parseGridMapQuery('concert');
        expect(matchesGridMapQuery(items[1], query)).toBe(true);
        expect(matchesGridMapQuery(items[0], query)).toBe(false);
    });

    it('distinguishes exact paths from directory subtrees', () => {
        const exact = parseGridMapQuery('/path "Library/Rock"');
        const subtree = parseGridMapQuery('/under "Library/Rock"');

        expect(items.map(item => matchesGridMapQuery(item, exact))).toEqual([true, false, false]);
        expect(items.map(item => matchesGridMapQuery(item, subtree))).toEqual([true, true, false]);
    });

    it('combines path and ordinary text conditions', () => {
        const query = parseGridMapQuery('/under "Library" concerts');
        expect(items.filter(item => matchesGridMapQuery(item, query)).map(item => item.id)).toEqual(['two']);
    });

    it('reports incomplete syntax without applying it', () => {
        expect(parseGridMapQuery('/path').valid).toBe(false);
        expect(parseGridMapQuery('/path "Library').error).toBe('unterminated-quote');
    });

    it('suggests commands and ranked folder paths', () => {
        expect(getGridMapQuerySuggestions('/pa', items)[0]).toMatchObject({
            kind: 'command',
            label: 'path',
            completedQuery: '/path ',
        });
        expect(getGridMapQuerySuggestions('/under "Rock', items).map(item => item.label)).toEqual([
            'Library/Rock',
            'Library/Rock/Live',
        ]);
    });
});
